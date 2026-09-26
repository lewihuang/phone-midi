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


def reset_pad_file():
    """布局是**跨块共享**的持久状态（pad.json）：每个块开始前复位成默认，断言才有确定性。"""
    server.save_pad_layout({"pages": []})          # 空布局 → 清洗成默认（音符 36+）

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
check("默认布局：固定 6 页 × 8 格，每页有标题、每格有默认音符",
      len(d["pages"]) == server.PAD_PAGES == 6
      and all(len(p["cells"]) == server.PAD_SLOTS for p in d["pages"])
      and d["pages"][0]["title"] == "页 1"
      and d["pages"][5]["cells"][0]["note"] == 76,
      f"{len(d['pages'])} 页，第 6 页首格音符 {d['pages'][5]['cells'][0]['note']}")
check("空/非法的 layout 退化为默认",
      server.pad_clean_layout(None) == d and server.pad_clean_layout({"pages": []}) == d
      and server.pad_clean_layout("nonsense") == d,
      "None / 空 pages / 字符串 都返回默认布局")
padded = server.pad_clean_layout({"pages": [{"title": "轨道颜色", "cells": [{"text": "红"}]}]})
check("页数固定：1 页的旧配置补齐到 6 页，格子也补满（手机永远同一套结构）",
      len(padded["pages"]) == 6
      and len(padded["pages"][0]["cells"]) == 8 and padded["pages"][0]["cells"][0]["text"] == "红"
      and padded["pages"][0]["cells"][7]["text"] == ""
      and padded["pages"][0]["title"] == "轨道颜色" and padded["pages"][5]["title"] == "页 6",
      f"1 页 × 1 格输入 -> {len(padded['pages'])} 页 × {len(padded['pages'][0]['cells'])} 格")
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
                                            for i in range(server.PAD_PAGES + 3)]})
check("页数固定：多出来的页被丢掉（不增不删，永远 6 页）",
      len(capped["pages"]) == server.PAD_PAGES
      and capped["pages"][0]["title"] == "p0" and capped["pages"][5]["title"] == "p5",
      f"给了 {server.PAD_PAGES + 3} 页，留下 {len(capped['pages'])} 页")

server.save_pad_layout({"pages": [{"title": "持久化", "cells": [{"text": "甲"}]}]})
check("落盘后能读回，且读回时已被清洗（页数补齐、格子补满）",
      server.load_pad_layout()["pages"][0]["title"] == "持久化"
      and len(server.load_pad_layout()["pages"]) == 6
      and len(server.load_pad_layout()["pages"][0]["cells"]) == 8,
      f"{server.PAD_PREFS.name}")

# ── 2b. 音符：默认值、可改、与格子位置解绑（T2） ───────────────────────────────
check("形状是 2 列 × 4 行",
      (server.PAD_COLS, server.PAD_ROWS, server.PAD_SLOTS) == (2, 4, 8),
      f"{server.PAD_COLS} 列 × {server.PAD_ROWS} 行 = {server.PAD_SLOTS} 格")

note_default = server.pad_clean_layout({"pages": [{"cells": []}, {"cells": []}]})
check("缺 note 时按位置补默认值：第 1 页 36 起、第 2 页 44 起",
      [c["note"] for c in note_default["pages"][0]["cells"]] == list(range(36, 44))
      and [c["note"] for c in note_default["pages"][1]["cells"]] == list(range(44, 52)),
      f"p1 首格 {note_default['pages'][0]['cells'][0]['note']}，p2 首格 {note_default['pages'][1]['cells'][0]['note']}")

note_kept = server.pad_clean_layout({"pages": [{"cells": [
    {"note": 100}, {"note": 200}, {"note": "x"}, {"note": True}, {"note": -1},
]}]})["pages"][0]["cells"]
check("自己设的音符被保留，越界/非整数/布尔一律退回默认",
      [c["note"] for c in note_kept[:5]] == [100, 37, 38, 39, 40],
      f"{[c['note'] for c in note_kept[:5]]}")

