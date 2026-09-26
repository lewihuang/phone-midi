"""X/Y Pad（二维控制面）的 Bridge 侧检查。

手机发一条 {kind:'xy', x, y, cc_x, cc_y, channel}，Bridge 必须变成**两条 send_cc**，
且**不进映射引擎**（没有 curve / dead-zone / smoothing 会碰它），并走**推子那个端口**
（独立端口是面板才需要的：它的音符会被 All MIDI Inputs 里的音源轨吃掉）。
设计见 docs/spec/xy-pad.md。
"""
import asyncio, json, os, sys, tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "bridge"))
import server

# 绝不碰真实配置：pad/xy/fader 三个文件都改写到临时目录
tmpdir = tempfile.mkdtemp(prefix="xy-check-")
server.XY_PREFS = Path(tmpdir) / "xy.json"
server.FADER_PREFS = Path(tmpdir) / "fader.json"
server.PAD_PREFS = Path(tmpdir) / "pad.json"

fails, total = [], 0


def check(name, ok, detail=""):
    global total
    total += 1
    print(("PASS  " if ok else "FAIL  ") + name.ljust(46) + detail)
    if not ok:
        fails.append(name)


class FakeMidi:
    def __init__(self):
        self.cc = []
        self.notes = []
        self.pb = []

    def send_cc(self, cc, ch, val):
        self.cc.append((cc, ch, val))

    def send_note(self, note, channel, velocity):
        self.notes.append((note, channel, velocity))

    def send_pitch_bend(self, ch, val):
        self.pb.append((ch, val))


CFG = {"preset_name": "xy-check", "mappings": [{
    "source": {"type": "sensor", "sensor": "rotation_vector", "axis": "fused_lift"},
    "target": {"type": "cc", "cc": 1, "channel": 0},
    "curve": {"type": "linear", "params": {}},
    "range": {"in_min": 0.0, "in_max": 1.0, "out_min": 0, "out_max": 127, "dead_zone": 0.02},
    "smoothing": {"type": "ema", "alpha": 0.15},
}]}


def make_handler(pad_isolated=False):
    fd, path = tempfile.mkstemp(suffix=".json"); os.close(fd)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(CFG, f)
    eng = server.MappingEngine(path)
    midi = FakeMidi()
    pad = FakeMidi() if pad_isolated else None
    return server.SensorHandler(eng, midi, pb_idle_sec=0, pad_midi=pad), eng


def reset_xy_file():
    try:
        server.XY_PREFS.unlink()
    except FileNotFoundError:
        pass


def send(h, **kw):
    msg = {"kind": "xy"}
    msg.update(kw)
    asyncio.run(h._on_xy(msg))


# ── 1. 一条消息 → 两条 CC ────────────────────────────────────────────────────
reset_xy_file()
h, eng = make_handler()
send(h, x=64, y=96, cc_x=20, cc_y=21, channel=0)
check("一条消息发出两条 CC（X 与 Y 各一条，按配置的 CC 号）",
      h.midi.cc == [(20, 0, 64), (21, 0, 96)], f"{h.midi.cc}")
check("通道按消息里的值走",
      (send(h, x=1, y=2, cc_x=20, cc_y=21, channel=5), h.midi.cc[-2:])[1]
      == [(20, 5, 1), (21, 5, 2)],
      f"{h.midi.cc[-2:]}")
check("X/Y **不进映射引擎**：推子的 CC1 一条都没发",
      all(cc != 1 for cc, _ch, _v in h.midi.cc) and eng.config["mappings"][0]["target"]["cc"] == 1,
      f"引擎目标仍是 CC1，实际发出的 CC 号：{sorted({c for c, _, _ in h.midi.cc})}")

# ── 2. 走推子端口，不走面板端口 ──────────────────────────────────────────────
iso, _ = make_handler(pad_isolated=True)
send(iso, x=10, y=20, cc_x=20, cc_y=21, channel=0)
check("X/Y 走**推子**端口（面板端口一个字节都不发）",
      iso.midi.cc == [(20, 0, 10), (21, 0, 20)] and iso.pad_midi.cc == [],
      f"推子端口 {iso.midi.cc}，面板端口 {iso.pad_midi.cc}")

# ── 3. 值的取整与钳制 ────────────────────────────────────────────────────────
reset_xy_file()
h2, _ = make_handler()
send(h2, x=0, y=127, cc_x=20, cc_y=21, channel=0)
check("端点原样通过：0 与 127", h2.midi.cc == [(20, 0, 0), (21, 0, 127)], f"{h2.midi.cc}")
send(h2, x=63.6, y=63.4, cc_x=20, cc_y=21, channel=0)
check("四舍五入（不是截断）", h2.midi.cc[-2:] == [(20, 0, 64), (21, 0, 63)], f"{h2.midi.cc[-2:]}")
send(h2, x=999, y=-5, cc_x=20, cc_y=21, channel=0)
check("越界的值被钳到 0–127，不抛异常", h2.midi.cc[-2:] == [(20, 0, 127), (21, 0, 0)],
      f"{h2.midi.cc[-2:]}")

before = len(h2.midi.cc)
send(h2, x="64", y=None)
send(h2, y=64, x=True)
check("非数值的 x/y 直接忽略，不发送", len(h2.midi.cc) == before, f"{len(h2.midi.cc)} 条（未增加）")

