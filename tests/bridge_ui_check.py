"""精简模式（compact mode）检查，不弹窗。

只覆盖用户要求的三件事：
  1. 精简模式只保留 当前值 + 进度条（外加一个返回展开态的按钮）
  2. 精简模式置顶（否则会被 DAW 盖住）
  3. 精简模式可拉伸，下限 420×150；展开态窗口尺寸保持原样（480×420，不置顶）

以及启动失败（端口被占用）时窗口必须报错，而不是假装在运行——那是"手机连上了但 PC
没有 client"的真正原因。
"""
import os, re, sys, time, tempfile, tkinter as tk
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bridge"))
import server

# 窗口/端口的记忆写到 %APPDATA%，**测试必须改写到一个临时文件**：否则每跑一次测试
# 就会把用户真实的窗口尺寸、位置、上次选的端口覆盖掉（这事真发生过）。
_tmpdir = tempfile.mkdtemp(prefix="ui-check-")
server.WINDOW_PREFS = Path(_tmpdir) / "window.json"

fails = []
total = 0
def check(name, ok, detail=""):
    global total
    total += 1
    print(("PASS  " if ok else "FAIL  ") + name.ljust(44) + detail)
    if not ok:
        fails.append(name)

def _ex_bits(window) -> int:
    """窗口顶层 HWND 的扩展样式位（读不到时返回 0，断言会因此失败而不是崩）。"""
    import ctypes
    from ctypes import wintypes
    h = server._root_hwnd(window)
    if not h:
        return 0
    u32 = ctypes.windll.user32
    get_long = getattr(u32, "GetWindowLongPtrW", None) or u32.GetWindowLongW
    get_long.argtypes = [wintypes.HWND, ctypes.c_int]
    get_long.restype = ctypes.c_ssize_t
    return int(get_long(wintypes.HWND(h), server._GWL_EXSTYLE)) & 0xFFFFFFFF

# ── value / bar maths (no window needed) ─────────────────────────────────────
pb_out = [{"cc": "PB", "channel": 0, "value": 8809}]
cc_out = [{"cc": 1, "channel": 0, "value": 64}]
check("值：弯音显示为 PB 计数", server.BridgeApp._value_text(pb_out, True) == "PB 8809",
      server.BridgeApp._value_text(pb_out, True))
check("值：CC 显示为 CC 号 + 值", server.BridgeApp._value_text(cc_out, True) == "CC1 64",
      server.BridgeApp._value_text(cc_out, True))
check("值：没连接时不显示陈旧值", server.BridgeApp._value_text(cc_out, False) == "—", "—")
# 面板触发往 last_cc_output 里写的是 "N39"（音符号）：拼成 "CCN39 127" 很难看，
# 而且进度条会谎报一条满格——音符没有"位置"可言。
note_out = [{"cc": "N39", "channel": server.PAD_CHANNEL, "value": 127}]
check("值：面板音符显示为 Note N39（不是 CCN39）",
      server.BridgeApp._value_text(note_out, True) == "Note N39",
      server.BridgeApp._value_text(note_out, True))
check("进度条：面板音符留空，不乱报满格",
      server.BridgeApp._bar_norm(note_out) == (None, "cc"),
      f"{server.BridgeApp._bar_norm(note_out)}")
norm_pb, kind_pb = server.BridgeApp._bar_norm(pb_out)
norm_cc, kind_cc = server.BridgeApp._bar_norm(cc_out)
check("进度条：弯音从中线两侧长", kind_pb == "pb" and abs(norm_pb - 8809 / 16383) < 1e-9,
      f"norm={norm_pb:.4f} kind={kind_pb}")
check("进度条：CC 从左往右长", kind_cc == "cc" and abs(norm_cc - 64 / 127) < 1e-9,
      f"norm={norm_cc:.4f} kind={kind_cc}")

# ── window ───────────────────────────────────────────────────────────────────
try:
    app = server.BridgeApp()
except Exception as e:
    print(f"SKIP  GUI 检查                          无法创建窗口：{e}")
    sys.exit(0)

