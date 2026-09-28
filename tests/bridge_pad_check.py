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
# 窗口/端口的记忆（window.json）也要一起隔离：它现在会被界面读（上次选的 MIDI 输出与面板端口），
# 不隔离的话测试既会读到你真实的选择、也会把它覆盖掉。
tmpdir = tempfile.mkdtemp(prefix="pad-check-")
server.PAD_PREFS = __import__("pathlib").Path(tmpdir) / "pad.json"
server.WINDOW_PREFS = __import__("pathlib").Path(tmpdir) / "window.json"


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
    {"text": "x" * 99, "color": "#FF00FF"},          # 超长文字 + 大写 hex
    {"text": "ok", "color": "#0a0"},                  # 3 位 hex 也合法
]}]})
check("超长文字被截断；任意合法 hex 都被接受（并规范成小写）",
      len(cleaned["pages"][0]["cells"][0]["text"]) == server.PAD_TEXT_MAX
      and cleaned["pages"][0]["cells"][0]["color"] == "#ff00ff"
      and cleaned["pages"][0]["cells"][1]["color"] == "#0a0",
      f"text {server.PAD_TEXT_MAX} 字上限；#FF00FF -> {cleaned['pages'][0]['cells'][0]['color']}")

bad_colors = server.pad_clean_layout({"pages": [{"cells": [
    {"color": "red"}, {"color": "#12345"}, {"color": "url(x)"},
    {"color": "#fff; background-image: url(http://x)"}, {"color": 123}, {"color": None},
]}]})["pages"][0]["cells"]
check("非法颜色一律退回默认（颜色会进手机的 style，不能放开成任意 CSS）",
      all(c["color"] == server.PAD_COLORS[0] for c in bad_colors[:6]),
      f"6 种非法输入 -> {[c['color'] for c in bad_colors[:6]]}")

# 默认色必须是**和浅灰页面一套的浅色**：默认色先后是深蓝 #1e293b（深色主题时代的遗产，
# 8 格全用它会把整页压成"暗底"）和中灰 #8e8e93（在浅底上仍偏重）。现在是白色。
check("默认色是浅色（和页面一套），不是深色块",
      server.pad_luma(server.PAD_COLORS[0]) > 0.9,
      f"默认 {server.PAD_COLORS[0]} luma={server.pad_luma(server.PAD_COLORS[0]):.2f}")
check("亮度只用于选字色：有界、单调、能吃掉 3 位 hex 与非法值",
      server.pad_luma("#000000") == 0.0 and server.pad_luma("#ffffff") == 1.0
      and server.pad_luma("#000000") < server.pad_luma("#8e8e93") < server.pad_luma("#ffffff")
      and abs(server.pad_luma("#fff") - 1.0) < 1e-9
      and server.pad_luma("nonsense") == server.pad_luma(server.PAD_COLORS[0]),
      "浅底用深字、深底用白字，判断依据就是它")
# 字色（ink）是**派生**的：浅底深字、深底白字。判断留在 Bridge 侧（手机是哑显示端）。
check("字色跟着填充色走：白底深字、深蓝底白字、中间调取白字",
      server.pad_ink_for("#ffffff") == server.PAD_INK_DARK
      and server.pad_ink_for("#1e293b") == server.PAD_INK_LIGHT
      and server.pad_ink_for("#34c759") == server.PAD_INK_LIGHT
      and server.pad_ink_for("bogus") == server.pad_ink_for(server.PAD_COLORS[0]),
      f"白->{server.pad_ink_for('#ffffff')} 深蓝->{server.pad_ink_for('#1e293b')}")
_ink_layout = server.pad_clean_layout({"pages": [{"title": "T", "cells": [
    {"text": "白", "color": "#ffffff", "note": 36},
    {"text": "蓝", "color": "#1e293b", "note": 37},
]}]})
_ink_payload = server.pad_layout_payload(_ink_layout)
check("发给手机的布局带派生字色，而**落盘的那份不带**",
      _ink_payload["pages"][0]["cells"][0]["ink"] == server.PAD_INK_DARK
      and _ink_payload["pages"][0]["cells"][1]["ink"] == server.PAD_INK_LIGHT
      and "ink" not in _ink_layout["pages"][0]["cells"][0]
      and _ink_payload["pages"][0]["cells"][0]["note"] == 36,
      "存起来就会和 color 不同步（改色忘了改字色 = 白字白底），所以只在下发时派生")
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

