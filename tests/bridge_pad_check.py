"""快捷键面板检查（不需要手机、不需要 DAW、不需要监听端口）。

三块：
  1. 布局清洗与持久化——坏掉的 pad.json 必须退化成可用的默认布局，而不是手机白屏；
  2. 触发 → MIDI Note——编号公式、越界拒绝、按下/松开成对、丢了"松开"时兜底补 Note Off；
  3. 端到端握手——真 aiohttp + 真 WebSocket：连上就收到布局，触发变成 Note，改布局后
     所有已连接的端立刻收到新的布局（这就是"PC 改完即时同步到手机"）。
"""
import asyncio
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bridge"))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import server  # noqa: E402
from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

fails = []
total = 0


def check(name, ok, detail=""):
    global total
    total += 1
    print(("PASS  " if ok else "FAIL  ") + name.ljust(46) + detail)
    if not ok:
        fails.append(name)


# ── 测试用的临时 pad.json：绝不碰真实的 %APPDATA% 配置 ───────────────────────
tmpdir = tempfile.mkdtemp(prefix="pad-check-")
server.PAD_PREFS = __import__("pathlib").Path(tmpdir) / "pad.json"

CFG = {"preset_name": "pad-check", "mappings": [{
    # shaped like the shipped default: the fader's CC1, which must keep using the fader port
    "source": {"type": "sensor", "sensor": "rotation_vector", "axis": "fused_lift"},
    "target": {"type": "cc", "cc": 1, "channel": 0},
    "curve": {"type": "linear", "params": {}},
    "range": {"in_min": 0.0, "in_max": 1.0, "out_min": 0, "out_max": 127, "dead_zone": 0.0},
    "smoothing": {"type": "ema", "alpha": 1.0},
}]}
cfg_path = os.path.join(tmpdir, "cfg.json")
with open(cfg_path, "w", encoding="utf-8") as f:
    json.dump(CFG, f)


class FakeMidi:
    def __init__(self):
        self.notes = []
        self.cc = []

    def send_note(self, note, channel, velocity):
        self.notes.append((note, channel, velocity))

    def send_cc(self, cc, ch, val):
        self.cc.append((cc, ch, val))

    def send_pitch_bend(self, ch, val):
        pass


def handler_with_midi(pad_isolated=False):
    eng = server.MappingEngine(cfg_path)
    midi = FakeMidi()
    pad = FakeMidi() if pad_isolated else None
    return server.SensorHandler(eng, midi, pb_idle_sec=0, pad_midi=pad), eng


# ── 1. 编号公式与越界 ────────────────────────────────────────────────────────
check("编号 0 是 Note 36", server.pad_note_for(0) == 36, f"note={server.pad_note_for(0)}")
check("一页 8 格：第二个页签第一格是 44",
      server.pad_note_for(8) == 44 and server.pad_note_for(7) == 43,
      f"id 7 -> {server.pad_note_for(7)}, id 8 -> {server.pad_note_for(8)}")
check("触发通道是 16（与推子分开）",
      server.PAD_CHANNEL == 15 and server.PAD_SLOTS == 8,
      f"PAD_CHANNEL(0-based)={server.PAD_CHANNEL}, 共 {server.pad_trigger_count()} 个编号")
check("越界/非法编号被拒绝",
      not server.pad_trigger_valid(-1) and server.pad_trigger_valid(0)
      and not server.pad_trigger_valid(server.pad_trigger_count())
      and not server.pad_trigger_valid("x") and not server.pad_trigger_valid(None),
      f"0-{server.pad_trigger_count() - 1} 合法")

# ── 2. 布局清洗：坏输入必须退化成可用布局，而不是白屏 ─────────────────────────
d = server.default_pad_layout()
check("默认布局：1 页 × 8 格，标题与文字成对",
      len(d["pages"]) == 1 and len(d["pages"][0]["cells"]) == 8
      and d["pages"][0]["cells"][0]["text"] == "宏 1",
      f"'{d['pages'][0]['title']}' / {[c['text'] for c in d['pages'][0]['cells']][:3]}…")