layout_with_note = server.pad_clean_layout({"pages": [{"cells": [{"note": 50}]}]})
check("按布局查音符；查不到或用例非法时退回 36+编号",
      server.pad_note_in_layout(layout_with_note, 0) == 50
      and server.pad_note_in_layout(layout_with_note, 1) == 37
      and server.pad_note_in_layout({"pages": []}, 0) == 36,
      "id 0 -> 50（布局里写的），id 1 -> 37（默认）")

dupes = server.pad_duplicate_notes(server.pad_clean_layout({"pages": [
    {"cells": [{"note": 60}, {"note": 60}]},
    {"cells": [{"note": 60}]},
]}))
# 断言性质，不手算具体默认值：总数 = 6 页 × 8 格；出现过重复；不同音符数少于总格数。
total_cells = server.PAD_SLOTS * server.PAD_PAGES
check("重复音符能被数出来（跨页也算，编辑器据此提示）",
      dupes.get(60) >= 3 and sum(dupes.values()) == total_cells and len(dupes) < total_cells,
      f"60 至少出现 {dupes.get(60)} 次；共 {sum(dupes.values())} 格 / {len(dupes)} 个不同音符")

swap_layout = server.pad_clean_layout({"pages": [{"cells": [
    {"text": "甲", "color": server.PAD_COLORS[2], "note": 99},
    {"text": "乙", "color": server.PAD_COLORS[4], "note": 12},
]}]})
before = [dict(c) for c in swap_layout["pages"][0]["cells"][:2]]
moved = server.pad_swap_cells(swap_layout, 0, 0, 1)
after = swap_layout["pages"][0]["cells"][:2]
check("交换两格：整格内容（文字+颜色+音符）一起走，一个字段都不丢",
      moved and after[0] == before[1] and after[1] == before[0]
      and set(after[0]) == {"text", "color", "note"},
      f"0 号格现在是 {after[0]['text']}/N{after[0]['note']}")
check("交换的边界：同格/越界/没有这一页都不动",
      not server.pad_swap_cells(swap_layout, 0, 1, 1)
      and not server.pad_swap_cells(swap_layout, 0, 0, 99)
      and not server.pad_swap_cells(swap_layout, 9, 0, 1),
      "返回 False 且布局不变")

# ── 3. 触发 → MIDI Note ──────────────────────────────────────────────────────
reset_pad_file()
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

# ── 3c. 触发发的音符来自布局（T2 解绑之后的行为） ──────────────────────────────
custom, _ = handler_with_midi()
custom.set_pad_layout({"pages": [{"cells": [{"note": 60}, {"note": 61}]}]})
asyncio.run(custom._on_trigger({"kind": "trigger", "id": 0, "phase": "down"}))
check("按布局发音符：第 1 格改成 60 就发 60（不再是 36）",
      custom.midi.notes == [(60, 15, 127)], f"{custom.midi.notes}")
asyncio.run(custom._on_trigger({"kind": "trigger", "id": 1, "phase": "down"}))
check("同一页每一格用自己的音符", custom.midi.notes[-1] == (61, 15, 127), f"{custom.midi.notes[-1]}")
# 按住期间把这一格的编号改掉：松开必须关掉**当初发出去的那一条**，否则 DAW 里会留一个挂着的 Note
custom.set_pad_layout({"pages": [{"cells": [{"note": 70}, {"note": 61}]}]})
asyncio.run(custom._on_trigger({"kind": "trigger", "id": 0, "phase": "up"}))
check("按住期间改了编号，松开仍关掉当初那个音符（不留悬挂）",
      custom.midi.notes[-1] == (60, 15, 0) and 0 not in custom._pad_held,
      f"最后一条 {custom.midi.notes[-1]}，0 号仍按着：{0 in custom._pad_held}")
custom.release_all_triggers()
asyncio.run(custom._on_trigger({"kind": "trigger", "id": 1, "phase": "up"}))

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
    reset_pad_file()
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

