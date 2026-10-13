"""打印虚拟 MIDI 端点的“身份”（InstanceId / 容器 / 注册表键），用来判断端口是不是被重建过。

背景：Nuendo 的 MIDI Remote 设备（DIY `PhoneMIDI`）按名字匹配 `PhonePad`。**端口只要被删掉重建，
它就是一个“新设备”**——旧绑定失效、显示“断开连接”，只有重启 DAW 才会重新枚举。
所以排查时要能区分「端口消失了」和「端口还在、只是被换了身份」。

    python tools/midi_endpoint_identity.py

在“正常时”和“断开时”各跑一次，对比输出即可。只读，不打开端口。
"""
import ctypes
import subprocess
import sys
from ctypes import wintypes

MAXPNAMELEN = 32


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


def winmm():
    w = ctypes.windll.winmm
    print("== WinMM（Bridge 走的就是这条：winmm → wdmaud2.drv → Windows MIDI 服务）==")
    print("  序号在这里是**列表下标**，插拔任何 MIDI 设备都会整体位移")
    for i in range(w.midiOutGetNumDevs()):
        c = MIDIOUTCAPSW()
        if w.midiOutGetDevCapsW(i, ctypes.byref(c), ctypes.sizeof(c)) == 0:
            print(f"  OUT [{i}] {c.szPname}   wMid={c.wMid:#06x} wPid={c.wPid:#06x} ver={c.vDriverVersion:#010x}")
    for i in range(w.midiInGetNumDevs()):
        c = MIDIINCAPSW()
        if w.midiInGetDevCapsW(i, ctypes.byref(c), ctypes.sizeof(c)) == 0:
            print(f"  IN  [{i}] {c.szPname}   wMid={c.wMid:#06x} wPid={c.wPid:#06x} ver={c.vDriverVersion:#010x}")


PNP_PS = r"""
$targets = 'PhonePad','loopMIDI'
foreach ($d in (Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
        $_.FriendlyName -match ($targets -join '|') })) {
  $id = $d.InstanceId
  $key = "HKLM:\SYSTEM\CurrentControlSet\Enum\$id"
  $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
  "{0}`t{1}`t{2}`tContainer={3}`tCreated={4}" -f `
      $d.Status, $d.Class, $d.FriendlyName, $props.ContainerID, $props.ConfigFlags
  "    instance=$id"
  "    devprop=$((Get-PnpDeviceProperty -InstanceId $id -KeyName 'DEVPKEY_Device_InstanceId' -ErrorAction SilentlyContinue).Data)"
}
"""


def pnp():
    print("\n== PnP / 注册表身份（Windows MIDI 服务把虚拟端口登记成 SoftwareDevice / MidiEndpoint）==")
    p = subprocess.run(["powershell", "-NoProfile", "-Command", PNP_PS],
                       capture_output=True, text=True)
    out = (p.stdout or "") + (p.stderr or "")
    for line in out.splitlines():
        if line.strip():
            print("  " + line.rstrip())


if __name__ == "__main__":
    winmm()
    pnp()
    print("\n对比要点：`instance=` 那串数字里含端点的持久 ID。**同一台机器、同一个端口，"
          "正常时与断开时应当一字不差**；变了就说明端口被删掉重建过。")
    sys.exit(0)
