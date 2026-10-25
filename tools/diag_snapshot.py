"""MIDI Deck × Nuendo 状态快照：正常时记一份，出故障时再记一份，用 diag_diff.py 对比。

为什么需要它：`DIY - PhoneMIDI` 偶尔在 Nuendo 里变成"未连接 + 所有映射消失"，几分钟后又可能
自己好；而这类故障的证据分散在**五个地方**，少了任何一个都只能猜：

  1. 端点身份：WinRT/MidiSrv 侧 `SWD\\MMDEVAPI\\MIDIU_KSA_<容器>_<slot>` 有没有换号（Nuendo 按
     名字认端口，但已经建立的绑定指着旧身份）；
  2. Nuendo 的端口缓存：`Port Setup.xml` 里 WinRT 段把 slot 映射成了什么名字（这台机器上它
     **长期是错位的**：`_0_0`→Pianoteq、`_0_1`→DAW、`_0_2`→loopMIDI Port，而系统里
     `_0_0`→loopMIDI Port、`_0_1`→PhonePad）——出错时它是否又被重写过；
  3. 映射文件：`MIDI Remote\\User Settings\\DIY_PhoneMIDI_*_globalmappings.json` 里还剩几个绑定
     （"映射为空"最直接的物证，Nuendo 会在加载失败时把它写回成空壳）；
  4. 电源事件：睡眠/唤醒是已经确认过的触发条件之一（2026-10-14 实证），时间线必须留档；
  5. Bridge 侧：端口体检日志、winmm 端口表与下标、当前 `/status`。

用法：

    python tools/diag_snapshot.py --tag normal
    python tools/diag_snapshot.py --tag broken --note "Nuendo 里 PhoneMIDI 空白"

输出到 `%APPDATA%\\phone-midi-bridge\\diag\\<时间>_<tag>\\`：
`snapshot.json`（结构化）、`report.md`（人看）、`files\\`（关键文件的原始副本）。
全程只读：不打开 MIDI 端口、不写 Nuendo/loopMIDI 的任何配置。
"""
import ctypes
import hashlib
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import urllib.request
import winreg
from ctypes import wintypes
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APPDATA = Path(os.environ.get("APPDATA", ""))
DIAG_ROOT = APPDATA / "phone-midi-bridge" / "diag"
BRIDGE_DIR = APPDATA / "phone-midi-bridge"
DOCS = Path(os.environ.get("USERPROFILE", "")) / "Documents" / "Steinberg" / "Nuendo"
MIDI_REMOTE = DOCS / "MIDI Remote"
PS_HEAD = ("[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
           "$OutputEncoding=[Text.Encoding]::UTF8; ")


# ── 小工具 ──────────────────────────────────────────────────────────────────

def now_tag():
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def iso(ts):
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%S") if ts else None


def file_meta(path):
    """存在与否 / 大小 / mtime / sha256 —— 对比时最省事的一组指纹。"""
    p = Path(path)
    if not p.is_file():
        return {"path": str(p), "exists": False}
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    st = p.stat()
    return {"path": str(p), "exists": True, "size": st.st_size,
            "mtime": iso(st.st_mtime), "sha256": h.hexdigest()}


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception as e:
        return {"_error": f"{type(e).__name__}: {e}"}


def ps_json(script, timeout=90):
    """跑一段 PowerShell 并把它 ConvertTo-Json 的输出解析回来（UTF-8）。"""
    cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command", PS_HEAD + script]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except Exception as e:
        return {"_error": f"{type(e).__name__}: {e}"}
    out = p.stdout.decode("utf-8", "replace").strip()
    if not out:
        return None
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {"_raw": out[:4000],
                "_stderr": p.stderr.decode("utf-8", "replace")[:1500]}


# ── 系统 / 进程 / 电源 ──────────────────────────────────────────────────────

def system_info():
    return ps_json(r"""
$os = Get-CimInstance Win32_OperatingSystem
[pscustomobject]@{
  boot  = $os.LastBootUpTime.ToString('yyyy-MM-ddTHH:mm:ss')
  os    = $os.Caption
  build = $os.BuildNumber
  now   = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
  tz    = (Get-TimeZone).Id
  uptime_sec = [int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
} | ConvertTo-Json -Compress
""")


