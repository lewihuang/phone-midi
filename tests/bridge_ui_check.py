"""精简模式（compact mode）检查，不弹窗。

只覆盖用户要求的三件事：
  1. 精简模式只保留 当前值 + 进度条（外加一个返回展开态的按钮）
  2. 精简模式置顶（否则会被 DAW 盖住）
  3. 精简模式可拉伸，下限 420×150；展开态窗口尺寸保持原样（480×420，不置顶）

以及启动失败（端口被占用）时窗口必须报错，而不是假装在运行——那是"手机连上了但 PC
没有 client"的真正原因。
"""
import os, re, sys, time, tkinter as tk

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bridge"))
import server

fails = []
total = 0
def check(name, ok, detail=""):
    global total
    total += 1
    print(("PASS  " if ok else "FAIL  ") + name.ljust(44) + detail)
    if not ok:
        fails.append(name)

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
        self.pad_flash = None

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

    # ── 面板按下的确认灯（PC 端闪一下） ─────────────────────────────────────
    # 手机端在鸿蒙上拿不到马达（spec D25），改成在人就在旁边的 PC 上闪：整窗变绿 200ms，
    # 并把"按了哪一个"写出来。Bridge（asyncio 线程）只记一个时间戳元组，这里轮询捡走。
    app._handler.pad_flash = (1, 8, 39, "停止")
    app._poll_status()
    lit = [w.cget("bg") for w, _bg in app._flash_targets]
    check("面板触发：精简窗整窗闪 + 显示是哪一个按钮",
          app._mon_value.cget("text") == "▶ 停止   N39" and lit and all(b == server.GREEN for b in lit)
          and app._mon_value.cget("fg") == server.BG,
          f"{app._mon_value.cget('text')!r} bg={lit[:1]}")
    check("闪的底色覆盖整窗（body/top/留白/进度条都在名单里）",
          len(app._flash_targets) == 4, f"{len(app._flash_targets)} 个部件")
    app._poll_status()      # 同一事件不重复捡（时间戳不会前进）
    check("同一个触发只闪一次（按按下序号去重）",
          app._mon_value.cget("text") == "▶ 停止   N39", "轮询重复跑也还是那一次")

    app._pad_flash_until = 0        # 200ms 到了
    app._handler.last_cc_output = cc_out
    app._poll_status()
    restored = [w.cget("bg") for w, _bg in app._flash_targets]
    check("闪完自动复原：底色、字色、值都回到原样",
          restored == [server.BG, server.BG, server.BG, server.SURFACE]
          and app._mon_value.cget("fg") == server.FG
          and app._mon_value.cget("text") == "CC1 64",
          f"bg={restored} text={app._mon_value.cget('text')!r}")

    app._handler.pad_flash = (2, 0, 36, "")     # 没写文字的格子
    app._poll_status()
    check("没写文字的格子退回“格 N”，不会显示成空",
          app._mon_value.cget("text") == "▶ 格 1   N36", app._mon_value.cget("text"))
    app._pad_flash_until = 0
    app._poll_status()

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

    # ── 窗口几何：标准窗每次回到默认位置；精简窗记住尺寸+位置 ────────────────
    server.save_window_prefs({"compact": [520, 140], "compact_pos": [1234, 567], "junk": "x"})
    got = server.load_window_prefs()
    check("几何记录：写入后能读回、脏字段被忽略",
          got.get("compact") == [520, 140] and got.get("compact_pos") == [1234, 567]
          and "junk" not in got, f"{got}")
    check("几何记录：超出屏幕会被钳制",
          app._fit([99999, 99999], 420, 84).split("x")[0] == str(app.root.winfo_screenwidth()),
          f"{app._fit([99999, 99999], 420, 84)}（屏幕 {app.root.winfo_screenwidth()}）")
    check("几何记录：低于下限会被抬高", app._fit([10, 10], 420, 84) == "420x84",
          app._fit([10, 10], 420, 84))

    sw, sh = app.root.winfo_screenwidth(), app.root.winfo_screenheight()
    app._compact = False
    app._build_running("loopMIDI", 8765, "https")
    app.root.update_idletasks()
    check("标准窗：每次都是 480x420 + 屏幕居中（不记忆位置）",
          app._win_size == (480, 420) and app._win_pos == ((sw - 480) // 2, (sh - 420) // 2),
          f"{app._win_size} at {app._win_pos}")

    app._compact = True
    app._compact_geom = None
    app._win_prefs = server.load_window_prefs()
    app._build_running("loopMIDI", 8765, "https")
    app.root.update_idletasks()
    check("精简窗：尺寸与位置都沿用记录值",
          app._win_size == (520, 140) and app._win_pos == (1234, 567),
          f"{app._win_size} at {app._win_pos}")

    # 关闭时抓取（窗口未映射时 winfo_* 返回 1，这里打桩）
    app._win_prefs = {}
    app.root.winfo_width = lambda: 550
    app.root.winfo_height = lambda: 130
    app.root.winfo_x = lambda: 800
    app.root.winfo_y = lambda: 200
    app._capture_window()
    check("精简窗：关闭时抓到尺寸与位置并落盘",
          server.load_window_prefs().get("compact") == [550, 130]
          and server.load_window_prefs().get("compact_pos") == [800, 200],
          f"{server.load_window_prefs()}")

    app._win_prefs = {}
    app._compact = False
    app._compact_geom = "500x120+321+654"        # 离开精简态时记下的
    app._mode = "running"
    app._capture_window()
    check("从标准窗退出：仍保留上一次精简窗的几何，且不写标准窗的位置",
          server.load_window_prefs() == {"compact": [500, 120], "compact_pos": [321, 654]},
          f"{server.load_window_prefs()}")

    app._win_prefs = {}
    app._compact_geom = None
    app._mode = "setup"
    app._capture_window()
    check("从未进过精简态：不写任何记录", server.load_window_prefs() == {},
          f"{server.load_window_prefs()}")

    # 启动失败必须可见
    app._show_error("端口 8765 已被占用：已经有一个「手机推子」在运行")
    app.root.update_idletasks()
    texts = [w.cget("text") for w in app.root.winfo_children() if isinstance(w, tk.Label)]
    check("端口被占用时窗口显示错误而不是运行中",
          app._mode == "setup" and any("启动失败" in t for t in texts),
          next((t for t in texts if t.startswith("启动失败")), "no error label"))
finally:
    try: app.root.destroy()
    except Exception: pass

print(f"\n{total - len(fails)}/{total} checks passed")
sys.exit(1 if fails else 0)