check("空/非法的 layout 退化为默认",
      server.pad_clean_layout(None) == d and server.pad_clean_layout({"pages": []}) == d
      and server.pad_clean_layout("nonsense") == d,
      "None / 空 pages / 字符串 都返回默认布局")
padded = server.pad_clean_layout({"pages": [{"title": "轨道颜色", "cells": [{"text": "红"}]}]})
check("格子不足时补满 4×2（手机永远是同一形状）",
      len(padded["pages"][0]["cells"]) == 8 and padded["pages"][0]["cells"][0]["text"] == "红"
      and padded["pages"][0]["cells"][7]["text"] == "",
      f"1 格输入 -> {len(padded['pages'][0]['cells'])} 格")
cleaned = server.pad_clean_layout({"pages": [{"title": "T", "cells": [
    {"text": "x" * 99, "color": "#ff00ff"},          # 超长文字 + 调色板外的颜色
    {"text": "ok", "color": server.PAD_COLORS[3]},
]}]})
check("超长文字被截断、调色板外的颜色被拒",
      len(cleaned["pages"][0]["cells"][0]["text"]) == server.PAD_TEXT_MAX
      and cleaned["pages"][0]["cells"][0]["color"] == server.PAD_COLORS[0]
      and cleaned["pages"][0]["cells"][1]["color"] == server.PAD_COLORS[3],
      f"text {server.PAD_TEXT_MAX} 字上限，颜色 {cleaned['pages'][0]['cells'][1]['color']}")
capped = server.pad_clean_layout({"pages": [{"title": "p%d" % i, "cells": []}
                                            for i in range(server.PAD_PAGES_MAX + 3)]})
check("页数上限生效", len(capped["pages"]) == server.PAD_PAGES_MAX,
      f"{server.PAD_PAGES_MAX} 页上限")

server.save_pad_layout({"pages": [{"title": "持久化", "cells": [{"text": "甲"}]}]})
check("落盘后能读回，且读回时已被清洗",
      server.load_pad_layout()["pages"][0]["title"] == "持久化"
      and len(server.load_pad_layout()["pages"][0]["cells"]) == 8,
      f"{server.PAD_PREFS.name}")

# ── 3. 触发 → MIDI Note ──────────────────────────────────────────────────────
h, _eng = handler_with_midi()
asyncio.run(h._on_trigger({"kind": "trigger", "id": 3, "phase": "down"}))
check("按下发一条 Note On（127）",
      h.midi.notes == [(39, 15, 127)] and h.midi.cc == [],
      f"id 3 -> {h.midi.notes}")
check("PC 窗口的当前值能看到触发",
      h.last_cc_output and h.last_cc_output[0]["cc"] == "N39",
      f"{h.last_cc_output}")
asyncio.run(h._on_trigger({"kind": "trigger", "id": 3, "phase": "up"}))
check("松开发配对的 Note Off（力度 0）",
      h.midi.notes[-1] == (39, 15, 0) and len(h.midi.notes) == 2,
      f"{h.midi.notes}")
asyncio.run(h._on_trigger({"kind": "trigger", "id": 3}))          # 没有 phase
check("没有 phase 时按「按下」处理（宽容旧客户端）",
      h.midi.notes[-1] == (39, 15, 127), f"{h.midi.notes[-1]}")
h.midi.notes.clear()
asyncio.run(h._on_trigger({"kind": "trigger", "id": 9999, "phase": "down"}))
asyncio.run(h._on_trigger({"kind": "trigger", "id": None, "phase": "down"}))
check("越界编号什么都不发", h.midi.notes == [], f"{h.midi.notes}")

# 丢了"松开"：兜底必须在 1 秒左右补一条 Note Off，否则 DAW 里的 Note 一直挂着
guarded, _ = handler_with_midi()
real_guard = server.PAD_HOLD_GUARD_SEC
try:
    server.PAD_HOLD_GUARD_SEC = 0.05

    async def hold_without_release():
        await guarded._on_trigger({"kind": "trigger", "id": 5, "phase": "down"})
        task = asyncio.ensure_future(guarded.pad_watchdog())
        await asyncio.sleep(0.3)          # 远超 50 ms 的兜底窗口
        task.cancel()

    asyncio.run(hold_without_release())
    check("丢了松开事件时兜底补 Note Off",
          guarded.midi.notes == [(41, 15, 127), (41, 15, 0)] and not guarded._pad_held,
          f"{guarded.midi.notes}")