def processes():
    return ps_json(r"""
@(Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match '^(Nuendo|MIDI Deck|loopMIDI|MidiSrv)' } |
  ForEach-Object {
    [pscustomobject]@{
      pid   = $_.ProcessId
      ppid  = $_.ParentProcessId
      name  = $_.Name
      start = $_.CreationDate.ToString('yyyy-MM-ddTHH:mm:ss')
      path  = $_.ExecutablePath
      cmd   = $_.CommandLine
    }
  }) | ConvertTo-Json -Compress
""")


def services():
    return ps_json(r"""
@(Get-Service | Where-Object { $_.Name -match 'midi|virtual|audio' } |
  ForEach-Object {
    [pscustomobject]@{
      name  = $_.Name
      state = [string]$_.Status
      start = $_.StartType.ToString()
    }
  }) | ConvertTo-Json -Compress
""")


def power_events():
    return ps_json(r"""
$ev = @()
$ev += Get-WinEvent -FilterHashtable @{LogName='System'; Id=42,107,131; StartTime=(Get-Date).AddDays(-7)} -ErrorAction SilentlyContinue
$ev += Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Power-Troubleshooter'; StartTime=(Get-Date).AddDays(-7)} -ErrorAction SilentlyContinue
$power = @($ev | Sort-Object TimeCreated | Select-Object -Last 60 | ForEach-Object {
  [pscustomobject]@{
    t   = $_.TimeCreated.ToString('yyyy-MM-ddTHH:mm:ss')
    id  = $_.Id
    src = $_.ProviderName
    msg = (($_.Message -split "`r?`n" | Where-Object { $_ -ne '' })[0])
  }
})
$boots = @(Get-WinEvent -FilterHashtable @{LogName='System'; Id=6005,6006,6008; StartTime=(Get-Date).AddDays(-7)} -ErrorAction SilentlyContinue |
  Sort-Object TimeCreated | Select-Object -Last 10 | ForEach-Object {
    [pscustomobject]@{ t=$_.TimeCreated.ToString('yyyy-MM-ddTHH:mm:ss'); id=$_.Id; src=$_.ProviderName }
  })
[pscustomobject]@{ power = $power; boots = $boots } | ConvertTo-Json -Compress -Depth 5
""")


# ── MIDI：winmm / 驱动 / 端点身份 / loopMIDI ────────────────────────────────

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


def winmm_ports():
    """Bridge 走的是这条。下标会因为任何 MIDI 设备插拔整体位移，所以下标也要记。"""
    w = ctypes.windll.winmm
    outs, ins = [], []
    for i in range(w.midiOutGetNumDevs()):
        c = MIDIOUTCAPSW()
        if w.midiOutGetDevCapsW(i, ctypes.byref(c), ctypes.sizeof(c)) == 0:
            outs.append({"index": i, "name": c.szPname, "wMid": c.wMid,
                         "wPid": c.wPid, "ver": f"{c.vDriverVersion:#010x}",
                         "tech": c.wTechnology})
    for i in range(w.midiInGetNumDevs()):
        c = MIDIINCAPSW()
        if w.midiInGetDevCapsW(i, ctypes.byref(c), ctypes.sizeof(c)) == 0:
            ins.append({"index": i, "name": c.szPname, "wMid": c.wMid,
                        "wPid": c.wPid, "ver": f"{c.vDriverVersion:#010x}"})
    return {"out": outs, "in": ins}


def drivers32():
    """老 MIDI 栈的驱动链：有任何第三方 midiN 驱动都会在这里露头。"""
    out = {}
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Drivers32") as k:
            i = 0
            while True:
                try:
                    name, value, _ = winreg.EnumValue(k, i)
                except OSError:
                    break
                if name.lower().startswith("midi"):
                    out[name] = value
                i += 1
    except OSError as e:
        out["_error"] = str(e)
    return out


