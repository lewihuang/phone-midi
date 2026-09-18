"""Really map the window and measure it (窗口会短暂出现几秒)。

Withdrawn windows do not report their real size, so this is the only honest way to check what
the user will actually see. Prints the measured sizes and the bar's thickness, and fails if the
compact window is not the 420 x COMPACT_DEF_H bar it is supposed to be.
"""
import os, sys, time, tkinter as tk

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception: pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bridge"))
import server

app = server.BridgeApp()
class FakeHandler:
    last_cc_output = [{"cc": 1, "channel": 0, "value": 64}]
    client_count = 1
app._handler = FakeHandler()
app._build_running("loopMIDI", 8765, "https")
app.root.update(); time.sleep(0.4); app.root.update()
print(f"展开态实测: {app.root.winfo_width()}x{app.root.winfo_height()}")

app._toggle_compact()
app.root.update(); time.sleep(0.6); app.root.update()
w, h = app.root.winfo_width(), app.root.winfo_height()
bar = app._bar.winfo_height()
print(f"精简态实测: {w}x{h}   比例 {w / h:.2f}:1   "
      f"（期望 {server.COMPACT_MIN_W}x{server.COMPACT_DEF_H}）")
print(f"进度条厚度: {bar} px（期望 {server.COMPACT_BAR_H}）")
ok = (w, h) == (server.COMPACT_MIN_W, server.COMPACT_DEF_H) and bar == server.COMPACT_BAR_H
app.root.destroy()
print("结果:", "正确" if ok else "不对")
sys.exit(0 if ok else 1)
