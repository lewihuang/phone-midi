"""Boot check: actually start the bridge and fetch the pages it serves.

The unit checks exercise MappingEngine and SensorHandler directly, which is exactly how a
wrong argparse attribute name (`args.pb_idle_sec` instead of `--pb-idle-ms`) slipped through
and crashed the CLI at startup. This one starts the real process, so every wire-up between
CLI flags, the handler, the watchdog task and static file serving has to work.

Skipped (exit 0) when no MIDI port is available, since the bridge refuses to start without one.
"""
import os, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8791
fails = []
def check(name, ok, detail=""):
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
            idx = fetch("/index.html")
            check("serves index.html with vibrato.js", "vibrato.js?v=" in idx, f"{len(idx)} bytes")
            vib = fetch("/vibrato.js")
            check("serves the current vibrato.js",
                  "pm.vibrato.cal.v1" in vib and "measureRate" in vib and "stallSec" in vib,
                  f"{len(vib)} bytes")
            lab = fetch("/vibrato-lab.html")
            check("serves the debug page", "segInterp" in lab and "vibrato-lab.js?v=" in lab, f"{len(lab)} bytes")
            ws_check = fetch("/vibrato-lab.js")
            check("serves the debug page script", "depthTrim" in ws_check, f"{len(ws_check)} bytes")
finally:
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

print(f"\n{5 - len(fails)}/5 checks passed")
sys.exit(1 if fails else 0)