# ── 2b. 音符：**由位置派生，不接受手改**（D31，2026-09-26 删掉自由输入） ─────────
check("形状是 2 列 × 4 行",
      (server.PAD_COLS, server.PAD_ROWS, server.PAD_SLOTS) == (2, 4, 8),
      f"{server.PAD_COLS} 列 × {server.PAD_ROWS} 行 = {server.PAD_SLOTS} 格")

note_default = server.pad_clean_layout({"pages": [{"cells": []}, {"cells": []}]})
check("音符按位置给：第 1 页 36 起、第 2 页 44 起",
      [c["note"] for c in note_default["pages"][0]["cells"]] == list(range(36, 44))
      and [c["note"] for c in note_default["pages"][1]["cells"]] == list(range(44, 52)),
      f"p1 首格 {note_default['pages'][0]['cells'][0]['note']}，p2 首格 {note_default['pages'][1]['cells'][0]['note']}")

# 用户："删除音符自由输入的功能，仅使用软件提供的默认值" —— 所以配置里存的音符一律被重算，
# 手改过的旧配置（以及越界/非整数/布尔）全都回到 36+编号。
note_kept = server.pad_clean_layout({"pages": [{"cells": [
    {"note": 100}, {"note": 200}, {"note": "x"}, {"note": True}, {"note": -1},
]}]})["pages"][0]["cells"]
check("旧配置里手改过的音符被按位置重算（不再保留 100/200 这些）",
      [c["note"] for c in note_kept[:5]] == [36, 37, 38, 39, 40],
      f"{[c['note'] for c in note_kept[:5]]}")

layout_with_note = server.pad_clean_layout({"pages": [{"cells": [{"note": 50}]}]})
check("查音符也是按位置算；布局缺失/非法时同样退回 36+编号",
      server.pad_note_in_layout(layout_with_note, 0) == 36
      and server.pad_note_in_layout(layout_with_note, 1) == 37
      and server.pad_note_in_layout({"pages": []}, 0) == 36
      and server.pad_note_in_layout(None, 5) == 41,
      "布局里写的 50 不参与；id 5 -> 41")

dupes = server.pad_duplicate_notes(server.pad_clean_layout({"pages": [
    {"cells": [{"note": 60}, {"note": 60}]},
    {"cells": [{"note": 60}]},
]}))
# 音符既然是位置派生的，就**不可能重复**：48 格 = 48 个各不相同的音符，重复提示永远不触发。
total_cells = server.PAD_SLOTS * server.PAD_PAGES
check("音符不可能重复（位置派生 = 48 格 48 个不同音符）",
      sum(dupes.values()) == total_cells and len(dupes) == total_cells
      and all(n == 1 for n in dupes.values()),
      f"共 {sum(dupes.values())} 格 / {len(dupes)} 个不同音符")

