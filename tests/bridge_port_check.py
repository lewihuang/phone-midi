"""MIDI 端口中断检查（离线：不打开真实端口，不碰 DAW）。

背景（2026-09-30 用户报的问题）：Nuendo 里的 MIDI Remote 设备 `PhoneMIDI`（按名字绑定
loopMIDI 端口 `PhonePad`）会**用着用着显示"断开连接"**，而手机端显示已连接、Bridge 也照常
"有输出"，只能重启 Nuendo 才恢复。

Bridge 这一侧能负责的那一半是：**当端口真的消失时，Bridge 必须自己看得见**。在此之前它只在
START 时打开一次端口，之后假设句柄永远有效——而 `midiOutShortMsg` 在端口没了以后是静默失败的，
于是"Bridge 有输出、DAW 没反应"就成了一种没有任何日志能解释的现象。这一套检查守三件事：

  1. 端口列表变了必须**被看见**（少一个/多一个都要留痕，且只在真的变了时写）；
  2. 自己正拿着的端口没了，必须**按名字重新打开**（下次按下还能到 DAW）；
  3. 体检任务必须真的挂在**正在跑的那个循环**上（`app.on_startup`，与 pad/PB 兜底同一处）。
"""
import asyncio
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bridge"))

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import server  # noqa: E402
from aiohttp import web  # noqa: E402

# 绝不碰用户真实的配置目录：pad.json / xy.json 会被读，写坏了就是真机上的界面错乱
_TMP = Path(tempfile.mkdtemp(prefix="port-check-"))
server.PAD_PREFS = _TMP / "pad.json"
server.XY_PREFS = _TMP / "xy.json"
server.WINDOW_PREFS = _TMP / "window.json"

fails = []
total = 0


def check(name, ok, detail=""):
    global total
    total += 1
    print(("PASS  " if ok else "FAIL  ") + name.ljust(52) + detail)
    if not ok:
        fails.append(name)


class FakeWinMidi(server.WinMidi):
    """只替掉"系统里有哪些端口"与"打开/关闭"（真 winmm 不能碰），重开逻辑走 `WinMidi` 真实现。

    端口表挂在**类**上（`self.__class__.ports`）：真实场景里两个 WinMidi 实例看的是同一个
    系统的同一张表；也正因为挂类上，子类（如 Blink）对 port_names 的重写才会被实例方法
    里的 self.port_names() 运行时查到。
    """

    ports = ["Microsoft GS Wavetable Synth", "FakeFader", "PhonePad"]

    def __init__(self, ports=None):
        # ports 参数 = 这份桩"系统里有哪些端口"（默认每实例一份的类表；传入外部列表则
        # 两个实例共享同一张表，用于双端口回归——见第 6b 条）。
        if ports is not None:
            self.ports = ports
        self._winmm = None
        self._hmo = None
        self._device_id = 0
        self._opened_name = None
        self._prev_ports = None    # 必须建：reopen_if_gone 第一步就读它，删了会 AttributeError
        self.opened = []            # (名字, 下标)，按次记
        self.closed = 0

    def port_names(self):
        return list(self.ports)

    def count_devices(self):
        return len(self.port_names())

    def list_ports(self):
        return list(enumerate(self.port_names()))

    def open(self, device_id=None, name=None):
        if name is not None:
            hit = next(((i, n) for i, n in enumerate(self.ports)
                        if name.lower() in n.lower()), None)
            if hit is None:
                raise server.WinMidiError(f"No device matching '{name}'")
            self._device_id, self._opened_name = hit[0], hit[1]
        else:
            self._device_id = device_id or 0
            self._opened_name = self.ports[self._device_id]
        if self._hmo is not None:
            self.close()
        self._hmo = object()
        self.opened.append((self._opened_name, self._device_id))

    def close(self):
        self._hmo = None
        self.closed += 1


def with_stub(ports=None):
    m = FakeWinMidi()
    if ports:
        m.ports = list(ports)
    return m


# ── 1. 起点：第一次体检只记一笔，不算"变了" ──────────────────────────────────
m = with_stub()
check("第一次体检只记起点，不报'变了'", m.reopen_if_gone() is None and m.closed == 0,
      f"closed={m.closed}")