finally:
    server.PAD_HOLD_GUARD_SEC = real_guard

# ── 3b. 面板专用端口：音符绝不能走推子那个端口 ────────────────────────────────
# 真机上暴露的问题：推子的 CC1 靠 All MIDI Inputs 进 DAW，所以那个端口不能从该名单摘掉，
# 而名单里的端口同时喂音源轨（OMNI）——面板的音符会让音源跟着弹音。分开两个端口才两全。
iso, iso_eng = handler_with_midi(pad_isolated=True)
iso.pad_midi.notes = []                     # 断言用：只关心面板端口收到了什么
asyncio.run(iso._on_trigger({"kind": "trigger", "id": 2, "phase": "down"}))
check("独立端口时：音符只出现在面板端口上",
      iso.pad_midi.notes == [(38, 15, 127)] and iso.midi.notes == [],
      f"面板端口 {iso.pad_midi.notes}，推子端口 {iso.midi.notes}")
asyncio.run(iso._on_trigger({"kind": "trigger", "id": 2, "phase": "up"}))
check("独立端口时：松开也只走面板端口",
      iso.pad_midi.notes[-1] == (38, 15, 0) and iso.midi.notes == [],
      f"面板端口 {iso.pad_midi.notes}")
check("独立端口时：pad_midi_isolated 为真（窗口据此显示绿色的端口行）",
      iso.pad_midi_isolated is True and h.pad_midi_isolated is False,
      "isolated=True / shared=False")

iso2, _ = handler_with_midi(pad_isolated=True)
iso_eng.reset()
# 推子那条路必须一点没变：CC 仍然走原来的端口
cc_out = iso_eng.process("rotation_vector", "fused_lift", 0.5)
sent_cc = []
if cc_out:
    out_kind, cc, ch, val, _norm = cc_out[0]
    iso2.midi.send_cc(cc, ch, val)
    sent_cc = [(cc, ch, val)]
check("独立端口时：推子的 CC 仍然走推子端口",
      cc_out and iso2.pad_midi.notes == [] and iso2.midi.cc == sent_cc,
      f"推子端口 {iso2.midi.cc}，面板端口 {iso2.pad_midi.notes}")

# ── 4. 端到端：真 aiohttp + 真 WebSocket ─────────────────────────────────────
async def end_to_end():
    h2, _ = handler_with_midi()
    app = web.Application()
    app.router.add_get("/ws", h2.handle)
    client = TestClient(TestServer(app))
    await client.start_server()
    try:
        ws = await client.ws_connect("/ws")
        first = await ws.receive_json(timeout=2)
        second = await ws.receive_json(timeout=2)
        kinds = sorted([first["type"], second["type"]])
        check("连上就收到 pad_layout（还没发任何消息）",
              kinds == ["config", "pad_layout"] and len(second.get("layout", first).get("pages", [])) >= 1
              if first["type"] == "pad_layout" or second["type"] == "pad_layout" else False,
              f"handshake: {kinds}")

        # 手机按一下 → Bridge 发 Note
        await ws.send_json({"kind": "trigger", "id": 0, "phase": "down"})
        await asyncio.sleep(0.1)
        check("WebSocket 收到的触发变成 Note 36",
              h2.midi.notes == [(36, 15, 127)], f"{h2.midi.notes}")

        # PC 端改布局 → 已连接的手机立刻收到（无需重连、无需刷新）
        changed = server.pad_clean_layout({"pages": [{"title": "轨道颜色",
                                                      "cells": [{"text": "变红"}]}]})
        h2.set_pad_layout(changed)
        await h2.broadcast_pad_layout()
        update = await ws.receive_json(timeout=2)
        check("改布局后手机立刻收到新的 pad_layout",
              update["type"] == "pad_layout"
              and update["layout"]["pages"][0]["title"] == "轨道颜色"
              and update["layout"]["pages"][0]["cells"][0]["text"] == "变红",
              f"title='{update['layout']['pages'][0]['title']}'")

        # 断开时把还按着的触发松开（与弯音归中同一类兜底）：两条还没松开的都该收到 Note Off
        await ws.send_json({"kind": "trigger", "id": 1, "phase": "down"})
        await asyncio.sleep(0.1)
        await ws.close()
        await asyncio.sleep(0.2)
        check("手机断开时把按着的触发全部松开",
              h2.midi.notes[-2:] == [(36, 15, 0), (37, 15, 0)] and not h2._pad_held,
              f"{h2.midi.notes[-2:]}，仍按着 {len(h2._pad_held)} 个")
    finally:
        await client.close()