swap_layout = server.pad_clean_layout({"pages": [{"cells": [
    {"text": "甲", "color": server.PAD_COLORS[2]},
    {"text": "乙", "color": server.PAD_COLORS[4]},
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

# ── 3c. 触发发的音符 = 36 + 触发编号（位置派生，D31 之后音符不可手改） ─────────
custom, _ = handler_with_midi()
custom.set_pad_layout({"pages": [{"cells": [{"note": 60}, {"note": 61}]}]})
asyncio.run(custom._on_trigger({"kind": "trigger", "id": 0, "phase": "down"}))
check("音符与位置绑定：不管旧配置里写的是什么，第 1 格发 36",
      custom.midi.notes == [(36, 15, 127)], f"{custom.midi.notes}")
asyncio.run(custom._on_trigger({"kind": "trigger", "id": 1, "phase": "down"}))
check("同一页按位置依次 36 / 37", custom.midi.notes[-1] == (37, 15, 127), f"{custom.midi.notes[-1]}")
# 按住期间把两格**交换**（拖动）：松开必须关掉**当初发出去的那一条**，否则 DAW 里会留一个挂着的 Note。
# 音符现在跟着位置走，所以交换之后 0 号格"看起来"该发 37，但松开要关的是 36。
custom.set_pad_layout({"pages": [{"cells": [{"text": "甲"}, {"text": "乙"}]}]})
custom.pad_layout = server.pad_swap_cells(custom.pad_layout, 0, 0, 1)
asyncio.run(custom._on_trigger({"kind": "trigger", "id": 0, "phase": "up"}))
check("按住期间交换了格子，松开仍关掉当初那个音符（不留悬挂）",
      custom.midi.notes[-1] == (36, 15, 0) and 0 not in custom._pad_held,
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

# ── 3d. 同一格被按下两次：真机"宏停不下来"的根因 ─────────────────────────────
# 用户报的现象：偶尔 DAW 里那条 Note 一直亮着、宏/按钮停不下来，手机怎么按都修不掉。
# 链路：手机可能对同一格发两次 down（两根手指压同一格 / 面板页与推子页第 4 页条同时按同一
# 编号 / 丢了"松开"之后 1 秒内重按），而 Bridge 按**触发编号**只记一条 → 2 条 Note On 只配
# 1 条 Note Off，剩下那条再也没人能关（手机端没有"单独发 Off"的路子）。
twice, _ = handler_with_midi()
asyncio.run(twice._on_trigger({"kind": "trigger", "id": 6, "phase": "down"}))
asyncio.run(twice._on_trigger({"kind": "trigger", "id": 6, "phase": "down"}))
check("同一格第二次按下不再发第二条 Note On（一格 = 一个音符）",
      twice.midi.notes == [(42, 15, 127)], f"{twice.midi.notes}")
asyncio.run(twice._on_trigger({"kind": "trigger", "id": 6, "phase": "up"}))
check("第二次按下之后松开：Note On/Off 仍然一对一，没有悬挂",
      twice.midi.notes == [(42, 15, 127), (42, 15, 0)] and not twice._pad_held,
      f"{twice.midi.notes}，仍按着 {len(twice._pad_held)} 个")
asyncio.run(twice._on_trigger({"kind": "trigger", "id": 6, "phase": "up"}))
check("再补一次松开：没有记录的 up 也补一条 Note Off（幂等自愈）",
      twice.midi.notes[-1] == (42, 15, 0), f"{twice.midi.notes[-1]}")

# 旧版本（或上一次运行）留下的悬挂：`_pad_held` 里已经没有它了，兜底遍历不到它。
# 能关掉它的只有两条路——松开时补 Off、以及启动/停止/手动的清场，这条守住前者。
stale, _ = handler_with_midi()
asyncio.run(stale._on_trigger({"kind": "trigger", "id": 7, "phase": "up"}))
check("Bridge 不认识的编号：松开也发一条 Note Off（悬挂的自愈通道）",
      stale.midi.notes == [(43, 15, 0)] and not stale._pad_held, f"{stale.midi.notes}")

# ── 3e. 清场：启动 / 停止 / 手动「全部停」共用这一条路 ────────────────────────
panic, _ = handler_with_midi()
asyncio.run(panic._on_trigger({"kind": "trigger", "id": 0, "phase": "down"}))
asyncio.run(panic._on_trigger({"kind": "trigger", "id": 31, "phase": "down"}))
panic.midi.notes.clear()
cleared = panic.pad_all_off("测试")
check("清场：48 个触发编号全部补 Note Off，按住的记录一并清掉",
      panic.midi.notes == [(36 + i, 15, 0) for i in range(server.pad_trigger_count())]
      and not panic._pad_held and cleared == server.pad_trigger_count(),
      f"{len(panic.midi.notes)} 条 Note Off，仍按着 {len(panic._pad_held)} 个")
check("清场：再补一条 CC123 All Notes Off（只作用在通道 16）",
      panic.midi.cc[-1] == (123, 15, 0), f"最后一条 {panic.midi.cc[-1]}")

# ── 3f. 断开只收回自己那一份（别的页面正按着的键不许被松开） ────────────────────
# 真机上同时开着面板页与推子页（日志里最多 3 个客户端）：以前任何一端断开都会
# `release_all_triggers()`，会把另一台设备正按着的那一格也放掉（"按着按着突然自己松了"）。
multi, _ = handler_with_midi()
client_a, client_b = object(), object()
asyncio.run(multi._on_trigger({"kind": "trigger", "id": 2, "phase": "down"}, client_a))
asyncio.run(multi._on_trigger({"kind": "trigger", "id": 3, "phase": "down"}, client_b))
check("按下时记下是哪个客户端按的",
      multi._pad_held[2][2] is client_a and multi._pad_held[3][2] is client_b,
      f"{ {k: type(v[2]).__name__ for k, v in multi._pad_held.items()} }")
multi.midi.notes.clear()
released = multi.release_triggers_of(client_b)
check("断开的那一端只松开它自己的键，另一端还按着",
      released == 1 and multi.midi.notes == [(39, 15, 0)] and list(multi._pad_held) == [2],
      f"松开 {released} 个，发出 {multi.midi.notes}，仍按着 {sorted(multi._pad_held)}")
multi.release_triggers_of(client_a)
check("剩下那一端断开时才松开它自己那条",
      multi.midi.notes[-1] == (38, 15, 0) and not multi._pad_held,
      f"{multi.midi.notes[-1]}，仍按着 {len(multi._pad_held)} 个")

# ── 3g. 看门狗必须挂在"真正在跑的那个循环"上（CLI 路径曾经完全没兜底） ─────────
# 原来 `_cli_mode` 里直接 `asyncio.ensure_future(handler.pad_watchdog())`：那一刻没有运行中的
# 循环，任务被挂到 `get_event_loop()` 顺手建出来的那个循环上，而 `web.run_app()` 会自己
# `new_event_loop()` → 兜底永远不 tick（真机日志里 51 条 `Task was destroyed but it is pending!
# … pad_watchdog` 全在 CLI 启动后）。现在两个都挂 `app.on_startup`，这里真的驱动一次启动信号。
async def watchdog_wiring(pb_idle_sec):
    h, _ = handler_with_midi()
    h.pb_idle_sec = pb_idle_sec
    app2 = web.Application()
    server.register_watchdogs(app2, h)
    app2.freeze()                              # 冻结信号（AppRunner.setup() 平时会做这件事）
    await app2.startup()                       # 真的触发 on_startup
    await asyncio.sleep(0.25)                  # 让两个任务各跑几轮
    running = [t.get_coro().__qualname__ for t in asyncio.all_tasks()
               if t is not asyncio.current_task()]
    for t in asyncio.all_tasks():
        if t is not asyncio.current_task():
            t.cancel()
    await asyncio.sleep(0)
    return running

with_pb = asyncio.run(watchdog_wiring(0.5))
check("启动了循环之后：pad 兜底与 PB 兜底都在跑（挂在 on_startup 上）",
      any("pad_watchdog" in n for n in with_pb) and any("pb_watchdog" in n for n in with_pb),
      f"运行中的任务：{sorted(n.split('.')[-1] for n in with_pb)}")
without_pb = asyncio.run(watchdog_wiring(0))
check("--pb-idle-ms 0（pb_idle_sec=0）只关掉 PB 那条，**pad 兜底照旧在跑**",
      any("pad_watchdog" in n for n in without_pb)
      and not any("pb_watchdog" in n for n in without_pb),
      f"运行中的任务：{sorted(n.split('.')[-1] for n in without_pb)}")

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
    port_names = list(app._pad_port_box.cget("values"))
    if len(port_names) > 1:
        first_port = port_names[1]
        app._pad_port_var.set(first_port)
        check("选了具体端口就按端口名传给服务器",
              app._pad_selection() == first_port, f"'{first_port}'")
    app._pad_port_var.set(server.PAD_SAME_PORT)

    # 记忆：上次选过的面板端口要在下次打开时自动选回；端口不在了就退回"与推子相同"
    saved_port = port_names[-1] if len(port_names) > 1 else server.PAD_SAME_PORT
    server.save_window_prefs({"pad_port": saved_port, "midi_out": "loopMIDI Port"})
    again = server.BridgeApp()
    try:
        again.root.withdraw()
        check("下次打开自动选回上次的面板端口",
              again._pad_port_var.get() == saved_port, f"'{again._pad_port_var.get()}'")
        server.save_window_prefs({"pad_port": "这个端口不存在了"})
        third = server.BridgeApp()
        try:
            third.root.withdraw()
            check("记忆里的端口不见了就退回「与推子相同」，不会选到一个空项",
                  third._pad_port_var.get() == server.PAD_SAME_PORT
                  and third._pad_selection() is None,
                  f"'{third._pad_port_var.get()}'")
        finally:
            try: third.root.destroy()
            except Exception: pass
    finally:
        try: again.root.destroy()
        except Exception: pass
    server.save_window_prefs({})

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

    # 音符**不可手改**（D31）：编辑器里没有那个输入框，格子标签显示的 N 号由位置派生；
    # 就算硬塞一个 note 进模型，落盘时也会被按位置重算。
    app._pad_select(1)
    check("编辑器里没有音符输入框（音符不再自由输入）",
          not hasattr(app, "_pad_note_entry") and not hasattr(app, "_pad_note_var"),
          "音符 / 输入框都不在")
    check("格子右下角的 N 号是位置派生的（第 2 格 = N37）",
          app._pad_cells[1]["note"].cget("text") == "N37",
          app._pad_cells[1]["note"].cget("text"))
    app._pad_layout["pages"][0]["cells"][1]["note"] = 77      # 手改模型（模拟旧配置/外来的值）
    app._pad_commit()
    saved_note = json.load(open(server.PAD_PREFS, encoding="utf-8"))
    check("手塞进去的音符落盘时被按位置重算回 37",
          saved_note["pages"][0]["cells"][1]["note"] == 37,
          f"pad.json 里现在是 {saved_note['pages'][0]['cells'][1]['note']}")

    # 任意颜色：手输 hex 与预设色块走同一条路（D20）
    app._pad_color_var.set("#12ab34")
    app._pad_edit_color()
    app._pad_commit()
    saved_color = json.load(open(server.PAD_PREFS, encoding="utf-8"))
    check("手输任意 hex：模型 / pad.json 一致",
          app._pad_layout["pages"][0]["cells"][1]["color"] == "#12ab34"
          and saved_color["pages"][0]["cells"][1]["color"] == "#12ab34",
          app._pad_layout["pages"][0]["cells"][1]["color"])
    app._pad_color_var.set("不是颜色")
    app._pad_edit_color()
    check("非法颜色被拒绝并提示，不写进模型",
          app._pad_layout["pages"][0]["cells"][1]["color"] == "#12ab34"
          and "#rrggbb" in app._pad_status_lbl.cget("text"),
          f"提示：{app._pad_status_lbl.cget('text')}")
    app._pad_color_var.set("#12ab34")

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
    check("松手即交换：文字与颜色整体落到目标格，选中跟着按钮走；**音符留在位置上**",
          cells_now[2]["text"] == text_before and cells_now[2]["note"] == 36 + 2
          and app._pad_sel == 2,
          f"0 号格 '{text_before}' -> 第 3 格 '{cells_now[2]['text']}'/N{cells_now[2]['note']}"
          f"（音符按位置算 = N38，所以拖动换位不需要在 DAW 里重学）；选中={app._pad_sel}")

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

    # ── 「全部停」按钮：面板 Note 悬挂的手动出口（2026-09-28） ──────────────────
    # 放在最后做：`_build_running()` 会把设置界面的控件全部清掉，前面那些断言用的是它们。
    app._handler = None
    app._build_running("Fake MIDI", 8765, "https")
    app.root.update_idletasks()
    check("运行界面里有「全部停」，与「快捷键面板…」并排（不占额外高度）",
          app._panic_btn.cget("text") == "全部停" and app._panic_btn.master is app._pad_btn.master,
          f"{app._pad_btn.cget('text')} / {app._panic_btn.cget('text')}")

    class _FakePanic:
        def __init__(self): self.reasons = []

        def pad_all_off(self, reason=""):
            self.reasons.append(reason); return server.pad_trigger_count()

    app._handler = _FakePanic()
    app._panic_btn.invoke()                      # 真的点一下，不是直接调方法
    check('点「全部停」= 调 handler.pad_all_off("手动") 并回显条数',
          app._handler.reasons == ["手动"] and "48" in app._panic_btn.cget("text"),
          f"reason={app._handler.reasons}，按钮文字「{app._panic_btn.cget('text')}」")
    app._handler = None
    app._on_panic()                              # 没启动：不能让窗口抛错
    check("未启动时点「全部停」：只提示「未启动」",
          app._panic_btn.cget("text") == "未启动", f"按钮文字「{app._panic_btn.cget('text')}」")

    app._close_pad_editor()
    check("关闭编辑器后不留窗口引用", app._pad_win is None and app._pad_cells == [], "已清理")
finally:
    try:
        app.root.destroy()
    except tk.TclError:
        pass

print(f"\n{total - len(fails)}/{total} checks passed")
sys.exit(1 if fails else 0)