class FakeHandler:
    def __init__(self):
        self.last_cc_output = cc_out
        self.client_count = 1

try:
    app.root.withdraw()

    # ── START / STOP 不能卡住窗口（用户报的"未响应好几秒"） ──────────────────
    # 界面线程只负责派发与轮询；真正的启动/停止在工作线程里做。
    if app._port_ids:
        test_port = 8796
        t0 = time.perf_counter()
        app._start_server(app._port_ids[0], "测试端口", test_port)
        dispatch = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter(); ready = None
        while time.perf_counter() - t0 < 10:
            app.root.update()
            if app._busy is None: ready = (time.perf_counter() - t0) * 1000; break
            time.sleep(0.01)
        check("START 不阻塞界面（派发 < 200 ms、就绪 < 2 s）",
              dispatch < 200 and ready is not None and ready < 2000,
              f"派发 {dispatch:.0f} ms，就绪 {ready if ready is None else round(ready)} ms")
        check("START 真的起来了", app._mode == "running" and app._handler is not None,
              f"mode={app._mode} handler={app._handler is not None}")

        t0 = time.perf_counter()
        app._on_stop()
        dispatch_s = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter(); stopped = None
        while time.perf_counter() - t0 < 10:
            app.root.update()
            if app._busy is None: stopped = (time.perf_counter() - t0) * 1000; break
            time.sleep(0.01)
        check("STOP 不阻塞界面（派发 < 200 ms、完成 < 2 s）",
              dispatch_s < 200 and stopped is not None and stopped < 2000,
              f"派发 {dispatch_s:.0f} ms，完成 {stopped if stopped is None else round(stopped)} ms")
        try:
            again = server.bind_server_socket("0.0.0.0", test_port)
            again.close()
            freed = True
        except OSError as e:
            freed = False
            print(f"      端口未释放：{e}")
        check("STOP 之后端口立即可再绑定", freed, f"port {test_port}")

    app._handler = FakeHandler()

    # 展开态 = 原版窗口，尺寸不变、不置顶
    app._build_running("loopMIDI", 8765, "https")
    app.root.update_idletasks()
    check("展开态保持原样（480x420，不置顶）",
          app.root.geometry().startswith("480x420") and not app.root.attributes("-topmost"),
          f"{app.root.geometry()} topmost={app.root.attributes('-topmost')}")
    check("展开态保留原有控件",
          all(hasattr(app, n) for n in ("_status_midi", "_status_clients", "_status_cc", "_dot"))
          and not hasattr(app, "_mon_value"),
          "status_midi/clients/cc/dot 在，精简控件不在")

    # 精简态 = 只有值 + 进度条，置顶，可拉伸，下限 420x150
    app._toggle_compact()
    app.root.update_idletasks()
    app._poll_status()
    check("精简态只保留 值 + 进度条",
          hasattr(app, "_mon_value") and hasattr(app, "_bar")
          and not hasattr(app, "_status_cc"),
          "只有 _mon_value / _bar，没有 status 卡片")
    check("精简态置顶", bool(app.root.attributes("-topmost")), f"topmost={app.root.attributes('-topmost')}")
    check("精简态无标题栏", bool(app.root.overrideredirect()),
          f"overrideredirect={app.root.overrideredirect()}")
    # 去掉标题栏会让 Windows 给窗口挂上 WS_EX_TOOLWINDOW，而工具窗口按设计不进任务栏
    # ⇒ 用户切到精简模式后，系统里就再也看不出「MIDI Deck 在跑」了。这里断言样式确实被改回
    # 「应用窗口」：任务栏按钮（以及 Alt+Tab 里的一项）由这一个位决定。
    _tb = server.taskbar_presence(app.root)
    check("精简态仍在任务栏（看得出在运行）", _tb is True,
          f"taskbar_presence={_tb}（None=本平台无法判定）")
    check("精简态默认 420x108（细长条）",
          app._win_size == (server.COMPACT_MIN_W, server.COMPACT_DEF_H),
          f"requested={app._win_size}")
    check("进度条是固定细条，不随窗口撑高",
          app._bar.winfo_reqheight() == server.COMPACT_BAR_H == 26,
          f"bar requested height={app._bar.winfo_reqheight()} px")
    # 展开态留下的 minsize(400,340) 曾把精简态高度顶到 340（真机上量到 630x510）：
    # 下限必须跟着模式走，否则请求的高度会被悄悄改掉。
    check("精简态下限也跟着变成 420x84",
          app.root.minsize() == (server.COMPACT_MIN_W, server.COMPACT_MIN_H),
          f"min={app.root.minsize()}")
    check("精简态显示当前 CC 值", app._mon_value.cget("text") == "CC1 64",
          app._mon_value.cget("text"))

    # 无标题栏 ⇒ 拖动与拉伸必须自己实现，而且下限要守住
    class _Ev:
        def __init__(self, x, y): self.x_root, self.y_root = x, y
    def _pos(g):
        m = re.search(r"\+(-?\d+)\+(-?\d+)$", g)
        return (int(m.group(1)), int(m.group(2))) if m else (None, None)
    before = _pos(app.root.geometry())
    app._drag_start(_Ev(1000, 1000)); app._drag_move(_Ev(1040, 1030))
    check("精简态可拖动", _pos(app.root.geometry()) == (before[0] + 40, before[1] + 30),
          f"{before} -> {_pos(app.root.geometry())}")
    app._resize_start(_Ev(1000, 1000)); app._resize_move(_Ev(1300, 1250))
    check("精简态可拉伸", app._win_size[0] > server.COMPACT_MIN_W and app._win_size[1] > server.COMPACT_MIN_H, f"{app._win_size}")
    app._resize_start(_Ev(1000, 1000)); app._resize_move(_Ev(500, 500))
    check("精简态拉伸下限是 420x84", app._win_size == (server.COMPACT_MIN_W, server.COMPACT_MIN_H), f"{app._win_size}")

    norm, kind = app._bar_args
    check("精简态进度条按 CC 值填充", kind == "cc" and norm == 64 / 127, f"norm={norm:.4f}")

    # 弯音时用中线的进度条
    app._handler.last_cc_output = pb_out
    app._poll_status()
    check("精简态弯音值走中线进度条",
          app._bar_args[1] == "pb" and app._mon_value.cget("text") == "PB 8809",
          f"{app._mon_value.cget('text')} kind={app._bar_args[1]}")

    # 返回展开态后，窗口恢复原样（标题栏回来、不置顶、尺寸原样）
    app._toggle_compact()
    app.root.update_idletasks()
    check("返回展开态后恢复原尺寸、标题栏、不置顶",
          app._win_size == (480, 420) and not app.root.attributes("-topmost")
          and not app.root.overrideredirect() and app.root.minsize() == (400, 340),
          f"requested={app._win_size} min={app.root.minsize()} overrideredirect={app.root.overrideredirect()}")
    check("返回展开态后任务栏样式摘干净（不留精简态的痕迹）",
          _ex_bits(app.root) & (server._WS_EX_APPWINDOW | server._WS_EX_TOOLWINDOW) == 0,
          f"exstyle={_ex_bits(app.root):#010x}（APPWINDOW/TOOLWINDOW 都不该有）")

    # ── 窗口几何与端口记忆 ─────────────────────────────────────────────────
    # 契约在 2026-09-26 变了（spec D30）：用户要求"记住用户上一次调整的软件 ui 大小及位置"，
    # 所以**两个窗口都记**尺寸与位置（旧契约是"标准窗固定 480×420 且不记忆位置"）。
    GOOD_PREFS = {"compact": [520, 140], "compact_pos": [1234, 567],
                  "standard": [640, 500], "standard_pos": [200, 120],
                  "midi_out": "PhonePad", "pad_port": "loopMIDI 2", "junk": "x"}
    server.save_window_prefs(GOOD_PREFS)
    got = server.load_window_prefs()
    check("几何记录：尺寸/位置/端口都能读回、脏字段被忽略",
          got.get("compact") == [520, 140] and got.get("compact_pos") == [1234, 567]
          and got.get("standard") == [640, 500] and got.get("standard_pos") == [200, 120]
          and got.get("midi_out") == "PhonePad" and got.get("pad_port") == "loopMIDI 2"
          and "junk" not in got, f"{got}")
    check("端口记录：空串/非字符串/坏几何一律不认（设备没了就得退回默认）",
          (lambda: (server.save_window_prefs({"midi_out": "  ", "pad_port": 7,
                                              "standard": [1, 2, 3]}),
                    server.load_window_prefs() == {},
                    server.save_window_prefs(GOOD_PREFS))[1])(),
          "空串与坏类型都被 load_window_prefs 丢掉（断言完把好数据写回去）")
    check("几何记录：超出屏幕会被钳制",
          app._fit([99999, 99999], 420, 84).split("x")[0] == str(app.root.winfo_screenwidth()),
          f"{app._fit([99999, 99999], 420, 84)}（屏幕 {app.root.winfo_screenwidth()}）")
    check("几何记录：低于下限会被抬高", app._fit([10, 10], 420, 84) == "420x84",
          app._fit([10, 10], 420, 84))

    sw, sh = app.root.winfo_screenwidth(), app.root.winfo_screenheight()
    app._compact = False
    app._standard_geom = None
    app._built_compact = None       # 模拟"刚启动、还没画过任何视图"：这时必须用盘里的记忆值
    app._win_prefs = server.load_window_prefs()
    app._build_running("loopMIDI", 8765, "https")
    app.root.update_idletasks()
    check("标准窗：沿用上次的尺寸与位置（D30 起不再固定居中）",
          app._win_size == (640, 500) and app._win_pos == (200, 120),
          f"{app._win_size} at {app._win_pos}")

    app._win_prefs = {}                     # 没有任何记录时（= 第一次运行）
    app._standard_geom = None
    app._built_compact = None
    app._build_running("loopMIDI", 8765, "https")
    app.root.update_idletasks()
    check("标准窗：第一次打开仍是 480x420 + 居中",
          app._win_size == (480, 420) and app._win_pos == ((sw - 480) // 2, (sh - 420) // 2),
          f"{app._win_size} at {app._win_pos}")

    app._compact = True
    app._compact_geom = None
    app._built_compact = None
    app._win_prefs = server.load_window_prefs()
    app._build_running("loopMIDI", 8765, "https")
    app.root.update_idletasks()
    check("精简窗：尺寸与位置都沿用记录值",
          app._win_size == (520, 140) and app._win_pos == (1234, 567),
          f"{app._win_size} at {app._win_pos}")

    # 关闭时抓取并落盘（窗口未映射时 geometry() 给的就是"请求值"，所以直接用 _set_geometry 摆好）
    app._win_prefs = {}
    app._set_geometry("550x130+800+200")
    app._capture_window()
    check("退出时抓取当前窗口的尺寸与位置并落盘",
          server.load_window_prefs().get("compact") == [550, 130]
          and server.load_window_prefs().get("compact_pos") == [800, 200],
          f"{server.load_window_prefs()}")

    app._win_prefs = {}
    app._compact = True
    app._compact_geom = None
    app._built_compact = True                    # 现在显示的是精简窗
    app._set_geometry("500x120+321+654")
    app._capture_window()
    app._compact = False
    app._built_compact = False                   # 现在显示的是标准窗
    app._set_geometry("620x480+60+40")
    app._mode = "running"
    app._capture_window()
    check("两个窗口各记各的：退出时精简窗的旧记录留着，标准窗也写上",
          server.load_window_prefs().get("compact") == [500, 120]
          and server.load_window_prefs().get("compact_pos") == [321, 654]
          and server.load_window_prefs().get("standard") == [620, 480]
          and server.load_window_prefs().get("standard_pos") == [60, 40],
          f"{server.load_window_prefs()}")

    app._win_prefs = {}
    app._built_compact = False
    app._set_geometry("480x420+10+20")
    app._mode = "setup"
    app._capture_window()
    check("在设置页退出也记标准窗（下次打开回到这里）",
          server.load_window_prefs().get("standard") == [480, 420]
          and server.load_window_prefs().get("standard_pos") == [10, 20],
          f"{server.load_window_prefs()}")

    # 启动失败必须可见
    app._show_error(server.port_in_use_msg(8765))
    app.root.update_idletasks()
    texts = [w.cget("text") for w in app.root.winfo_children() if isinstance(w, tk.Label)]
    check("端口被占用时窗口显示错误而不是运行中",
          app._mode == "setup" and any("启动失败" in t for t in texts),
          next((t for t in texts if t.startswith("启动失败")), "no error label"))
    # 用户 2026-10-15：文案不该猜是谁占了端口（本机 8765 实际是被绿联 NAS 占的，跟 MIDI Deck 无关）
    _msg = server.port_in_use_msg(8765)
    check("端口占用文案只说事实与建议，不归因于另一个 MIDI Deck",
          "已被占用" in _msg and "换一个端口" in _msg
          and "MIDI Deck" not in _msg and "Bridge" not in _msg,
          _msg)

    # ── 监听端口要记住（用户 2026-10-15：改成 38765 后每次都被打回 8765）─────────
    server.save_window_prefs({"port": 38765})
    check("端口记录：合法的监听端口能读回", server.load_window_prefs().get("port") == 38765,
          f"{server.load_window_prefs()}")
    server.save_window_prefs({"port": "38765"})
    check("端口记录：字符串形式不认（必须是真整数）",
          "port" not in server.load_window_prefs(), f"{server.load_window_prefs()}")
    server.save_window_prefs({"port": 70000})
    check("端口记录：超出范围不认（>65535）",
          "port" not in server.load_window_prefs(), f"{server.load_window_prefs()}")
    server.save_window_prefs({"port": 80})
    check("端口记录：特权端口不认（<1024）",
          "port" not in server.load_window_prefs(), f"{server.load_window_prefs()}")
    server.save_window_prefs({"port": True})
    check("端口记录：bool 不算整数（True 是 int 的子类，得单独挡）",
          "port" not in server.load_window_prefs(), f"{server.load_window_prefs()}")

    # 设置页应该把记住的端口填进输入框，而不是永远 8765
    server.save_window_prefs({"port": 38765, "midi_out": "PhonePad"})
    app._win_prefs = server.load_window_prefs()
    app._compact = False
    app._build_setup()
    app.root.update_idletasks()
    check("设置页：端口输入框填的是上次记住的端口（不是 8765）",
          app._port_var.get() == "38765", f"_port_var={app._port_var.get()!r}")

    # 手滑输入非法值时不能崩，且要退回记住的值
    app._port_var.set("abc")
    check("端口输入非法时退回记住的值（不抛异常）", app._port_from_var() == 38765,
          f"-> {app._port_from_var()}")
    app._port_var.set("99999")
    check("端口超范围时退回记住的值", app._port_from_var() == 38765,
          f"-> {app._port_from_var()}")
    app._port_var.set("")
    check("端口留空时退回记住的值", app._port_from_var() == 38765,
          f"-> {app._port_from_var()}")
    app._port_var.set("50000")
    check("端口合法时原样采用", app._port_from_var() == 50000,
          f"-> {app._port_from_var()}")

    # 点 START 会把端口落盘（下次打开才回得来）
    server.save_window_prefs({})
    app._win_prefs = {}
    app._port_var.set("38765")
    if app._tree.get_children():
        app._tree.selection_set(app._tree.get_children()[0])
        _dev_id = app._port_ids[0]
        app._start_server = lambda *a, **k: None      # 只验"记住"，不真的起服务器
        app._on_start()
        check("点 START 会把端口写进 prefs（下次启动才回得来）",
              server.load_window_prefs().get("port") == 38765,
              f"{server.load_window_prefs()}")
    else:
        check("点 START 会把端口写进 prefs（下次启动才回得来）", False, "没有可用 MIDI 端口，跳过")
finally:
    try: app.root.destroy()
    except Exception: pass

print(f"\n{total - len(fails)}/{total} checks passed")
sys.exit(1 if fails else 0)