def pnp_endpoints():
    """Nuendo 的 MIDI Remote 检测读的是这一层（MidiSrv 登记的端点）。身份号变了 = 端口被重建过。"""
    return ps_json(r"""
$out = @()
foreach ($d in @(Get-PnpDevice -Class MidiEndpoint,SoftwareDevice -ErrorAction SilentlyContinue)) {
  $o = [pscustomobject]@{
    status = $d.Status; class = $d.Class; name = $d.FriendlyName; instance = $d.InstanceId
    install = $null; removal = $null
  }
  if ($d.FriendlyName -match 'PhonePad|loopMIDI') {
    try { $o.install = [string](Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_InstallDate' -ErrorAction Stop).Data } catch {}
    try { $o.removal = [string](Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName 'DEVPKEY_Device_LastRemovalDate' -ErrorAction Stop).Data } catch {}
  }
  $out += $o
}
@($out) | ConvertTo-Json -Compress -Depth 4
""")


def loopmidi_registry():
    """端口定义与反馈检测参数：端口被改名/增删会整体重排 slot，这是要盯的常态隐患。"""
    def walk(path):
        node = {"values": {}, "keys": {}}
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
                i = 0
                while True:
                    try:
                        name, value, _ = winreg.EnumValue(k, i)
                    except OSError:
                        break
                    node["values"][name] = value
                    i += 1
                i = 0
                while True:
                    try:
                        sub = winreg.EnumKey(k, i)
                    except OSError:
                        break
                    node["keys"][sub] = walk(f"{path}\\{sub}")
                    i += 1
        except OSError as e:
            node["_error"] = str(e)
        return node
    return walk(r"Software\Tobias Erichsen\loopMIDI")


# ── Bridge ──────────────────────────────────────────────────────────────────

def https_json(url, timeout=5):
    ctx = ssl._create_unverified_context()
    try:
        with urllib.request.urlopen(url, timeout=timeout, context=ctx) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:
        return {"_error": f"{type(e).__name__}: {e}"}


def bridge_snapshot():
    cfg = {}
    for name in ("window.json", "fader.json", "xy.json", "ui.json"):
        p = BRIDGE_DIR / name
        cfg[name] = dict(file_meta(p), json=read_json(p) if p.is_file() else None)

    pad_path = BRIDGE_DIR / "pad.json"
    pad = {"file": file_meta(pad_path)}
    if pad_path.is_file():
        data = read_json(pad_path)
        pages = (data.get("pages") or []) if isinstance(data, dict) else []
        pad["pages"] = [{
            "title": (pg or {}).get("title"),
            "cells": len((pg or {}).get("cells") or []),
            "filled": sum(1 for c in ((pg or {}).get("cells") or [])
                          if isinstance(c, dict) and c.get("text")),
        } for pg in pages]

    port = None
    try:
        port = (cfg["window.json"].get("json") or {}).get("port")
    except Exception:
        pass

    status, listening = None, None
    if port:
        try:
            s = socket.create_connection(("127.0.0.1", int(port)), timeout=1)
            s.close()
            listening = True
        except OSError:
            listening = False
        if listening:
            status = https_json(f"https://127.0.0.1:{port}/status")

    log_path = BRIDGE_DIR / "bridge.log"
    log = {"file": file_meta(log_path)}
    if log_path.is_file():
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        log["tail"] = lines[-80:]
        keys = ("端口", "体检", "重开", "已不在", "Starting on", "面板 MIDI 端口")
        log["port_events"] = [ln for ln in lines if any(k in ln for k in keys)][-60:]
        log["warnings"] = [ln for ln in lines if ("WARNING" in ln or "ERROR" in ln)][-30:]

    exe = ROOT / "bridge" / "dist" / "MIDI Deck.exe"
    server = ROOT / "bridge" / "server.py"
    return {
        "data_dir": str(BRIDGE_DIR),
        "configs": cfg,
        "pad": pad,
        "port": port,
        "listening": listening,
        "status": status,
        "log": log,
        "exe": file_meta(exe),
        "server_py": file_meta(server),
    }


# ── Nuendo ──────────────────────────────────────────────────────────────────

