"""
Phone MIDI Controller — PC Bridge
===================================
WebSocket server receiving phone sensor data, applying mappings, outputting MIDI CC.
MIDI via ctypes winmm.dll (Windows). GUI via tkinter.
"""

import asyncio
import ctypes
import json
import math
import os
import socket
import ssl
import sys
import argparse
import logging
import threading
import time
import tkinter as tk
from tkinter import ttk
from ctypes import wintypes
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aiohttp import web

# ── Paths ────────────────────────────────────────────────────────────────────

def _base_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("bridge")

# ── Windows MIDI via ctypes ──────────────────────────────────────────────────

class WinMidiError(Exception): pass

class WinMidi:
    MAXPNAMELEN = 32

    def __init__(self):
        self._winmm = ctypes.windll.winmm
        self._hmo = None
        self._device_id = 0

    @staticmethod
    def count_devices() -> int:
        return ctypes.windll.winmm.midiOutGetNumDevs()

    @staticmethod
    def device_name(device_id: int) -> str:
        class MIDIOUTCAPSW(ctypes.Structure):
            _fields_ = [
                ("wMid", wintypes.WORD), ("wPid", wintypes.WORD),
                ("vDriverVersion", wintypes.DWORD),
                ("szPname", wintypes.WCHAR * WinMidi.MAXPNAMELEN),
                ("wTechnology", wintypes.WORD), ("wVoices", wintypes.WORD),
                ("wNotes", wintypes.WORD), ("wChannelMask", wintypes.WORD),
                ("dwSupport", wintypes.DWORD),
            ]
        caps = MIDIOUTCAPSW()
        r = ctypes.windll.winmm.midiOutGetDevCapsW(wintypes.UINT(device_id), ctypes.byref(caps), ctypes.sizeof(caps))
        if r != 0: raise WinMidiError(f"midiOutGetDevCapsW failed: {r}")
        return caps.szPname

    @staticmethod
    def list_ports() -> list[tuple[int, str]]:
        ports = []
        for i in range(WinMidi.count_devices()):
            try: ports.append((i, WinMidi.device_name(i)))
            except WinMidiError: pass
        return ports

    def open(self, device_id: int | None = None, name: str | None = None):
        ports = self.list_ports()
        if not ports: raise WinMidiError("No MIDI output devices")
        if name is not None:
            for i, n in ports:
                if name.lower() in n.lower(): self._device_id = i; break
            else: raise WinMidiError(f"No device matching '{name}'")
        elif device_id is not None:
            if device_id >= len(ports): raise WinMidiError(f"Device {device_id} out of range")
            self._device_id = device_id
        else:
            filtered = [(i, n) for i, n in ports if "microsoft" not in n.lower() and "wavetable" not in n.lower()]
            self._device_id = filtered[0][0] if filtered else ports[0][0]
        if self._hmo is not None: self.close()
        hmo = wintypes.HANDLE()
        r = self._winmm.midiOutOpen(ctypes.byref(hmo), wintypes.UINT(self._device_id),
                                     wintypes.DWORD(0), wintypes.DWORD(0), wintypes.DWORD(0))
        if r != 0: raise WinMidiError(f"midiOutOpen(device={self._device_id}) failed: {r}")
        self._hmo = hmo

    def send_cc(self, cc: int, channel: int, value: int):
        if self._hmo is None: return
        dw = (value << 16) | (cc << 8) | (0xB0 | (channel & 0x0F))
        self._winmm.midiOutShortMsg(self._hmo, wintypes.DWORD(dw))

    def send_pitch_bend(self, channel: int, value: int):
        """Send Pitch Bend. value 0-16383, center=8192."""
        if self._hmo is None: return
        v = max(0, min(16383, value))
        dw = ((v & 0x7F) << 16) | (((v >> 7) & 0x7F) << 8) | (0xE0 | (channel & 0x0F))
        self._winmm.midiOutShortMsg(self._hmo, wintypes.DWORD(dw))

    def close(self):
        if self._hmo is not None: self._winmm.midiOutClose(self._hmo); self._hmo = None

    @property
    def device_id(self) -> int: return self._device_id

# ── Mapping Engine ──────────────────────────────────────────────────────────

# Axes whose value already *is* the fused scalar t computed on the phone. The Bridge
# must not smooth them again: smoothing belongs to the side that can see the real
# sample rate, and doing both stacks two filters into avoidable latency.
FUSED_AXES = ("fused_lift", "fused_flip", "fused_shake", "fused_vibrato")


def pb_from_norm(norm: float) -> int:
    """Normalised 0..1 → 14-bit pitch bend, exactly centred at 8192.

    The phone mirrors this formula so its on-screen count matches what the DAW receives.
    """
    return max(0, min(16383, 8192 + int(round((norm * 2 - 1) * 8192))))


