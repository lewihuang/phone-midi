# -*- coding: utf-8 -*-
"""生成 MIDI Deck 的程序图标（纯标准库，不需要 Pillow）。

图形：深色底 + 几根竖直通道条（矩形）+ 每根条上一个横向推子帽（矩形）——
用最简单的矩形拼出一个 Mixer 的剪影。小尺寸（16/24/32）会自动减少通道数并把线加粗，
否则缩到任务栏就是一团糊。

用法：
    python tools/make_icon.py                 # 生成 bridge/midi-deck.ico
    python tools/make_icon.py --preview out.png   # 另外导出一张放大预览图（给人看）

图标是 32 位 BGRA（带 alpha），ICO 里每张图 = BITMAPINFOHEADER + 像素 + AND 掩码。
"""
import argparse
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, "bridge", "midi-deck.ico")

# 配色取自程序自己的界面：深底、灰条、近白帽、一点绿（#00E676）作为身份色
BG = (0x0B, 0x0C, 0x0A)          # 与 PC 端 BG 同色
STRIP = (0x6E, 0x77, 0x70)       # 通道条（比 FG 暗一档，别抢帽）
CAP = (0xE9, 0xEE, 0xEA)         # 推子帽
CAP_ACCENT = (0x00, 0xE6, 0x76)  # 一根帽用绿色
EDGE = (0x2A, 0x2B, 0x28)        # 1px 内描边，和小尺寸下的白底区分开

SIZES = (16, 24, 32, 48, 64, 128, 256)


class Canvas:
    """最小的 BGRA 画布：只支持矩形（图标就是几个矩形拼的）。"""

    def __init__(self, size):
        self.s = size
        self.px = [BG + (255,)] * (size * size)

    def rect(self, x0, y0, x1, y1, color, alpha=255):
        x0 = max(0, int(round(x0))); y0 = max(0, int(round(y0)))
        x1 = min(self.s, int(round(x1))); y1 = min(self.s, int(round(y1)))
        for y in range(y0, y1):
            row = y * self.s
            for x in range(x0, x1):
                r, g, b = color
                self.px[row + x] = (b, g, r, alpha)

    def pixels(self):
        """ICO 的 XOR 位图是**自下而上**存的。"""
        out = bytearray()
        for y in range(self.s - 1, -1, -1):
            for x in range(self.s):
                out += bytes(self.px[y * self.s + x])
        return bytes(out)


def draw(size):
    """按尺寸画：≥48 用 4 根通道条，更小的用 3 根（16px 上 4 根会糊）。"""
    c = Canvas(size)
    # 内描边：小尺寸下图标周围常常是浅色任务栏，没这圈会糊在一起
    c.rect(0, 0, size, size, BG)
    c.rect(0, 0, size, 1, EDGE)
    c.rect(0, size - 1, size, size, EDGE)
    c.rect(0, 0, 1, size, EDGE)
    c.rect(size - 1, 0, size, size, EDGE)

    strips = 4 if size >= 48 else 3
    pad = size * 0.16
    usable = size - pad * 2
    slot = usable / strips
    strip_w = max(1.0, slot * 0.30)
    cap_w = slot * 0.74
    cap_h = max(1.0, size * (0.085 if size >= 48 else 0.11))
    top = size * 0.16
    bottom = size * 0.88
    # 每根条上的帽停在不同高度 —— 这就是"Mixer"的全部信息量
    cap_ratio = (0.72, 0.34, 0.58, 0.20) if strips == 4 else (0.72, 0.34, 0.58)
    accent_index = 1

    for i in range(strips):
        cx = pad + slot * (i + 0.5)
        c.rect(cx - strip_w / 2, top, cx + strip_w / 2, bottom, STRIP)
        cy = top + (bottom - top) * cap_ratio[i]
        color = CAP_ACCENT if i == accent_index else CAP
        c.rect(cx - cap_w / 2, cy - cap_h / 2, cx + cap_w / 2, cy + cap_h / 2, color)
    return c


def ico_bytes(size_to_pixels):
    """把若干张 BGRA 位图装进 ICO 容器。"""
    images = []
    for size, pixels in size_to_pixels:
        # AND 掩码：32 位图靠 alpha，掩码全 0（每行按 4 字节对齐）
        mask_row = ((size + 31) // 32) * 4
        mask = b"\x00" * (mask_row * size)
        header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
        images.append((size, header + pixels + mask))

    out = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    offset = 6 + 16 * len(images)
    for size, blob in images:
        dim = 0 if size >= 256 else size          # 256 在 ICO 里记 0
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    for _size, blob in images:
        out += blob
    return bytes(out)


def write_png(path, size, pixels, scale=3):
    """把某一张（放大 scale 倍）导成 PNG，纯粹为了让人肉眼看一眼。"""
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    w = h = size * scale
    raw = bytearray()
    for y in range(h):
        raw.append(0)                              # filter: none
        sy = y // scale
        for x in range(w):
            sx = x // scale
            b, g, r, a = pixels[(sy * size + sx) * 4:(sy * size + sx) * 4 + 4]
            # 透明处按白底混合，跟 GUI 里的观感接近
            raw += bytes(((r * a + 255 * (255 - a)) // 255,
                          (g * a + 255 * (255 - a)) // 255,
                          (b * a + 255 * (255 - a)) // 255))
    data = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(data)
    return w, h


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--preview", help="额外导出一张放大预览 PNG")
    ap.add_argument("--preview-size", type=int, default=128)
    args = ap.parse_args()

    drawn = [(s, draw(s)) for s in SIZES]
    blob = ico_bytes([(s, c.pixels()) for s, c in drawn])
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "wb") as f:
        f.write(blob)
    print("icon  %s  (%d bytes, %d sizes: %s)"
          % (args.out, len(blob), len(SIZES), "/".join(str(s) for s in SIZES)))

    if args.preview:
        size = args.preview_size
        c = dict(drawn)[size] if size in dict(drawn) else draw(size)
        w, h = write_png(args.preview, size, c.pixels(), 3)
        print("preview %s  (%dx%d)" % (args.preview, w, h))


if __name__ == "__main__":
    main()