asyncio.run(end_to_end())

# ── 5. PC 端编辑器窗口（真 Tk，与手机同构的 4×2） ─────────────────────────────
import tkinter as tk  # noqa: E402  (只在窗口测试用得上)

app = server.BridgeApp()
try:
    check("设置页默认「面板与推子共用端口」（保持既有行为）",
          app._pad_selection() is None
          and server.PAD_SAME_PORT in app._pad_port_box.cget("values"),
          f"选择框里有 {len(app._pad_port_box.cget('values'))} 个选项，默认 = 共用")

    app._pad_port_var.set(server.PAD_SAME_PORT)
    check("选「与推子相同」解析为 None（不额外开端口）", app._pad_selection() is None, "None")
    if len(app._pad_port_box.cget("values")) > 1:
        first_port = app._pad_port_box.cget("values")[1]
        app._pad_port_var.set(first_port)
        check("选了具体端口就按端口名传给服务器",
              app._pad_selection() == first_port, f"'{first_port}'")
    app._pad_port_var.set(server.PAD_SAME_PORT)

    app._open_pad_editor()
    app.root.update_idletasks()
    check("编辑器打开后有 8 个格子，编号 N36…N43",
          len(app._pad_cells) == 8
          and [c["note"].cget("text") for c in app._pad_cells]
              == ["N%d" % (36 + i) for i in range(8)],
          " ".join(c["note"].cget("text") for c in app._pad_cells[:4]) + " …")

    app._pad_select(2)
    app._pad_text_var.set("变红")
    app._pad_edit_text()
    app._pad_set_color(server.PAD_COLORS[5])
    app._pad_commit()
    saved = json.load(open(server.PAD_PREFS, encoding="utf-8"))
    cell = app._pad_layout["pages"][0]["cells"][2]
    check("改文字与颜色：模型、格子和 pad.json 三者一致",
          cell["text"] == "变红" and cell["color"] == server.PAD_COLORS[5]
          and app._pad_cells[2]["label"].cget("text") == "变红"
          and saved["pages"][0]["cells"][2]["text"] == "变红",
          f"{cell['text']} / {cell['color']}")

    app._pad_title_var.set("轨道颜色")
    app._pad_edit_title()
    app._pad_commit()
    check("页标题改动同步到模型与页签",
          app._pad_layout["pages"][0]["title"] == "轨道颜色"
          and app._pad_tab_btns[0].cget("text") == "轨道颜色",
          f"tab='{app._pad_tab_btns[0].cget('text')}'")

    app._pad_add_page()
    check("加页：手机侧会多一个页签，且新页编号从 N44 起",
          len(app._pad_layout["pages"]) == 2 and len(app._pad_tab_btns) == 2
          and app._pad_cells[0]["note"].cget("text") == "N44",
          f"{len(app._pad_layout['pages'])} 页，当前页首格 {app._pad_cells[0]['note'].cget('text')}")

    app._pad_del_page()
    check("删页需要点两次（防误删）",
          len(app._pad_layout["pages"]) == 2 and app._pad_confirm_delete is True,
          "第一次点击只提示，不删")
    app._pad_del_page()
    check("第二次点击才真的删掉", len(app._pad_layout["pages"]) == 1,
          f"{len(app._pad_layout['pages'])} 页")

    app._close_pad_editor()
    check("关闭编辑器后不留窗口引用", app._pad_win is None and app._pad_cells == [], "已清理")
finally:
    try:
        app.root.destroy()
    except tk.TclError:
        pass

print(f"\n{total - len(fails)}/{total} checks passed")
sys.exit(1 if fails else 0)
