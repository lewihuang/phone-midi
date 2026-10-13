"""盯着 PhonePad / loopMIDI 这些虚拟 MIDI 端口在 Windows 里的"出现 / 消失"。

为什么需要它：Nuendo 的 MIDI Remote 设备（DIY `PhoneMIDI`）是**按名字**匹配输入端口
`PhonePad` 的。只要这个端口在系统里消失（或带着新身份重建），设备就会显示"断开连接"。
本脚本**不打开端口**（只列举），因此不会自己影响端口的存在性。

用法：
    python tools/midi_watch.py             # 每 2 秒采一次，写到 %TEMP%\\midi_watch.log
    python tools/midi_watch.py --seconds 600 --interval 1

输出只在**状态发生变化时**追加一行，方便与 Nuendo/Bridge 的时间线对齐。
"""
import argparse
import ctypes
import datetime
import os
import subprocess
import sys
from ctypes import wintypes

MAXPNAMELEN = 32
WATCH = ("phonepad", "loopmidi")


class MIDIOUTCAPSW(ctypes.Structure):
    _fields_ = [("wMid", wintypes.WORD), ("wPid", wintypes.WORD),
                ("vDriverVersion", wintypes.DWORD),
                ("szPname", wintypes.WCHAR * MAXPNAMELEN),
                ("wTechnology", wintypes.WORD), ("wVoices", wintypes.WORD),
                ("wNotes", wintypes.WORD), ("wChannelMask", wintypes.WORD),
                ("dwSupport", wintypes.DWORD)]


class MIDIINCAPSW(ctypes.Structure):
    _fields_ = [("wMid", wintypes.WORD), ("wPid", wintypes.WORD),
                ("vDriverVersion", wintypes.DWORD),
                ("szPname", wintypes.WCHAR * MAXPNAMELEN),
                ("dwSupport", wintypes.DWORD)]


def winmm_snapshot():
    w = ctypes.windll.winmm
    out = []
    for i in range(w.midiOutGetNumDevs()):
        c = MIDIOUTCAPSW()
        if w.midiOutGetDevCapsW(i, ctypes.byref(c), ctypes.sizeof(c)) == 0:
            out.append(f"OUT[{i}]={c.szPname}")
    inn = []
    for i in range(w.midiInGetNumDevs()):
        c = MIDIINCAPSW()
        if w.midiInGetDevCapsW(i, ctypes.byref(c), ctypes.sizeof(c)) == 0:
            inn.append(f"IN[{i}]={c.szPname}")
    return out + inn


def pnp_snapshot():
    """PnP 视角（Windows MIDI 服务把端口登记成 SoftwareDevice/MidiEndpoint）。"""
    try:
        p = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-PnpDevice -Class SoftwareDevice,MidiEndpoint -ErrorAction SilentlyContinue | "
             "Where-Object { $_.FriendlyName -match 'PhonePad|loopMIDI' } | "
             "ForEach-Object { $_.Status + ' ' + $_.FriendlyName + ' ' + $_.InstanceId }"],
            capture_output=True, text=True, timeout=20)
        return [ln.strip() for ln in p.stdout.splitlines() if ln.strip()]
    except Exception as e:                                     # 采集失败不能拖垮监视
        return [f"(pnp probe failed: {e})"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=3600)
    ap.add_argument("--interval", type=float, default=2.0)
    ap.add_argument("--log", default=os.path.join(os.environ.get("TEMP", "."), "midi_watch.log"))
    args = ap.parse_args()

    import time
    deadline = time.time() + args.seconds
    last = None
    with open(args.log, "a", encoding="utf-8") as fh:
        fh.write(f"\n=== midi_watch start {datetime.datetime.now():%Y-%m-%d %H:%M:%S} ===\n")
        fh.flush()
        while time.time() < deadline:
            snap = sorted(set(winmm_snapshot())), sorted(set(pnp_snapshot()))
            if snap != last:
                stamp = datetime.datetime.now().strftime("%H:%M:%S")
                fh.write(f"\n[{stamp}] --- change ---\n")
                for line in snap[0]:
                    if "phonepad" in line.lower() or "loopmidi" in line.lower():
                        fh.write(f"  winmm  {line}\n")
                for line in snap[1]:
                    fh.write(f"  pnp    {line}\n")
                fh.flush()
                last = snap
            time.sleep(args.interval)
    print(f"log: {args.log}")


if __name__ == "__main__":
    main()