def parse_port_setup(path):
    """把 Port Setup.xml 里每个 <item> 的 ID 与 SysName 取出来。

    只关心 MIDI 段；WinRT 段那串 `MIDIU_KSA_<容器>_<slot>` 是关键：名字与 slot 的对应关系
    在这台机器上**长期错位**（系统侧 `_0_0`=loopMIDI Port、`_0_1`=PhonePad，缓存里却是
    Pianoteq / DAW），所以出错时要看它有没有被重写、指向是否又变了。
    """
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    items = []
    for block in re.findall(r"<item>(.*?)</item>", text, re.S):
        mid = re.search(r'name="ID" value="([^"]*)"', block)
        msys = re.search(r'name="SysName" value="([^"]*)"', block)
        mtype = re.search(r'name="Type" value="([^"]*)"', block)
        if not mid:
            continue
        ident = mid.group(1)
        if "MIDI" not in ident and not ident.startswith(("I|", "O|")):
            continue
        items.append({"id": ident, "sys": msys.group(1) if msys else None,
                      "type": mtype.group(1) if mtype else None})
    winrt = []
    for it in items:
        if "|WinRT MIDI|" not in it["id"]:
            continue
        m = re.search(r"MIDIU_([A-Za-z]+)_([0-9]+)_([0-9]+)_([0-9]+)", it["id"])
        winrt.append({
            "dir": it["id"][0],
            "container": f"{m.group(1)}_{m.group(2)}" if m else None,
            "slot": f"{m.group(3)}_{m.group(4)}" if m else None,
            "instance": it["id"],
            "sys": it["sys"],
        })
    return {
        "items": items,
        "winrt": winrt,
        "has_phonepad_directmusic": any(it["id"].endswith("|DirectMusic|PhonePad") for it in items),
        "has_phonepad_windows_midi": any(it["id"].endswith("|Windows MIDI|PhonePad") for it in items),
        "winrt_has_phonepad": any(w["sys"] == "PhonePad" for w in winrt),
        # 容器 + slot 才是端点身份；只写 slot 会把不同容器的 `_0_0` 混在一起
        "winrt_sys_names": sorted({f"{w['container']}_{w['slot']}:{w['sys']}"
                                   for w in winrt if w["container"] and w["slot"]}),
    }


def resolve_obj(objs, oid, depth=0, seen=None):
    """把 MIDI Remote JSON 的对象图按引用展开（限深，防环）。"""
    seen = seen or set()
    if oid in seen or depth > 3:
        return {"ref": oid}
    seen = seen | {oid}
    obj = objs.get(oid)
    if not obj:
        return {"ref": oid, "missing": True}
    out = {"type": obj.get("type"), "id": oid}
    members = obj.get("members") or {}
    if depth < 3:
        out["members"] = {}
        for k, v in members.items():
            if isinstance(v, int):
                out["members"][k] = resolve_obj(objs, v, depth + 1, seen)
            elif isinstance(v, list):
                out["members"][k] = [resolve_obj(objs, x, depth + 1, seen)
                                     if isinstance(x, int) else x for x in v]
            else:
                out["members"][k] = v
    return out


def describe_device_json(path):
    data = read_json(path)
    meta = {"file": file_meta(path)}
    if not isinstance(data, dict) or "_error" in data:
        meta["error"] = data.get("_error") if isinstance(data, dict) else "not json"
        return meta
    objs = {o["id"]: o for o in data.get("objects", {}).get("internal", [])}
    dd = next((o for o in objs.values() if o.get("type") == "DeviceDriver"), None)
    if not dd:
        meta["error"] = "no DeviceDriver"
        return meta
    m = dd.get("members") or {}
    meta.update({"vendor": m.get("VendorName"), "device": m.get("DeviceName"),
                 "surface_elements": len((objs.get(m.get("Surface"), {}) or {})
                                         .get("members", {}).get("SurfaceElements", []))})
    meta["detection"] = [resolve_obj(objs, uid) for uid in (m.get("DetectionUnits") or [])]
    meta["ports"] = resolve_obj(objs, m.get("Ports")) if m.get("Ports") else None
    return meta


