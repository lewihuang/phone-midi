"""列出 Windows 上的 MIDI 端口（winmm 视角）。

用途：排查「Nuendo 的 MIDI Remote 设备突然断开连接」。设备是**按名字**匹配端口的
（`DIY_PhoneMIDI.json` 里 `"FilterValue": "PhonePad"`），端口在系统里一消失/一重建，
设备就变成"断开连接"。本脚本**不打开端口**，只读，不影响正在运行的 Bridge。

    python tools/midi_ports_probe.py

要长期盯着"端口有没有消失/重建"，用 `tools/midi_watch.py`（这个脚本是它的一次性版本）。
"""
import ctypes
from ctypes import wintypes

MAXPNAMELEN = 32


class MIDIOUTCAPSW(ctypes.Structure):
    _fields_ = [
        ("wMid", wintypes.WORD), ("wPid", wintypes.WORD),
        ("vDriverVersion", wintypes.DWORD),
        ("szPname", wintypes.WCHAR * MAXPNAMELEN),
        ("wTechnology", wintypes.WORD), ("wVoices", wintypes.WORD),
        ("wNotes", wintypes.WORD), ("wChannelMask", wintypes.WORD),
        ("dwSupport", wintypes.DWORD),
    ]


class MIDIINCAPSW(ctypes.Structure):
    _fields_ = [
        ("wMid", wintypes.WORD), ("wPid", wintypes.WORD),
        ("vDriverVersion", wintypes.DWORD),
        ("szPname", wintypes.WCHAR * MAXPNAMELEN),
        ("dwSupport", wintypes.DWORD),
    ]


def out_ports():
    winmm = ctypes.windll.winmm
    n = winmm.midiOutGetNumDevs()
    ports = []
    for i in range(n):
        caps = MIDIOUTCAPSW()
        if winmm.midiOutGetDevCapsW(i, ctypes.byref(caps), ctypes.sizeof(caps)) == 0:
            ports.append((i, caps.szPname, caps.wTechnology))
    return ports


def in_ports():
    winmm = ctypes.windll.winmm
    n = winmm.midiInGetNumDevs()
    ports = []
    for i in range(n):
        caps = MIDIINCAPSW()
        if winmm.midiInGetDevCapsW(i, ctypes.byref(caps), ctypes.sizeof(caps)) == 0:
            ports.append((i, caps.szPname))
    return ports


TECH = {1: "MIDIPORT_MIDI", 2: "MIDIPORT_SYNTH", 3: "MIDIPORT_SQSYNTH",
        4: "MIDIPORT_FMSYNTH", 5: "MIDIPORT_MAPPER", 6: "MIDIPORT_WAVETABLE",
        7: "MIDIPORT_SWMIDI", 8: "MIDIPORT_UNKNOWN"}


def main():
    # 这些数字就是 WinMM 的**设备下标**：Bridge 与 DAW 都按它寻址，插拔任何 MIDI 设备都会位移
    print("== WinMM MIDI OUT (midiOutGetNumDevs) ==")
    for i, name, tech in out_ports():
        mark = "  <== PhonePad" if "phonepad" in name.lower() else ""
        print(f"  [{i}] {name}  tech={TECH.get(tech, tech)}{mark}")
    print("== WinMM MIDI IN (midiInGetNumDevs) ==")
    for i, name in in_ports():
        mark = "  <== PhonePad" if "phonepad" in name.lower() else ""
        print(f"  [{i}] {name}{mark}")


if __name__ == "__main__":
    main()