# ADR 0003: target type used to be inferred from the source coordinates
# (`sensor == "accelerometer" and axis == "x"`). Messages now declare it. The legacy
# inference is kept for one version and announced once, so an old cached page cannot
# silently send pitch bend data to a CC.
_legacy_pb_sniff_warned = False


class EmaSmoother:
    def __init__(self, alpha=0.15): self.alpha = alpha; self.value = None
    def smooth(self, raw):
        self.value = raw if self.value is None else self.alpha * self.value + (1 - self.alpha) * raw
        return self.value
    def reset(self): self.value = None

class MappingEngine:
    def __init__(self, config_path: str):
        self.config_path = config_path
        # utf-8-sig: Windows editors and scripting tools (e.g. PowerShell's
        # Set-Content -Encoding UTF8) happily write a BOM, which plain utf-8 rejects
        # with "Unexpected UTF-8 BOM" and would take the whole bridge down at startup.
        with open(config_path, "r", encoding="utf-8-sig") as f: self.config = json.load(f)
        self.preset_name = self.config.get("preset_name", "unnamed")
        self.mappings = self.config.get("mappings", [])
        self._smoothers: dict[int, EmaSmoother] = {}
        self._last_cc: dict[tuple[int, int], int] = {}
        for i, m in enumerate(self.mappings):
            s = m.get("smoothing", {})
            alpha = s.get("alpha", 0.15) if s.get("type") == "ema" else 0.0
            self._smoothers[i] = EmaSmoother(alpha)
        log.info("Loaded preset '%s' (%d mappings)", self.preset_name, len(self.mappings))

    def update_range(self, in_min, in_max, i=0):
        if i < len(self.mappings): self.mappings[i]["range"]["in_min"] = in_min; self.mappings[i]["range"]["in_max"] = in_max

    def update_target(self, cc, channel, i=0):
        if i < len(self.mappings):
            if cc is not None: self.mappings[i]["target"]["cc"] = cc
            self.mappings[i]["target"]["channel"] = channel
            self._last_cc.clear()

    def update_source(self, sensor, axis, i=0):
        if i < len(self.mappings): self.mappings[i]["source"]["sensor"] = sensor; self.mappings[i]["source"]["axis"] = axis; self._last_cc.clear(); self.reset()

    def process(self, sensor: str, axis: str, value: float, resolution: int = 127,
                kind_override: str | None = None) -> list[tuple[str, int, int, int, float]]:
        """Returns (kind, cc, channel, cc_value, normalised_0_1).

        `kind` is the target type for that mapping: an explicit override from the
        message, else the mapping's `target.type`, else "cc" (ADR 0003).

        `resolution` is the granularity of the change detector and must match what is
        actually transmitted, otherwise a 14-bit pitch bend is silently quantised:
        gating it on the 7-bit CC value yielded only 127 distinct PB values (measured).
        """
        outputs = []
        fused_phone = axis in FUSED_AXES
        for i, m in enumerate(self.mappings):
            if m["source"]["sensor"] != sensor or m["source"]["axis"] != axis: continue
            target = m.get("target", {})
            kind = kind_override or target.get("type", "cc")
            if kind not in ("cc", "pb"): kind = "cc"
            res = 16383 if kind == "pb" else resolution
            smoothed = value if fused_phone else self._smoothers[i].smooth(value)
            cc_val, norm = self._apply_mapping(smoothed, m)
            key = (kind, target.get("cc"), target.get("channel"))
            sent = cc_val if res == 127 else round(norm * res)
            prev = self._last_cc.get(key)
            if prev is None or abs(sent - prev) >= 1:
                self._last_cc[key] = sent
                outputs.append((kind, target.get("cc"), target.get("channel"), cc_val, norm))
        return outputs

    def _apply_mapping(self, value: float, m: dict) -> tuple[int, float]:
        """Maps one input to (cc_value, normalised_0_1).

        The dead zone is anchored at the centre of the input range, which is the
        correct anchor for both semantics: a `bipolar` value (Mode C bend, 0.5 = centre)
        and a `unipolar` midpoint. Phone-side fused axes skip it entirely because the
        phone already applied its own deadband in output-count space.
        """
        r = m.get("range", {}); in_min = r.get("in_min", -90); in_max = r.get("in_max", 90)
        out_min = r.get("out_min", 0); out_max = r.get("out_max", 127)
        axis = m.get("source", {}).get("axis", "")
        fused_phone = axis in FUSED_AXES
        dz = 0.0 if fused_phone else r.get("dead_zone", 0.0)
        center = (in_min + in_max) / 2; half = (in_max - in_min) * dz / 2
        if abs(value - center) <= half: value = center
        value = max(in_min, min(in_max, value))
        denom = in_max - in_min
        if denom == 0: return (out_min + out_max) // 2, 0.5
        n = (value - in_min) / denom
        ct = m.get("curve", {}).get("type", "linear")
        if ct == "reverse": n = 1 - n
        elif ct == "logarithmic": n = 0.0 if n < 0.001 else max(0, min(1, 1 + math.log(n) / math.log(0.01)))
        elif ct == "exponential": n = n * n
        return out_min + round(n * (out_max - out_min)), n

    def reset(self):
        for s in self._smoothers.values(): s.reset()
        self._last_cc.clear()