# ── 4. 配置：随消息带、非法值退回、变了才落盘 ────────────────────────────────
reset_xy_file()
h3, _ = make_handler()
check("没有 xy.json 时用默认值（CC20 / CC21 / Ch0）",
      h3.xy_config == {"cc_x": 20, "cc_y": 21, "channel": 0}, f"{h3.xy_config}")
send(h3, x=5, y=5, cc_x=30, cc_y=31, channel=2)
check("消息里的配置立刻生效并落盘",
      h3.xy_config == {"cc_x": 30, "cc_y": 31, "channel": 2}
      and json.load(open(server.XY_PREFS, encoding="utf-8")) == {"cc_x": 30, "cc_y": 31, "channel": 2},
      f"{h3.xy_config}")
h4, _ = make_handler()
check("重启后读回上次的配置", h4.xy_config == {"cc_x": 30, "cc_y": 31, "channel": 2},
      f"{h4.xy_config}")
send(h4, x=5, y=5, cc_x="不合法", cc_y=999, channel=99)
check("非法配置退回**已知的好值**，不会把配置弄脏",
      h4.xy_config == {"cc_x": 30, "cc_y": 31, "channel": 2}, f"{h4.xy_config}")
send(h4, x=7, y=8)                       # 完全不带配置
check("不带配置的消息沿用已知配置",
      h4.midi.cc[-2:] == [(30, 2, 7), (31, 2, 8)], f"{h4.midi.cc[-2:]}")

server.save_xy_config({"cc_x": 5, "cc_y": 300, "channel": -1})
check("落盘前清洗：越界的 CC/通道退回默认",
      server.load_xy_config() == {"cc_x": 5, "cc_y": 21, "channel": 0},
      f"{server.load_xy_config()}")
server.save_xy_config({"cc_x": True, "cc_y": "20", "channel": 1.0})
check("布尔/字符串/浮点都不是合法 CC（bool 是 int 的子类，必须单独挡）",
      server.load_xy_config() == {"cc_x": 20, "cc_y": 21, "channel": 0},
      f"{server.load_xy_config()}")

# ── 5. PC 窗口的当前值行跟着显示 ─────────────────────────────────────────────
send(h4, x=77, y=11, cc_x=30, cc_y=31, channel=2)
check("PC 窗口的当前值行显示 X/Y 发的第一条 CC",
      h4.last_cc_output and h4.last_cc_output[0]["cc"] == 30
      and h4.last_cc_output[0]["value"] == 77
      and h4.last_cc_output[0]["channel"] == 2,
      f"{h4.last_cc_output}")

# ── 6. 推子的目标也记住了（同一类"重启就忘"的毛病） ──────────────────────────
try:
    server.FADER_PREFS.unlink()
except FileNotFoundError:
    pass
check("没有 fader.json 时不动引擎的目标",
      (lambda: (server.apply_remembered_fader_target(eng),
                eng.config["mappings"][0]["target"]["cc"])[1])() == 1,
      "引擎配置里的 CC1 原样保留")


class FakeWs:
    """只关心 _process 的分发与落盘，不需要真 WebSocket。"""
    def __init__(self):
        self.sent = []

    async def send_json(self, payload):
        self.sent.append(payload)


reset_xy_file()
h5, eng5 = make_handler()
ws5 = FakeWs()
# 走真正的入口（字符串 JSON → _process），确认 kind:'xy' 这个分支真的接上了
asyncio.run(h5._process(json.dumps({"kind": "xy", "x": 40, "y": 50,
                                    "cc_x": 22, "cc_y": 23, "channel": 1}), ws5))
check("kind:'xy' 在真正的消息分发里被接上（不是只有单测那个入口能用）",
      h5.midi.cc == [(22, 1, 40), (23, 1, 50)], f"{h5.midi.cc}")

asyncio.run(h5._process(json.dumps({"type": "set_target", "cc": 7, "channel": 3}), ws5))
saved_target = json.load(open(server.FADER_PREFS, encoding="utf-8"))
check("改推子目标会落盘（以前只改内存，重启就忘）",
      saved_target == {"cc": 7, "channel": 3}, f"{saved_target}")
h6, eng6 = make_handler()
server.apply_remembered_fader_target(eng6)
check("重启后引擎沿用上次的 CC/通道",
      eng6.config["mappings"][0]["target"]["cc"] == 7
      and eng6.config["mappings"][0]["target"]["channel"] == 3,
      f"{eng6.config['mappings'][0]['target']}")
server.save_fader_target(None, 4)          # 弯音目标：没有 CC 号，也要记住通道
h7, eng7 = make_handler()
server.apply_remembered_fader_target(eng7)
check("弯音目标（没有 CC 号）也记住通道；cc 保持原样（**弯音与否由消息里的 kind 决定**）",
      eng7.config["mappings"][0]["target"]["channel"] == 4
      and eng7.config["mappings"][0]["target"]["cc"] == 1,
      f"{eng7.config['mappings'][0]['target']}（cc 不动是 update_target(None, …) 的定义）")

print("\n%d/%d checks passed" % (total - len(fails), total))
sys.exit(1 if fails else 0)