# ── 2. 列表没变：**什么都不写**（正常运行这份日志必须是安静的） ────────────────
before = m.closed
check("列表没变时什么都不做（正常运行时日志安静）",
      m.reopen_if_gone() is None and m.closed == before, f"closed={m.closed}")

# ── 3. 端口被打不开时不能把体检打死 ─────────────────────────────────────────
class Boom(FakeWinMidi):
    def port_names(self):
        raise OSError("winmm 炸了")

b = Boom()
b.reopen_if_gone()                               # 起点
note = b.reopen_if_gone()
check("量端口列表失败时给出提示而不是抛异常", isinstance(note, str) and "失败" in note, note or "")

# ── 4. 自己那个端口消失 → 重新打开（先消失、后回来，体检发现它不在 → 重开成功） ──
class Blink(FakeWinMidi):
    """体检这一步先"看不见"端口，重开之前又回来了——模拟一次瞬时的枚举抖动。"""

    def __init__(self):
        super().__init__()
        self.first = True

    def port_names(self):
        if self.first:
            self.first = False
            return [n for n in self.ports if n.lower() != "phonepad"]
        return list(self.ports)

m = Blink()
m.open(name="PhonePad")
note = m.reopen_if_gone()
check("端口消失被写进日志（少了谁）",
      isinstance(note, str) and "少了 PhonePad" in note, note or "")
check("消失的端口被按名字重新打开",
      m.opened == [("PhonePad", 2), ("PhonePad", 2)],
      f"打开顺序={m.opened}")

# ── 5. 重新打开失败时不能抛（下一轮体检会再试） ─────────────────────────────
m = with_stub()
m.open(name="PhonePad")
m.ports.remove("PhonePad")
m.reopen_if_gone()                                # 这一轮：不见了 → 重开失败
m.ports.append("PhonePad")                        # 换下标回来
try:
    note = m.reopen_if_gone()
    ok = isinstance(note, str) and "多了 PhonePad" in note
    detail = note or ""
except Exception as e:                              # noqa: BLE001
    ok, detail = False, f"抛了 {e!r}"
check("重开失败不抛，下一轮能认出端口回来了", ok, detail)

# ── 6. 别人的端口插拔导致下标位移：只提示，不重开 ────────────────────────────
# 注意顺序：先体检一次建立基线，再插别的端口——否则 prev=None（起点），"多了谁"不会被
# 当成变化（这正是旧逻辑把"起点时端口已消失"吞掉的同一个坑）。
m = with_stub()
m.open(name="PhonePad")
m.reopen_if_gone()                                 # 基线：当前列表里 PhonePad 在下标 2
m.ports.insert(1, "新插上的键盘")                  # PhonePad 从 2 挪到 3
before = len(m.opened)
note = m.reopen_if_gone()
check("下标位移只提示、不重开（端口本身还在）",
      isinstance(note, str) and "多了 新插上的键盘" in note and len(m.opened) == before,
      f"{note} / opened={m.opened}")

# ── 6b. 双实例共存：两个 WinMidi 看同一张端口表，各自都要能看见自己端口消失 ──
# 2026-10-13 实机 bug：_prev_ports 曾是**类**属性，先跑的推子实例把它刷新后，
# 面板实例读到 now == prev 直接 return —— 持有 PhonePad 的那个实例永远看不见它消失，
# 重开 0 次（实测）。当时这份测试每个用例只建一个实例，所以测不出来。
shared = ["Microsoft GS Wavetable Synth", "loopMIDI Port", "PhonePad"]
fader = FakeWinMidi(ports=shared); fader.open(name="loopMIDI Port")
pad = FakeWinMidi(ports=shared); pad.open(name="PhonePad")
fader.reopen_if_gone(); pad.reopen_if_gone()          # 各自建基线
shared.remove("PhonePad")                              # PhonePad 被删掉（以新身份重建前的瞬间）
fader.reopen_if_gone(); pad.reopen_if_gone()
shared.append("PhonePad")                              # 以新身份回来
fader.reopen_if_gone(); pad.reopen_if_gone()
check("双实例共存：面板实例也能看见自己端口消失并重开",
      pad.opened == [("PhonePad", 2), ("PhonePad", 2)],
      f"pad.opened={pad.opened}（修复前只有初始那一次，没有重开）")