reset_pad_file()
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
          and "轨道颜色" in app._pad_tab_btns[0].cget("text"),
          f"tab='{app._pad_tab_btns[0].cget('text')}'")

    # 形状：逐格核对行列，确保和手机是同一套 2 列 × 4 行、行优先
    shape = {slot: (int(w["frame"].grid_info()["row"]), int(w["frame"].grid_info()["column"]))
             for slot, w in enumerate(app._pad_cells)}
    check("编辑器是 2 列 × 4 行，且行优先（与手机同构）",
          shape == {0: (0, 0), 1: (0, 1), 2: (1, 0), 3: (1, 1),
                    4: (2, 0), 5: (2, 1), 6: (3, 0), 7: (3, 1)},
          f"{shape}")

    # 音符可编辑：模型 / 格子标签 / pad.json 三处一致
    app._pad_select(1)
    app._pad_note_var.set("77")
    app._pad_edit_note()
    app._pad_commit()
    saved_note = json.load(open(server.PAD_PREFS, encoding="utf-8"))
    check("改音符：模型 / 格子标签 / pad.json 三处一致",
          app._pad_layout["pages"][0]["cells"][1]["note"] == 77
          and app._pad_cells[1]["note"].cget("text") == "N77"
          and saved_note["pages"][0]["cells"][1]["note"] == 77,
          f"{app._pad_cells[1]['note'].cget('text')}")
    app._pad_note_var.set("999")
    app._pad_edit_note()
    check("非法音符被拒绝、给出提示，且不写进模型",
          app._pad_layout["pages"][0]["cells"][1]["note"] == 77
          and "0–127" in app._pad_status_lbl.cget("text"),
          f"提示：{app._pad_status_lbl.cget('text')}")
    app._pad_note_var.set("77")

    # 拖动换位：把 winfo_containing 换成确定性桩，避免依赖真实命中测试
    class _Ev:
        x_root = 0
        y_root = 0
    app._pad_win.winfo_containing = lambda _x, _y: app._pad_cells[2]["label"]
    text_before = app._pad_layout["pages"][0]["cells"][0]["text"]
    note_before = app._pad_layout["pages"][0]["cells"][0]["note"]
    app._pad_drag_start(0)
    app._pad_drag_motion(_Ev())
    check("拖动经过某格时落点被记录（界面上高亮它）", app._pad_drop_slot == 2,
          f"落点 slot={app._pad_drop_slot}")
    app._pad_drag_end(_Ev())
    cells_now = app._pad_layout["pages"][0]["cells"]
    check("松手即交换：源格的按钮整体落到目标格，选中跟着按钮走",
          cells_now[2]["text"] == text_before and cells_now[2]["note"] == note_before
          and app._pad_sel == 2,
          f"0 号格的 '{text_before}'/N{note_before} 现在在第 3 格")

    # 页数固定 6 页（D18）：编辑器给出 6 个页签，且不存在加页/删页的方法
    check("编辑器固定 6 页：6 个页签、没有加页/删页的入口",
          len(app._pad_layout["pages"]) == server.PAD_PAGES == 6
          and len(app._pad_tab_btns) == 6
          and not hasattr(app, "_pad_add_page") and not hasattr(app, "_pad_del_page"),
          f"{len(app._pad_layout['pages'])} 页 / {len(app._pad_tab_btns)} 个页签")
    app._pad_goto(5)
    check("切到第 6 页：标题与格子标签跟着换（该页默认音符从 76 起）",
          app._pad_page == 5
          and app._pad_layout["pages"][5]["cells"][0]["note"] == 76
          and app._pad_cells[0]["note"].cget("text") == "N76",
          f"第 6 页首格 {app._pad_cells[0]['note'].cget('text')}")
    app._pad_goto(0)

    app._close_pad_editor()
    check("关闭编辑器后不留窗口引用", app._pad_win is None and app._pad_cells == [], "已清理")
finally:
    try:
        app.root.destroy()
    except tk.TclError:
        pass

print(f"\n{total - len(fails)}/{total} checks passed")
sys.exit(1 if fails else 0)
