"""Boot check: actually start the bridge and fetch the pages it serves.

The unit checks exercise MappingEngine and SensorHandler directly, which is exactly how a
wrong argparse attribute name (`args.pb_idle_sec` instead of `--pb-idle-ms`) slipped through
and crashed the CLI at startup. This one starts the real process, so every wire-up between
CLI flags, the handler, the watchdog task and static file serving has to work.

Skipped (exit 0) when no MIDI port is available, since the bridge refuses to start without one.
"""
import os, socket, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bridge"))
import server                                  # for the socket-binding checks below
PORT = 8791
fails = []
total = 0        # 自己数，别写死分母：这一版加了一条检查，写死的 "8" 会安静地说谎
def check(name, ok, detail=""):
    global total
    total += 1
    print(("PASS  " if ok else "FAIL  ") + name.ljust(46) + detail)
    if not ok:
        fails.append(name)

proc = subprocess.Popen(
    [sys.executable, os.path.join(ROOT, "bridge", "server.py"), "--no-gui",
     "--no-ssl", "--port", str(PORT), "--pb-idle-ms", "300"],
    cwd=os.path.join(ROOT, "bridge"),
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")


def fetch(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=5) as r:
        return r.read().decode("utf-8", "replace")


try:
    deadline = time.time() + 15
    up = False
    while time.time() < deadline:
        if proc.poll() is not None: break          # died: read the traceback below
        try:
            fetch("/status")
            up = True
            break
        except Exception:
            time.sleep(0.25)

    if not up and proc.poll() is not None:
        out = proc.stdout.read() if proc.stdout else ""
        if "MIDI" in out and ("not found" in out or "WinMidiError" in out or "no MIDI" in out.lower()):
            print("SKIP  bridge boot check                  没有可用的 MIDI 端口")
            sys.exit(0)
        check("bridge starts from the CLI", False, out.strip().splitlines()[-1] if out.strip() else "no output")
    else:
        check("bridge starts from the CLI (with --pb-idle-ms)", up, f"listening on http://127.0.0.1:{PORT}")
        if up:
            idx = fetch("/fader.html")
            check("serves fader.html with vibrato.js", "vibrato.js?v=" in idx, f"{len(idx)} bytes")
            vib = fetch("/vibrato.js")
            check("serves the current vibrato.js",
                  "pm.vibrato.cal.v1" in vib and "measureRate" in vib and "stallSec" in vib,
                  f"{len(vib)} bytes")
            lab = fetch("/vibrato-lab.html")
            check("serves the debug page", "segInterp" in lab and "vibrato-lab.js?v=" in lab, f"{len(lab)} bytes")
            ws_check = fetch("/vibrato-lab.js")
            check("serves the debug page script", "depthTrim" in ws_check, f"{len(ws_check)} bytes")
            # 格子那一层是 pad.html 与推子页共用的新文件：它 404 的话，两处的按钮会一起哑掉——
            # 而页面本身还是"看起来正常"的，所以必须有一条"真的服务得出来"的检查。
            pgrid = fetch("/padgrid.js")
            check("serves the shared grid script (padgrid.js)",
                  "PhoneMidiPadGrid" in pgrid and "createGrid" in pgrid and "padgrid.js?v=" in idx,
                  f"{len(pgrid)} bytes，fader.html 引到了它")

            # ── the reported bug: a second instance must NOT silently share the port ──
            # With SO_REUSEADDR (the old behaviour on Windows) a second Bridge bound the same
            # port happily, so the phone's connection went to the *leftover* process while the
            # new window showed "running" with zero clients. It has to fail, loudly.
            second = subprocess.run(
                [sys.executable, os.path.join(ROOT, "bridge", "server.py"), "--no-gui",
                 "--no-ssl", "--port", str(PORT), "--pb-idle-ms", "300"],
                cwd=os.path.join(ROOT, "bridge"), capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=40)
            check("a second instance refuses the busy port",
                  second.returncode != 0 and "已被占用" in (second.stdout + second.stderr),
                  f"exit={second.returncode}, "
                  + next((l for l in (second.stdout + second.stderr).splitlines() if "占用" in l), "no message"))
            still = fetch("/status")            # and the first one kept running
            check("the first instance is undisturbed", '"clients"' in still, f"{len(still)} bytes")

            # ── stop/start must release the port immediately ──
            # Stopping the server closes the phone's socket first, which leaves the port in
            # TIME_WAIT. An exclusive bind refuses that, so the next START used to fail with
            # "端口已被占用". The fallback (nobody listening ⇒ reuse allowed) is what makes an
            # immediate restart work; this reproduces exactly that state.
            port2 = PORT + 1
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            srv.bind(("127.0.0.1", port2)); srv.listen(4)
            cli = socket.create_connection(("127.0.0.1", port2))
            conn, _ = srv.accept()
            conn.close()                        # server closes first ⇒ server-side TIME_WAIT
            cli.close(); srv.close()
            time.sleep(0.3)
            try:
                again = server.bind_server_socket("127.0.0.1", port2)
                ok, detail = True, "立即重新绑定成功（TIME_WAIT 被容忍）"
                again.close()
            except OSError as e:
                ok, detail = False, str(e)
            check("stop/start: 端口立刻可重新绑定", ok, detail)
            # Document (not assert — this varies by Windows version) that the pure exclusive
            # bind really is what fails here, i.e. the fallback is load-bearing.
            probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
                probe.bind(("127.0.0.1", port2))
                print("      注：本机纯独占绑定在这种状态下也能成功（版本差异），回退仍保留以防万一")
            except OSError as e:
                print(f"      注：本机纯独占绑定在此状态下失败（{e.winerror if hasattr(e, 'winerror') else e}）"
                      f"——这正是需要回退的原因")
            finally:
                probe.close()
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

print(f"\n{total - len(fails)}/{total} checks passed")
sys.exit(1 if fails else 0)
