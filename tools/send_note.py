#!/usr/bin/env python3
"""发一条 MIDI Note —— 快捷键面板的"最小替身"，用来验证 Nuendo 侧的映射。

为什么需要它：整条链路里唯一**无法离线验证**的一环是"Nuendo 能不能把一条 MIDI Note
变成某个宏真的执行"。手机端、Bridge、协议都能用测试证明，只有这一步必须落到 DAW 上。
这个脚本用 30 秒把这一步验证掉——不依赖手机、不依赖 Bridge、不需要打包。

它按 `bridge/server.py` 的同一套约定工作：按名字**子串**匹配端口（大小写不敏感），
发的是标准 MIDI short message（与 Bridge 的 send_cc 同一个位布局）。

用法:
  python tools/send_note.py --list                     # 列出所有 MIDI 输出端口
  python tools/send_note.py                            # 默认 loop* 端口，Note 36，通道 16
  python tools/send_note.py --note 40 --port "loopMIDI Port 2"
  python tools/send_note.py --repeat 3                 # 连发 3 次（每次 On/Off）

快捷键面板将使用：通道 16、音符 36 + 触发编号，按下发 Note On、抬起发 Note Off。
"""

import argparse
import ctypes
import sys
import time
from ctypes import wintypes

if sys.platform != 'win32':
    sys.exit('这个脚本走 Windows winmm，只能在 Windows 上跑')

winmm = ctypes.windll.winmm

NOTE_ON = 0x90
NOTE_OFF = 0x80


class MIDIOUTCAPSW(ctypes.Structure):
    _fields_ = [
        ("wMid", wintypes.WORD), ("wPid", wintypes.WORD),
        ("vDriverVersion", wintypes.UINT), ("szPname", wintypes.WCHAR * 32),
        ("wTechnology", wintypes.WORD), ("wVoices", wintypes.WORD),
        ("wNotes", wintypes.WORD), ("wChannelMask", wintypes.WORD),
        ("dwSupport", wintypes.DWORD),
    ]


def list_ports() -> list[tuple[int, str]]:
    ports = []
    for i in range(winmm.midiOutGetNumDevs()):
        caps = MIDIOUTCAPSW()
        if winmm.midiOutGetDevCapsW(i, ctypes.byref(caps), ctypes.sizeof(caps)) == 0:
            ports.append((i, caps.szPname))
    return ports


def open_port(name: str | None, device_id: int | None):
    """Ports by name substring, like the Bridge: exact id wins, else substring, else fail."""
    ports = list_ports()
    if not ports:
        raise SystemExit('系统里没有任何 MIDI 输出端口（loopMIDI 装了吗？）')
    if device_id is not None:
        if device_id >= len(ports):
            raise SystemExit(f'设备 {device_id} 超出范围（共 {len(ports)} 个）')
        return device_id, dict(ports)[device_id]
    if name is None:
        name = 'loop'
    for i, n in ports:
        if name.lower() in n.lower():
            return i, n
    raise SystemExit(
        f'没有名字含 "{name}" 的 MIDI 输出端口。现有端口：\n'
        + '\n'.join(f'  [{i}] {n}' for i, n in ports))


def send(handle, status: int, d1: int, d2: int):
    """Standard short message: status | data1<<8 | data2<<16 (same layout as server.py)."""
    dw = (d2 << 16) | (d1 << 8) | status
    winmm.midiOutShortMsg(handle, wintypes.DWORD(dw))


def main():
    ap = argparse.ArgumentParser(description='发一条 MIDI Note，验证 DAW 侧映射')
    ap.add_argument('--list', action='store_true', help='列出所有 MIDI 输出端口后退出')
    ap.add_argument('--port', default=None, help='端口名（子串匹配，默认 "loop"）')
    ap.add_argument('--device-id', type=int, default=None, help='直接按索引选端口')
    ap.add_argument('--note', type=int, default=36, help='音符编号（默认 36 = 触发编号 0）')
    ap.add_argument('--channel', type=int, default=16, help='MIDI 通道 1-16（默认 16）')
    ap.add_argument('--velocity', type=int, default=127, help='力度 0-127')
    ap.add_argument('--hold', type=float, default=0.15, help='Note On 与 Off 之间的秒数')
    ap.add_argument('--repeat', type=int, default=1, help='连发几次')
    args = ap.parse_args()

    if args.list:
        for i, n in list_ports():
            print(f'  [{i}] {n}')
        return

    if not 1 <= args.channel <= 16:
        raise SystemExit('--channel 必须是 1-16')
    if not 0 <= args.note <= 127:
        raise SystemExit('--note 必须是 0-127')
    ch = (args.channel - 1) & 0x0F

    dev_id, dev_name = open_port(args.port, args.device_id)
    hmo = wintypes.HANDLE()
    r = winmm.midiOutOpen(ctypes.byref(hmo), wintypes.UINT(dev_id), None, None, 0)
    if r != 0:
        raise SystemExit(f'midiOutOpen(device={dev_id}) 失败：{r}（该端口是否被别的程序独占？）')

    try:
        print(f'端口：[{dev_id}] {dev_name}')
        print(f'发送：Note {args.note}、通道 {args.channel}、力度 {args.velocity}'
              f'（= 快捷键面板的触发编号 {args.note - 36}）')
        for i in range(args.repeat):
            send(hmo, NOTE_ON | ch, args.note, args.velocity)
            time.sleep(args.hold)
            send(hmo, NOTE_OFF | ch, args.note, 0)
            print(f'  {i + 1}/{args.repeat} Note On + Note Off 已发出')
            if i + 1 < args.repeat:
                time.sleep(0.25)
    finally:
        winmm.midiOutClose(hmo)

    print('完成。如果 Nuendo 里那个宏没有执行，检查：')
    print('  1) 这个端口名 = Nuendo 的 MIDI Remote 设备所选的输入端口吗？')
    print('  2) 映射助手里学到的消息确实是 Note（不是 CC/Bend）？')
    print('  3) 通道过滤：设备的 MIDI 输入是否只收某个通道？我们发的是通道 16。')


if __name__ == '__main__':
    main()