# ── WebSocket Server ────────────────────────────────────────────────────────

class SensorHandler:
    def __init__(self, engine, midi_out, pb_idle_sec: float = 0.5):
        self.engine = engine; self.midi = midi_out; self._clients = set()
        self.last_cc_output: list[dict] = []  # for GUI status
        # Dead-man timer for pitch bend. A bend is absolute state in the DAW: if the phone
        # stops talking while it is bent (screen lock, WiFi drop, page closed, browser
        # throttling), nothing would ever bring it back to centre. See `pb_watchdog`.
        self.pb_idle_sec = float(pb_idle_sec or 0)
        self._pb_last: dict[int, float] = {}       # channel → monotonic time of the last PB
        self._pb_value: dict[int, int] = {}        # channel → last PB value we sent

    @property
    def client_count(self): return len(self._clients)

    def note_pb(self, channel: int, value: int, now: float | None = None):
        self._pb_last[channel] = time.monotonic() if now is None else now
        self._pb_value[channel] = value

    def pb_needing_centre(self, now: float | None = None) -> list[int]:
        """Channels that are still bent although the phone has gone quiet."""
        if not self.pb_idle_sec: return []
        t = time.monotonic() if now is None else now
        return [ch for ch, last in self._pb_last.items()
                if self._pb_value.get(ch, 8192) != 8192 and (t - last) > self.pb_idle_sec]

    def centre_pb(self, channels: list[int] | None = None) -> list[int]:
        """Sends PB 8192 for the given (or every) bent channel."""
        if channels is None:
            channels = [ch for ch, v in self._pb_value.items() if v != 8192]
        done = []
        for ch in channels:
            try:
                self.midi.send_pitch_bend(ch, 8192)
                self._pb_value[ch] = 8192
                self._pb_last[ch] = time.monotonic()
                done.append(ch)
            except Exception as e:
                log.warning("PB 回中失败 ch %d: %s", ch, e)
        return done

    async def pb_watchdog(self):
        """Centres any channel left bent by a phone that stopped sending."""
        while True:
            await asyncio.sleep(0.1)
            due = self.pb_needing_centre()
            if due:
                done = self.centre_pb(due)
                if done:
                    log.warning("手机超过 %.0f ms 没有发送弯音，把通道 %s 归中（防止 DAW 停在弯音上）",
                                self.pb_idle_sec * 1000, ", ".join(str(c + 1) for c in done))
                    self.last_cc_output = [{"cc": "PB", "channel": c, "value": 8192,
                                            "reason": "idle"} for c in done]

    async def handle(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(); await ws.prepare(request)
        self._clients.add(ws)
        log.info("Phone connected: %s (%d clients)", request.remote, len(self._clients))
        try: await ws.send_json({"type": "config", "config": self.engine.config})
        except Exception: pass
        try:
            async for msg in ws:
                if msg.type == web.WSMsgType.TEXT: await self._process(msg.data, ws)
                elif msg.type == web.WSMsgType.ERROR: log.error("WS error: %s", ws.exception())
        finally:
            self._clients.discard(ws)
            # A disconnect is the loudest "the phone is gone" signal there is.
            gone = self.centre_pb()
            if gone:
                log.warning("手机断开，通道 %s 归中", ", ".join(str(c + 1) for c in gone))
            log.info("Phone disconnected: %s (%d clients)", request.remote, len(self._clients))
        return ws

    async def _process(self, data: str, ws: web.WebSocketResponse):
        try: obj = json.loads(data)
        except (json.JSONDecodeError, ValueError, TypeError): return
        tp = obj.get("type")
        if tp == "set_range":
            self.engine.update_range(float(obj.get("in_min", -90)), float(obj.get("in_max", 90)))
            await ws.send_json({"type": "config", "config": self.engine.config})
        elif tp == "set_target":
            # `cc` may be omitted for pitch-bend targets, which still need a channel.
            cc = obj.get("cc")
            self.engine.update_target(int(cc) if cc is not None else None,
                                      int(obj.get("channel", 0)))
            await ws.send_json({"type": "config", "config": self.engine.config})
        elif tp == "set_source":
            self.engine.update_source(obj.get("sensor", "rotation_vector"), obj.get("axis", "pitch"))
            await ws.send_json({"type": "config", "config": self.engine.config})
        else:
            sensor = obj.get("sensor", "rotation_vector")
            axis = obj.get("axis", "pitch")
            value = float(obj.get("value", 0))
            kind = obj.get("kind")
            if kind not in ("cc", "pb"): kind = None
            if kind is None:
                # ADR 0003 legacy fallback. Remove one version after the web bundle moves
                # past v13, once no cached page can still be talking to us.
                global _legacy_pb_sniff_warned
                if sensor == "accelerometer" and axis == "x":
                    kind = "pb"
                if not _legacy_pb_sniff_warned:
                    _legacy_pb_sniff_warned = True
                    log.warning(
                        "收到不含 kind 的旧版消息（sensor=%s axis=%s）。目标类型应显式声明"
                        "（ADR 0003），未声明时改由配置的 target.type 决定。请刷新手机页面。",
                        sensor, axis)
            cc_list = []
            for out_kind, cc, ch, val, norm in self.engine.process(sensor, axis, value, kind_override=kind):
                if out_kind == "pb":
                    # 14-bit pitch bend straight from the normalised value: exact centre
                    # at 8192, and the reported value is clamped to match what is sent.
                    pb_val = pb_from_norm(norm)
                    self.midi.send_pitch_bend(ch, pb_val)
                    self.note_pb(ch, pb_val)
                    cc_list.append({"cc": "PB", "channel": ch, "value": pb_val})
                else:
                    self.midi.send_cc(cc, ch, val)
                    cc_list.append({"cc": cc, "channel": ch, "value": val})
            if cc_list:
                self.last_cc_output = cc_list
                await ws.send_json({"type": "cc_output", "outputs": cc_list, "raw": value})

# ── HTTP Handlers ───────────────────────────────────────────────────────────

async def handle_status(request):
    h = request.app["handler"]
    return web.json_response({"clients": h.client_count, "preset": request.app["engine"].preset_name})

# ── SSL ─────────────────────────────────────────────────────────────────────

# Falling back to plain HTTP does not merely drop TLS: mobile browsers only expose
# DeviceOrientation/DeviceMotion in a secure context, so the phone app silently
# loses its sensors. Always say so loudly instead of degrading quietly.
_HTTP_SENSOR_WARNING = (
    "无 HTTPS：手机浏览器在非安全上下文中不会提供 DeviceOrientation/DeviceMotion，"
    "启动传感器会失败。请修复证书（可 pip install cryptography 后重试）。"
)

CERT_VALID_DAYS = 365          # lifetime of a freshly generated self-signed cert
CERT_RENEW_BEFORE_DAYS = 30    # renew this early so an expiring cert never breaks the phone

def _outbound_ip():
    """Primary LAN IP, via a UDP socket that never sends a packet."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return None
    finally:
        s.close()

def _local_ips() -> list[str]:
    """All usable local IPv4 addresses, best candidate first.

    Used both for the URL shown in the GUI and for the certificate SAN list, so a
    phone reaching this machine over any of its interfaces still matches the cert.
    """
    seen, out = set(), []
    primary = _outbound_ip()
    if primary and not primary.startswith(("127.", "169.254.")):
        out.append(primary); seen.add(primary)
    try:
        host_ips = socket.gethostbyname_ex(socket.gethostname())[2]
    except Exception:
        host_ips = []
    for ip in host_ips:
        if ip.startswith("127."): continue
        if ip.startswith("169.254."): continue  # APIPA
        if ip.startswith("198.18."): continue   # benchmark/test nets
        if ip in seen: continue
        seen.add(ip); out.append(ip)

    def rank(ip):
        if ip.startswith("192.168."): return 0
        if ip.startswith("10."): return 1
        if ip.startswith("172."):
            parts = ip.split(".")
            if len(parts) == 4 and parts[1].isdigit() and 16 <= int(parts[1]) <= 31: return 2
        return 3
    # Stable sort keeps the outbound IP first among equal-rank candidates.
    out.sort(key=rank)
    return out

def _generate_cert(cert_path, key_path, ips=None):
    """Generate a self-signed cert that modern browsers actually accept.

    A cert with only a commonName and no subjectAltName is rejected outright by
    Chrome/Safari since 2017, so the SAN list (localhost + every local IP) is the
    part that matters here.
    """
    try:
        import ipaddress
        from cryptography import x509
        from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError as e:
        raise RuntimeError(
            "缺少 cryptography，无法生成 HTTPS 证书。请 `pip install cryptography` 后重试，"
            "或把可用的 cert.pem / key.pem 拷入 " + str(cert_path) + " 所在目录。"
        ) from e

    ips = list(ips) if ips else _local_ips()
    san = [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
    for ip in ips:
        try: san.append(x509.IPAddress(ipaddress.ip_address(ip)))
        except ValueError: san.append(x509.DNSName(ip))

    now = datetime.now(timezone.utc)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subj = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Phone MIDI Bridge")])
    cert = (x509.CertificateBuilder()
            .subject_name(subj).issuer_name(subj).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            # Backdate by a day: phone clocks commonly drift ahead of the PC clock,
            # which would otherwise show up as "certificate not yet valid".
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=CERT_VALID_DAYS))
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=True,
                                         content_commitment=False, data_encipherment=False,
                                         key_agreement=False, key_cert_sign=False,
                                         crl_sign=False, encipher_only=False, decipher_only=False),
                           critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .sign(key, hashes.SHA256()))
    with open(key_path, "wb") as f: f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    with open(cert_path, "wb") as f: f.write(cert.public_bytes(serialization.Encoding.PEM))
    return {"ips": ips, "not_after": cert.not_valid_after_utc.isoformat()}

def _inspect_cert(cert_path):
    """Best-effort read of an existing cert, using only the stdlib.

    Returns None when the file cannot be parsed — the caller must then keep the
    existing cert rather than delete it.
    """
    try:
        d = ssl._ssl._test_decode_cert(str(cert_path))
    except Exception:
        return None
    info = {"not_after": d.get("notAfter"), "san": [], "expires_in_days": None}
    for kind, value in d.get("subjectAltName", ()) or ():
        info["san"].append((kind, value))
    try:
        exp = datetime.strptime(d["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
        info["expires_in_days"] = (exp - datetime.now(timezone.utc)).days
    except Exception:
        pass
    return info

def _cert_renew_reason(cp, kp) -> str | None:
    """Why the cert must be (re)generated, or None when it is still good."""
    if not cp.exists() or not kp.exists():
        return "证书文件不存在"
    info = _inspect_cert(cp)
    if info is None:
        return None  # unreadable: keep it, do not risk leaving the server without TLS
    if info["expires_in_days"] is not None and info["expires_in_days"] < CERT_RENEW_BEFORE_DAYS:
        return f"证书将于 {info['not_after']} 过期（仅剩 {info['expires_in_days']} 天）"
    san_ips = {v for k, v in info["san"] if k == "IP Address"}
    if not info["san"]:
        return "证书缺少 subjectAltName（现代浏览器会拒绝，表现为 ERR_CERT_COMMON_NAME_INVALID）"
    ips = _local_ips()
    if ips and ips[0] not in san_ips:
        return f"本机 IP 已变为 {ips[0]}，证书 SAN 未覆盖"
    return None

def _ensure_cert(base_dir):
    if getattr(sys, "frozen", False):
        d = Path(os.environ.get("APPDATA", "")) / "phone-midi-bridge" / "certs"
    else: d = base_dir / ".certs"
    d.mkdir(parents=True, exist_ok=True)
    cp, kp = d / "cert.pem", d / "key.pem"
    reason = _cert_renew_reason(cp, kp)
    if reason:
        log.info("生成 HTTPS 证书：%s", reason)
        try:
            _generate_cert(str(cp), str(kp))
        except Exception as e:
            # Never trade a working (if imperfect) cert for no TLS at all: without
            # HTTPS the phone cannot use its sensors at all.
            if cp.exists() and kp.exists():
                log.warning("证书生成失败，沿用现有证书：%s", e)
            else:
                raise
    return str(cp), str(kp)

def _local_ip():
    """Return best local IP for LAN access. Prefers 192.168.x.x > 10.x.x.x > 172.16-31.x.x."""
    ips = _local_ips()
    return ips[0] if ips else "127.0.0.1"

# ── GUI ─────────────────────────────────────────────────────────────────────
# Industrial: #0B0C0A surface, mono type, #00E676 accent, flat structure

FONT = ("Consolas", 10)
FONT_BOLD = ("Consolas", 10, "bold")
FONT_H1 = ("Microsoft YaHei UI", 16, "bold")
FONT_H2 = ("Consolas", 12, "bold")
FONT_HINT = ("Microsoft YaHei UI", 9)
BG = "#0B0C0A"
SURFACE = "#151613"
BORDER = "#2A2B28"
FG = "#BCC4C0"
FG_DIM = "#5C645E"
GREEN = "#00E676"
AMBER = "#FFB800"
RED = "#FF3B30"

class BridgeApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Phone MIDI Bridge")
        self.root.geometry("480x420")
        self.root.configure(bg=BG)
        self.root.minsize(400, 340)
        self._server_thread = None
        self._stop_event = None
        self._loop = None
        self._midi = None
        self._handler = None
        self._runner = None
        self._status_timer = None
        # Same dead-man timer as the CLI: a phone that goes quiet must not leave the DAW bent.
        self._pb_idle_sec = 0.5
        self._build_setup()

    # ── Setup View ────────────────────────────────────────────────────────
    def _build_setup(self):
        self._clear()
        self._mode = "setup"

        # Header
        tk.Label(self.root, text="手机MIDI推子", font=FONT_H1, bg=BG, fg=GREEN).pack(pady=(20, 4))
        tk.Label(self.root, text="select midi output", font=FONT, bg=BG, fg=FG_DIM).pack(pady=(0, 12))

        # Device list
        list_frame = tk.Frame(self.root, bg=BG, highlightbackground=BORDER, highlightthickness=1)
        list_frame.pack(fill=tk.BOTH, expand=True, padx=20, pady=(0, 8))

        self._tree = ttk.Treeview(list_frame, columns=("name",), show="", selectmode="browse",
                                   style="Devices.Treeview")
        self._tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scroll = ttk.Scrollbar(list_frame, orient=tk.VERTICAL, command=self._tree.yview)
        scroll.pack(side=tk.RIGHT, fill=tk.Y)
        self._tree.configure(yscrollcommand=scroll.set)

        # Populate devices
        ports = WinMidi.list_ports()
        self._port_ids = []
        for pid, pname in ports:
            tag = " *" if "loopmidi" in pname.lower() else ""
            self._tree.insert("", tk.END, values=(pname + tag,))
            self._port_ids.append(pid)
        # Pre-select loopMIDI or first non-MS
        for j, (pid, pname) in enumerate(ports):
            if "loopmidi" in pname.lower():
                self._tree.selection_set(self._tree.get_children()[j]); self._tree.focus(self._tree.get_children()[j]); break
        else:
            for j, (pid, pname) in enumerate(ports):
                if "microsoft" not in pname.lower() and "wavetable" not in pname.lower():
                    self._tree.selection_set(self._tree.get_children()[j]); self._tree.focus(self._tree.get_children()[j]); break

        # Double-click to start
        self._tree.bind("<Double-1>", lambda e: self._on_start())

        # Port entry
        cfg = tk.Frame(self.root, bg=BG)
        cfg.pack(fill=tk.X, padx=20, pady=(4, 0))
        tk.Label(cfg, text="port", font=FONT_BOLD, bg=BG, fg=FG).pack(side=tk.LEFT)
        self._port_var = tk.StringVar(value="8765")
        port_entry = tk.Entry(cfg, textvariable=self._port_var, font=FONT, bg=SURFACE, fg=FG,
                              insertbackground=FG, relief=tk.FLAT, width=6, justify=tk.CENTER,
                              highlightbackground=BORDER, highlightthickness=1)
        port_entry.pack(side=tk.LEFT, padx=(8, 0))

        # Buttons
        btn_frame = tk.Frame(self.root, bg=BG)
        btn_frame.pack(pady=(14, 20))
        self._start_btn = tk.Button(btn_frame, text="START", command=self._on_start,
                                     font=FONT_BOLD, bg=GREEN, fg=BG, activebackground="#00C853",
                                     relief=tk.FLAT, padx=32, pady=6, cursor="hand2", width=10)
        self._start_btn.pack(side=tk.LEFT, padx=6)
        tk.Button(btn_frame, text="QUIT", command=self._on_quit,
                  font=FONT_BOLD, bg=SURFACE, fg=FG_DIM, activebackground="#252525",
                  relief=tk.FLAT, padx=32, pady=6, cursor="hand2", width=10).pack(side=tk.LEFT, padx=6)

        # Author
        tk.Label(self.root, text="Powered by Levi黄", font=("Consolas", 8), bg=BG, fg="#6A6F68", justify="right").place(relx=1.0, rely=1.0, anchor="se", x=-12, y=-8)

    # ── Running View ───────────────────────────────────────────────────────
    def _build_running(self, device_name, port, protocol):
        self._clear()
        self._mode = "running"

        # Header
        tk.Label(self.root, text="手机MIDI推子", font=FONT_H1, bg=BG, fg=GREEN).pack(pady=(20, 4))

        ip = _local_ip()
        url = f"{protocol}://{ip}:{port}"
        tk.Label(self.root, text=url, font=FONT_H2, bg=BG, fg=FG).pack(pady=(0, 2))
        tk.Label(self.root, text="手机用 Chrome 或 Safari 打开上方网址，点击启动传感器", font=FONT_HINT, bg=BG, fg=FG_DIM).pack(pady=(0, 12))
        if protocol == "http":
            tk.Label(self.root, text="⚠ 无 HTTPS：手机传感器将无法启动（见日志）", font=FONT_HINT, bg=BG, fg=AMBER).pack(pady=(0, 8))

        # Status card
        card = tk.Frame(self.root, bg=SURFACE, highlightbackground=BORDER, highlightthickness=1)
        card.pack(fill=tk.X, padx=20, pady=(0, 8))

        self._status_midi = tk.Label(card, text=device_name, font=FONT, bg=SURFACE, fg=GREEN, anchor="w")
        self._status_midi.pack(fill=tk.X, padx=12, pady=(10, 2))
        self._status_clients = tk.Label(card, text="clients: 0", font=FONT, bg=SURFACE, fg=FG, anchor="w")
        self._status_clients.pack(fill=tk.X, padx=12, pady=(0, 2))
        self._status_cc = tk.Label(card, text="cc: --", font=FONT, bg=SURFACE, fg=FG_DIM, anchor="w")
        self._status_cc.pack(fill=tk.X, padx=12, pady=(0, 10))

        # Active indicator
        self._indicator = tk.Canvas(self.root, width=10, height=10, bg=BG, highlightthickness=0)
        self._indicator.pack(pady=(4, 4))
        self._dot = self._indicator.create_oval(0, 0, 10, 10, fill=GREEN, outline="")

        # Stop button
        tk.Button(self.root, text="STOP", command=self._on_stop,
                  font=FONT_BOLD, bg=RED, fg=BG, activebackground="#D32F2F",
                  relief=tk.FLAT, padx=32, pady=6, cursor="hand2", width=10).pack(pady=(12, 20))

        tk.Label(self.root, text="Powered by Levi黄", font=("Consolas", 8), bg=BG, fg="#6A6F68", justify="right").place(relx=1.0, rely=1.0, anchor="se", x=-12, y=-8)

        # Start status polling
        self._status_timer = self.root.after(500, self._poll_status)

    def _poll_status(self):
        if self._mode != "running": return
        if self._handler:
            cc = self._handler.last_cc_output
            n = self._handler.client_count
            self._status_clients.config(text=f"clients: {n}")
            if cc:
                o = cc[0]; self._status_cc.config(text=f"CC{o['cc']} Ch{o['channel']+1} = {o['value']}")
                # Pulse dot
                hue = GREEN if o['value'] > 0 else FG_DIM
                self._indicator.itemconfig(self._dot, fill=hue)
            else: self._status_cc.config(text="cc: --")
        self._status_timer = self.root.after(500, self._poll_status)

    # ── Lifecycle ──────────────────────────────────────────────────────────
    def _clear(self):
        for w in self.root.winfo_children(): w.destroy()
        if self._status_timer: self.root.after_cancel(self._status_timer); self._status_timer = None

    def _on_start(self):
        sel = self._tree.selection()
        if not sel:
            # pick first non-MS
            kids = self._tree.get_children()
            if kids: self._tree.selection_set(kids[0]); sel = [kids[0]]
            else: return
        idx = self._tree.index(sel[0])
        device_id = self._port_ids[idx]
        device_name = self._tree.item(sel[0], "values")[0]
        port = int(self._port_var.get() or "8765")
        self._start_server(device_id, device_name, port)

    def _start_server(self, device_id, device_name, port):
        # Open MIDI
        try:
            self._midi = WinMidi(); self._midi.open(device_id=device_id)
        except WinMidiError as e:
            log.error("MIDI: %s", e); return

        base_dir = _base_dir()
        config_path = base_dir / "config" / "default.json"
        engine = MappingEngine(str(config_path))
        self._handler = SensorHandler(engine, self._midi)

        # SSL
        ssl_context = None; protocol = "http"
        try:
            cp, kp = _ensure_cert(base_dir)
            ssl_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
            ssl_context.load_cert_chain(cp, kp); protocol = "https"
        except Exception as e:
            log.warning("SSL skipped: %s", e)
            log.warning(_HTTP_SENSOR_WARNING)

        # Build app
        app = web.Application()
        app["handler"] = self._handler; app["midi"] = self._midi; app["engine"] = engine
        app.router.add_get("/ws", self._handler.handle)
        app.router.add_get("/status", handle_status)

        web_dir = base_dir / "web"
        if not web_dir.exists(): web_dir = base_dir.parent / "web"
        if web_dir.exists():
            ipath = web_dir / "index.html"
            async def _idx(r): return web.FileResponse(ipath)
            app.router.add_get("/", _idx)
            app.router.add_static("/", web_dir, show_index=False)

        log.info("Starting on %s://0.0.0.0:%d", protocol, port)

        # Server thread
        self._stop_event = threading.Event()
        def _run():
            loop = asyncio.new_event_loop(); asyncio.set_event_loop(loop)
            runner = web.AppRunner(app)
            loop.run_until_complete(runner.setup())
            # Create socket with SO_REUSEADDR to avoid TIME_WAIT sticky port
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("0.0.0.0", port))
            site = web.SockSite(runner, sock, ssl_context=ssl_context)
            loop.run_until_complete(site.start())
            if self._handler and self._handler.pb_idle_sec > 0:
                asyncio.ensure_future(self._handler.pb_watchdog(), loop=loop)
            self._loop = loop; self._runner = runner
            loop.run_forever()
        self._server_thread = threading.Thread(target=_run, daemon=True)
        self._server_thread.start()

        self._build_running(device_name, port, protocol)

    def _on_stop(self):
        if self._loop and self._runner:
            async def _shutdown():
                await self._runner.cleanup()
                for task in asyncio.all_tasks(self._loop): task.cancel()
                self._loop.stop()
            asyncio.run_coroutine_threadsafe(_shutdown(), self._loop)
            self._loop = None; self._runner = None
        if self._midi: self._midi.close(); self._midi = None
        self._handler = None; self._server_thread = None
        self._build_setup()

    def _on_quit(self):
        if self._mode == "running": self._on_stop()
        self.root.destroy()

    def run(self):
        self.root.protocol("WM_DELETE_WINDOW", self._on_quit)
        self.root.mainloop()

# ── CLI / Entry ─────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(description="Phone MIDI Controller Bridge")
    p.add_argument("--list-ports", action="store_true", help="List MIDI ports and exit")
    p.add_argument("--no-gui", action="store_true", help="CLI mode (no GUI)")
    p.add_argument("--midi-device", type=int, default=None)
    p.add_argument("--midi-name", type=str, default=None)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--config", default="config/default.json")
    p.add_argument("--no-ssl", action="store_true")
    p.add_argument("--pb-idle-ms", type=int, default=500,
                   help="手机静默超过这个毫秒数就把仍处于弯音状态的通道归中（0 = 关闭）")
    return p.parse_args()

def _cli_mode(args):
    base_dir = _base_dir()
    config_path = base_dir / args.config
    if not config_path.exists(): log.error("Config not found: %s", config_path); sys.exit(1)
    try:
        midi = WinMidi(); midi.open(device_id=args.midi_device, name=args.midi_name)
        log.info("MIDI: [%d] %s", midi.device_id, WinMidi.device_name(midi.device_id))
    except WinMidiError as e: log.error("MIDI: %s", e); sys.exit(1)

    engine = MappingEngine(str(config_path))
    handler = SensorHandler(engine, midi, pb_idle_sec=args.pb_idle_ms / 1000.0)
    app = web.Application()
    app["handler"] = handler; app["midi"] = midi; app["engine"] = engine
    app.router.add_get("/ws", handler.handle); app.router.add_get("/status", handle_status)

    web_dir = base_dir / "web"
    if not web_dir.exists(): web_dir = base_dir.parent / "web"
    if web_dir.exists():
        ipath = web_dir / "index.html"
        async def _idx(r): return web.FileResponse(ipath)
        app.router.add_get("/", _idx); app.router.add_static("/", web_dir, show_index=False)

    ssl_context = None; protocol = "http"
    if not args.no_ssl:
        try:
            cp, kp = _ensure_cert(base_dir)
            ssl_context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
            ssl_context.load_cert_chain(cp, kp); protocol = "https"
        except Exception as e:
            log.warning("SSL: %s", e)
            log.warning(_HTTP_SENSOR_WARNING)

    log.info("%s://%s:%d", protocol, args.host, args.port)
    if args.pb_idle_ms > 0:
        async def _start_watchdog(_app):
            # Must NOT return the task: aiohttp awaits whatever an on_startup handler
            # returns, so `lambda: ensure_future(...)` would await the infinite watchdog
            # loop and the server would never start serving (found by tests/bridge_boot_check).
            asyncio.ensure_future(handler.pb_watchdog())
        app.on_startup.append(_start_watchdog)
    else:
        log.info("PB 守护已关闭（--pb-idle-ms 0）：手机静默时 DAW 会停在最后的弯音值")
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((args.host, args.port))
        web.run_app(app, sock=sock, ssl_context=ssl_context, print=None)
    except KeyboardInterrupt: log.info("Shutdown")
    finally: midi.close()

def main():
    args = parse_args()
    if args.list_ports:
        ports = WinMidi.list_ports()
        for i, n in ports: print(f"  [{i}] {n}")
        return
    if args.no_gui: _cli_mode(args)
    else: BridgeApp().run()

if __name__ == "__main__": main()