def describe_globalmappings(path):
    data = read_json(path)
    meta = {"file": file_meta(path)}
    if not isinstance(data, dict) or "_error" in data:
        meta["error"] = data.get("_error") if isinstance(data, dict) else "not json"
        return meta
    objs = {o["id"]: o for o in data.get("objects", {}).get("internal", [])}
    pages = []
    for o in objs.values():
        if o.get("type") != "UserMapping":
            continue
        for pid in (o.get("members") or {}).get("Pages", []):
            pg = objs.get(pid) or {}
            bindings = (pg.get("members") or {}).get("HostBindings") or []
            cmds = []
            for bid in bindings:
                b = objs.get(bid) or {}
                bm = b.get("members") or {}
                cmds.append({k: bm.get(k) for k in ("Scope", "CommandCategory", "CommandName")
                             if k in bm})
            pages.append({"page": pg.get("members", {}).get("Name"),
                          "bindings": len(bindings), "commands": cmds})
    meta["pages"] = pages
    meta["bindings_total"] = sum(p["bindings"] for p in pages)
    return meta


def parse_defaults(path):
    """Defaults.xml 里的 PortUID：Nuendo 给每个端口记的 GUID。

    它和 `Port Setup.xml` 的 InstanceId 是两套指纹；端点被重建时两者未必同时变，
    所以都记。顺带取一下 "All MIDI Inputs" 里对 PhonePad 的排除项（D14 的既有配置）。
    """
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    ports = []
    for m in re.finditer(r'<obj class="CmUID" name="PortUID (Input|Output) ([^"]+)"[^>]*>\s*'
                         r'<string name="GUID" value="([0-9A-Fa-f]+)"', text):
        ports.append({"dir": m.group(1), "name": m.group(2), "guid": m.group(3)})
    refs = sorted({f"{d}|{seg}|PhonePad"
                   for d, seg in re.findall(r'value="([IO])\|([^"|]+)\|PhonePad"', text)})
    return {"ports": ports, "phonepad_refs": refs}


def nuendo_snapshot():
    """Nuendo 侧：端口缓存、映射文件、设备定义。目录按版本号找最新的那个。"""
    out = {"documents": str(DOCS), "midi_remote": str(MIDI_REMOTE)}
    steinberg = APPDATA / "Steinberg"
    dirs = sorted([d for d in steinberg.glob("Nuendo*") if d.is_dir()],
                  key=lambda d: d.stat().st_mtime, reverse=True) if steinberg.is_dir() else []
    out["appdata_dirs"] = [str(d) for d in dirs]
    if dirs:
        d = dirs[0]
        out["appdata_dir"] = str(d)
        ps = d / "Port Setup.xml"
        if ps.is_file():
            out["port_setup"] = dict(file_meta(ps), parsed=parse_port_setup(ps))
        out["midi_devices_bin"] = file_meta(d / "Midi Devices.bin")
        defaults = d / "Defaults.xml"
        out["defaults_xml"] = (dict(file_meta(defaults), parsed=parse_defaults(defaults))
                               if defaults.is_file() else {"exists": False, "path": str(defaults)})

    out["globalmappings"] = [describe_globalmappings(p)
                             for p in sorted((MIDI_REMOTE / "User Settings").glob("*.json"))
                             if p.name != "blockeddrivers.json"]
    out["blocked"] = file_meta(MIDI_REMOTE / "User Settings" / "blockeddrivers.json")
    drivers = sorted((MIDI_REMOTE / "Driver Scripts" / "Local" / "DIY").rglob("*.json"))
    out["drivers"] = [describe_device_json(p) for p in drivers]
    return out


# ── 组装 / 落盘 ─────────────────────────────────────────────────────────────

def build_snapshot(tag, note):
    snap = {
        "meta": {
            "tag": tag,
            "note": note,
            "captured_at": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
            "host": socket.gethostname(),
            "user": os.environ.get("USERNAME"),
            "project": str(ROOT),
            "cwd": os.getcwd(),
        },
        "system": system_info(),
        "processes": processes(),
        "services": services(),
        "power": power_events(),
        "midi": {
            "winmm": winmm_ports(),
            "drivers32": drivers32(),
            "pnp_endpoints": pnp_endpoints(),
            "loopmidi_registry": loopmidi_registry(),
        },
        "bridge": bridge_snapshot(),
        "nuendo": nuendo_snapshot(),
    }
    return snap