# ── 6c. 同一进程 STOP→START：新实例的第一次体检必须重新记起点 ────────────────
# 旧类级基线跨 handler 存活，第二个 handler 的第一次体检 prev is not None，
# "体检起点"日志被吞（日志实证：15:08:44 那次 START 后没有起点行）。
fresh = FakeWinMidi(ports=shared); fresh.open(name="PhonePad")
check("STOP→START 后新实例重新记起点（不再被旧基线吞掉）",
      fresh._prev_ports is None and fresh.reopen_if_gone() is None
      and fresh._prev_ports == shared,
      f"_prev_ports={fresh._prev_ports}")

# ── 7. 体检任务真的在"正在跑的循环"上（pad / PB 兜底同一处） ─────────────────
async def watchdog_wiring(pb_idle_sec):
    # 真的建一个 handler，让 pad/PB 两条兜底也能活下去（只取任务名的话它们会抛异常，
    # 而"任务抛异常就没了"本身会把这条断言变假）。
    class NullMidi:
        def send_note(self, *a, **k): pass
        def send_cc(self, *a, **k): pass
        def send_pitch_bend(self, *a, **k): pass
        def reopen_if_gone(self): return None

    h = server.SensorHandler.__new__(server.SensorHandler)
    h.midi = h.pad_midi = NullMidi()
    h.pb_idle_sec = pb_idle_sec
    h._pb_last = {}
    h._pb_value = {}
    h._pad_held = {}
    h.last_cc_output = []
    h.pad_layout = server.load_pad_layout()
    h.xy_config = server.load_xy_config()
    app = web.Application()
    server.register_watchdogs(app, h)
    app.freeze()
    await app.startup()
    await asyncio.sleep(0.25)
    running = [t.get_coro().__qualname__ for t in asyncio.all_tasks()
               if t is not asyncio.current_task() and not t.done()]
    for t in asyncio.all_tasks():
        if t is not asyncio.current_task():
            t.cancel()
    await asyncio.sleep(0)
    return running

running = asyncio.run(watchdog_wiring(0.5))
check("端口体检与 pad/PB 兜底一样，挂在 on_startup 上真的在跑",
      any("port_watchdog" in n for n in running)
      and any("pad_watchdog" in n for n in running)
      and any("pb_watchdog" in n for n in running),
      f"运行中的任务：{sorted(n.split('.')[-1] for n in running)}")

running_no_pb = asyncio.run(watchdog_wiring(0))
check("--pb-idle-ms 0 只关 PB 那条：端口体检与 pad 兜底照旧",
      any("port_watchdog" in n for n in running_no_pb)
      and any("pad_watchdog" in n for n in running_no_pb)
      and not any("pb_watchdog" in n for n in running_no_pb),
      f"运行中的任务：{sorted(n.split('.')[-1] for n in running_no_pb)}")

# ── 8. /status 里能看见端口列表（出问题时不必再猜） ──────────────────────────
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

CFG = {"preset_name": "port-check", "mappings": [{
    "source": {"type": "sensor", "sensor": "rotation_vector", "axis": "fused_lift"},
    "target": {"type": "cc", "cc": 1, "channel": 0},
    "curve": {"type": "linear", "params": {}},
    "range": {"in_min": 0.0, "in_max": 1.0, "out_min": 0, "out_max": 127, "dead_zone": 0.0},
    "smoothing": {"type": "ema", "alpha": 1.0},
}]}

async def status_probe():
    import json as _json
    import tempfile
    tmp = tempfile.mkdtemp(prefix="port-check-")
    path = os.path.join(tmp, "cfg.json")
    with open(path, "w", encoding="utf-8") as f:
        _json.dump(CFG, f)
    engine = server.MappingEngine(path)
    h = server.SensorHandler(engine, with_stub())
    app = web.Application()
    app["handler"] = h
    app["engine"] = engine
    app.router.add_get("/status", server.handle_status)
    async with TestClient(TestServer(app)) as client:
        resp = await client.get("/status")
        return await resp.json()

data = asyncio.run(status_probe())
check("/status 里带上了 Bridge 眼里的 MIDI 端口列表",
      "midi_ports" in data and isinstance(data["midi_ports"], list) and data["clients"] == 0,
      f"keys={sorted(data)} ports={data.get('midi_ports')}")

print()
if fails:
    print(f"{len(fails)}/{total} FAILED: " + "; ".join(fails))
    sys.exit(1)
print(f"all {total} checks passed")