COPY_TARGETS = [
    # (源路径, 快照内相对路径)
    ("bridge_config", BRIDGE_DIR / "window.json"),
    ("bridge_config", BRIDGE_DIR / "fader.json"),
    ("bridge_config", BRIDGE_DIR / "xy.json"),
    ("bridge_config", BRIDGE_DIR / "pad.json"),
    ("nuendo", Path("__APPDATA_NUENDO__") / "Port Setup.xml"),
    ("nuendo", Path("__APPDATA_NUENDO__") / "Midi Devices.bin"),
    ("nuendo", Path("__APPDATA_NUENDO__") / "Defaults.xml"),
]


def copy_files(snap, out_dir):
    files = []
    out_dir = Path(out_dir)
    nuendo_dir = snap.get("nuendo", {}).get("appdata_dir")

    def do_copy(src, rel):
        src = Path(src)
        if not src.is_file():
            return
        dest = out_dir / "files" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        files.append({"src": str(src), "rel": str(rel), "size": src.stat().st_size,
                      "mtime": iso(src.stat().st_mtime)})

    for group, src in COPY_TARGETS:
        src = Path(str(src).replace("__APPDATA_NUENDO__", nuendo_dir or ""))
        do_copy(src, f"{group}/{src.name}")

    for g in snap.get("nuendo", {}).get("globalmappings", []):
        p = Path(g["file"]["path"])
        do_copy(p, f"nuendo/user_settings/{p.name}")

    for d in snap.get("nuendo", {}).get("drivers", []):
        p = Path(d["file"]["path"])
        try:
            rel = p.relative_to(MIDI_REMOTE)
        except ValueError:
            rel = Path(p.name)
        do_copy(p, f"nuendo/{rel.as_posix()}")

    log_path = BRIDGE_DIR / "bridge.log"
    if log_path.is_file():
        text = log_path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()[-400:]
        dest = out_dir / "files" / "bridge" / "bridge_log_tail.txt"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
        files.append({"src": str(log_path), "rel": "bridge/bridge_log_tail.txt",
                      "size": dest.stat().st_size, "mtime": iso(log_path.stat().st_mtime),
                      "note": f"last {len(lines)} lines"})
    return files


def report_markdown(snap, snap_dir):
    m = snap["meta"]
    sysd = snap.get("system") or {}
    winmm = (snap.get("midi") or {}).get("winmm") or {}
    pnp = (snap.get("midi") or {}).get("pnp_endpoints") or []
    bridge = snap.get("bridge") or {}
    nu = snap.get("nuendo") or {}
    ps_meta = nu.get("port_setup") or {}
    ps = ps_meta.get("parsed") or {}
    status = bridge.get("status") or {}
    phonemidi = next((g for g in (nu.get("globalmappings") or [])
                      if "PhoneMIDI" in Path((g.get("file") or {}).get("path", "")).name), None)
    ph_bind = (phonemidi or {}).get("bindings_total")
    lines = [
        f"# 状态快照 · {m['tag']} · {m['captured_at']}",
        "",
        f"- 备注：{m['note'] or '—'}",
        f"- 主机：{m['host']} / 用户 {m['user']}",
        f"- 系统：{sysd.get('os')} build {sysd.get('build')}，开机 {sysd.get('boot')}，"
        f"已运行 {int((sysd.get('uptime_sec') or 0)/3600)} 小时",
        "",
        "## 对比要点（出故障时看 diff）",
        "",
        f"- PhonePad 的端点身份应是 `…_0_1` / `…_1_1`，loopMIDI Port 是 `…_0_0` / `…_1_0`；"
        f"变了 = 端口被删掉重建。",
        f"- `DIY_PhoneMIDI_…_globalmappings.json` 当前 **{ph_bind}** 个绑定；变少/变 0 就是"
        f"“映射为空”的直接物证。",
        f"- Port Setup 的 WinRT slot→名字在这台机器上**长期错位**（`_0_1`→DAW、`_0_2`→loopMIDI Port）；"
        f"只要没被重写就不算新问题。",
        f"- 睡眠/唤醒、Nuendo/MidiSrv/loopMIDI 重启时间都在下面。",
        "",
        "## 进程",
        "",
        "| 进程 | PID | 启动时间 |",
        "|---|---|---|",
    ]
    for p in snap.get("processes") or []:
        lines.append(f"| {p.get('name')} | {p.get('pid')} | {p.get('start')} |")
    lines += [
        "",
        "## winmm 端口（Bridge 走这条）",
        "",
        "OUT：" + " | ".join(f"[{p['index']}] {p['name']}" for p in winmm.get("out", [])),
        "",
        "IN：" + " | ".join(f"[{p['index']}] {p['name']}" for p in winmm.get("in", [])),
        "",
        "## 端点身份（WinRT / MidiSrv）",
        "",
        "| 状态 | 名字 | InstanceId |",
        "|---|---|---|",
    ]
    for e in pnp:
        if re.search(r"PhonePad|loopMIDI", e.get("name") or "") or "MIDIU" in (e.get("instance") or ""):
            lines.append(f"| {e.get('status')} | {e.get('name')} | `{e.get('instance')}` |")
    du = (nu.get("defaults_xml") or {}).get("parsed") or {}
    guid_in = {p["name"]: p["guid"] for p in (du.get("ports") or []) if p["dir"] == "Input"}
    guid_out = {p["name"]: p["guid"] for p in (du.get("ports") or []) if p["dir"] == "Output"}
    lines += [
        "",
        "## Nuendo 端口缓存（Port Setup.xml）",
        "",
        f"- 文件：{ps_meta.get('path')}（{ps_meta.get('mtime')}）",
        f"- PhonePad 出现在：DirectMusic={ps.get('has_phonepad_directmusic')}、"
        f"Windows MIDI={ps.get('has_phonepad_windows_midi')}、WinRT={ps.get('winrt_has_phonepad')}",
        f"- WinRT slot→名字：{', '.join(ps.get('winrt_sys_names') or [])}",
        f"- PortUID（Defaults.xml）：Input PhonePad=`{guid_in.get('PhonePad')}`、"
        f"Output PhonePad=`{guid_out.get('PhonePad')}`；引用：{', '.join(du.get('phonepad_refs') or [])}",
        "",
        "## MIDI Remote 映射文件",
        "",
        "| 文件 | 绑定数 | mtime | 大小 |",
        "|---|---|---|---|",
    ]
    for g in nu.get("globalmappings") or []:
        f = g.get("file") or {}
        lines.append(f"| {Path(f.get('path','')).name} | {g.get('bindings_total')} | "
                     f"{f.get('mtime')} | {f.get('size')} |")
    lines += [
        "",
        "## Bridge",
        "",
        f"- 端口 {bridge.get('port')}，监听={bridge.get('listening')}，"
        f"客户端={(status or {}).get('clients')}",
        f"- 端口表（Bridge 体检起点见日志）："
        f"{' | '.join((status or {}).get('midi_ports') or []) or '—'}",
        "",
        "## 电源事件（近 7 天，摘）",
        "",
    ]
    for e in ((snap.get("power") or {}).get("power") or [])[-12:]:
        lines.append(f"- {e.get('t')} · {e.get('id')} · {e.get('src')} · {(e.get('msg') or '')[:80]}")
    lines += ["", f"原始 JSON：`{snap_dir / 'snapshot.json'}`", ""]
    return "\n".join(lines)


def main():
    args = sys.argv[1:]
    tag = "snapshot"
    note = ""
    if "--tag" in args:
        tag = args[args.index("--tag") + 1]
    if "--note" in args:
        note = args[args.index("--note") + 1]
    safe_tag = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]+", "_", tag)[:40] or "snapshot"

    out_dir = DIAG_ROOT / f"{now_tag()}_{safe_tag}"
    out_dir.mkdir(parents=True, exist_ok=False)

    print(f"采集状态 …（约 5–15 秒）")
    snap = build_snapshot(tag, note)
    snap["files"] = copy_files(snap, out_dir)

    with open(out_dir / "snapshot.json", "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, indent=2)
    (out_dir / "report.md").write_text(report_markdown(snap, out_dir), encoding="utf-8")

    print(f"\n快照已保存：{out_dir}")
    print(f"  snapshot.json / report.md / files/")
    print(f"\n出故障时再跑一次：python tools\\diag_snapshot.py --tag broken")
    print(f"然后对比：        python tools\\diag_diff.py <正常快照目录> <故障快照目录>")


if __name__ == "__main__":
    main()
