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
import re
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

    def send_note(self, note: int, channel: int, velocity: int):
        """Note On (velocity > 0) / Note Off (velocity 0). Used by the Shortcut Pad only.

        Notes, not CC: Mode A already sends CC1 on the same port, and a stray CC from the pad
        would move the fader. See docs/adr/0004-midi-note-triggers.md.
        """
        if self._hmo is None: return
        status = (0x90 if velocity > 0 else 0x80) | (channel & 0x0F)
        dw = ((velocity & 0x7F) << 16) | ((note & 0x7F) << 8) | status
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
        # Shortcut Pad: the layout lives here (single source of truth, pushed to every phone)
        # and the held set lets a lost "release" be cleaned up instead of hanging a Note On.
        self.pad_layout = load_pad_layout()
        self._pad_held: dict[int, float] = {}      # trigger id → monotonic time of its Note On

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

    # ── 快捷键面板（Shortcut Pad） ─────────────────────────────────────────────

    def pad_note_on(self, trigger_id: int):
        note = pad_note_for(trigger_id)
        try:
            self.midi.send_note(note, PAD_CHANNEL, 127)
        except Exception as e:
            log.warning("快捷键触发失败（note %d）：%s", note, e)
            return
        self._pad_held[int(trigger_id)] = time.monotonic()
        self.last_cc_output = [{"cc": "N%d" % note, "channel": PAD_CHANNEL, "value": 127}]

    def pad_note_off(self, trigger_id: int) -> bool:
        """Send the matching Note Off. Returns whether a Note On was actually open."""
        tid = int(trigger_id)
        if tid not in self._pad_held: return False
        del self._pad_held[tid]
        try: self.midi.send_note(pad_note_for(tid), PAD_CHANNEL, 0)
        except Exception as e: log.warning("快捷键松开失败（note %d）：%s", pad_note_for(tid), e)
        return True

    def pad_held_expired(self, now: float | None = None) -> list[int]:
        t = time.monotonic() if now is None else now
        return [tid for tid, at in self._pad_held.items() if t - at > PAD_HOLD_GUARD_SEC]

    async def pad_watchdog(self):
        """Release triggers whose 'up' never arrived (page closed, WiFi drop, tab killed).

        Same failure class as the pitch-bend dead-man timer: the phone can vanish mid-press and
        nothing else would ever close that Note.
        """
        while True:
            await asyncio.sleep(0.1)
            for tid in self.pad_held_expired():
                if self.pad_note_off(tid):
                    log.info("快捷键触发 %d 超过 %.0f ms 没收到松开，补发 Note Off",
                             tid, PAD_HOLD_GUARD_SEC * 1000)

    def release_all_triggers(self):
        for tid in list(self._pad_held): self.pad_note_off(tid)

    async def _on_trigger(self, obj: dict):
        trigger_id = obj.get("id")
        if not pad_trigger_valid(trigger_id):
            log.warning("忽略越界的触发编号：%r（有效范围 0-%d）", trigger_id, pad_trigger_count() - 1)
            return
        trigger_id = int(trigger_id)
        if str(obj.get("phase", "down")).lower() == "up":
            self.pad_note_off(trigger_id)
        else:
            self.pad_note_on(trigger_id)

    def set_pad_layout(self, layout) -> dict:
        """Validate, persist and return the layout. Persisting does not need the server running."""
        self.pad_layout = save_pad_layout(layout)
        return self.pad_layout

    async def broadcast_pad_layout(self):
        """Push the layout to every connected phone; a phone that is away gets it on connect."""
        payload = {"type": "pad_layout", "layout": self.pad_layout}
        for client in list(self._clients):
            try: await client.send_json(payload)
            except Exception: pass

    async def handle(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(); await ws.prepare(request)
        self._clients.add(ws)
        log.info("Phone connected: %s (%d clients)", request.remote, len(self._clients))
        try: await ws.send_json({"type": "config", "config": self.engine.config})
        except Exception: pass
        # The pad page is useless without a layout, so it is pushed before anything else happens.
        try: await ws.send_json({"type": "pad_layout", "layout": self.pad_layout})
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
            self.release_all_triggers()
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
        elif obj.get("kind") == "trigger":
            # Shortcut Pad: a discrete trigger, not a value. It never touches the mapping engine
            # (no range, no curve, no smoothing) — it becomes one MIDI Note (ADR 0004).
            await self._on_trigger(obj)
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

# 窗口尺寸的持久化。
# 只记**精简模式**的尺寸与位置：它是放在 DAW 角落里的监看窗，位置必须稳定；标准窗口每次
# 回到默认位置（居中）即可，用户明确要求不要记忆它。
WINDOW_PREFS = Path(os.environ.get("APPDATA") or os.path.expanduser("~")) / "phone-midi-bridge" / "window.json"

def load_window_prefs() -> dict:
    try:
        with open(WINDOW_PREFS, "r", encoding="utf-8") as f:
            data = json.load(f)
        out = {}
        for key in ("compact", "compact_pos"):
            v = data.get(key)
            if isinstance(v, list) and len(v) == 2 and all(isinstance(n, (int, float)) for n in v):
                out[key] = [int(v[0]), int(v[1])]
        return out
    except Exception:
        return {}

def save_window_prefs(prefs: dict):
    """Best effort: a window that cannot remember its size must still close normally."""
    try:
        WINDOW_PREFS.parent.mkdir(parents=True, exist_ok=True)
        with open(WINDOW_PREFS, "w", encoding="utf-8") as f:
            json.dump(prefs, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log.warning("保存窗口尺寸失败：%s", e)

# ── 快捷键面板（Shortcut Pad） ────────────────────────────────────────────────
# 手机只发一个触发编号；Bridge 把它变成一条 MIDI Note（通道 16、音符 36 + 编号）。
# "这个编号 = 哪个宏"由 DAW 侧的 MIDI Remote 决定——Bridge 不认识宏，也不做复合动作。
# 布局由 Bridge 拥有并下发给手机（Layout Push），用户配置在 PC 端完成。
# 设计与取舍：docs/spec/shortcut-pad.md、docs/adr/0004-midi-note-triggers.md
PAD_PREFS = Path(os.environ.get("APPDATA") or os.path.expanduser("~")) / "phone-midi-bridge" / "pad.json"
PAD_SLOTS = 8                 # 4 列 × 2 行，固定；PC 编辑器镜像同一套格子
PAD_PAGES_MAX = 8
PAD_NOTE_BASE = 36            # 触发编号 0 → 音符 36
PAD_CHANNEL = 15              # 0-based，即 MIDI 通道 16；与推子所在通道分开，便于 DAW 侧过滤
PAD_HOLD_GUARD_SEC = 1.0      # 手机丢了"松开"事件时的兜底，思路同 pb_watchdog
PAD_DEFAULT_TITLE = "快捷键面板"
PAD_TEXT_MAX = 24
# 固定调色板：全部是深色，白字可读。颜色无语义，纯粹为了一眼认出功能（spec D11）。
PAD_COLORS = ("#1e293b", "#1d4ed8", "#0e7490", "#15803d",
              "#b45309", "#b91c1c", "#6d28d9", "#9d174d")

def pad_trigger_count() -> int:
    return PAD_SLOTS * PAD_PAGES_MAX

def pad_note_for(trigger_id: int) -> int:
    return PAD_NOTE_BASE + int(trigger_id)

def pad_trigger_valid(trigger_id) -> bool:
    try: i = int(trigger_id)
    except (TypeError, ValueError): return False
    return 0 <= i < pad_trigger_count()

def default_pad_layout() -> dict:
    return {"version": 1, "pages": [{
        "title": PAD_DEFAULT_TITLE,
        "cells": [{"text": "宏 %d" % (i + 1), "color": PAD_COLORS[0]} for i in range(PAD_SLOTS)],
    }]}

def _pad_clean_cell(cell) -> dict:
    out = {"text": "", "color": PAD_COLORS[0]}
    if isinstance(cell, dict):
        text = cell.get("text")
        if isinstance(text, str): out["text"] = text[:PAD_TEXT_MAX]
        color = cell.get("color")
        if isinstance(color, str) and color in PAD_COLORS: out["color"] = color
    return out

def pad_clean_layout(layout) -> dict:
    """Keep only the shape the phone renders; anything unexpected falls back to the default.

    A hand-edited or corrupted pad.json must degrade to a working pad, never to a blank screen
    the user cannot press (that is the same reasoning behind load_window_prefs).
    """
    pages = []
    if isinstance(layout, dict) and isinstance(layout.get("pages"), list):
        for page in layout["pages"][:PAD_PAGES_MAX]:
            if not isinstance(page, dict): continue
            title = page.get("title")
            cells = page.get("cells")
            pages.append({
                "title": title[:PAD_TEXT_MAX] if isinstance(title, str) and title else PAD_DEFAULT_TITLE,
                "cells": [_pad_clean_cell(c) for c in (cells if isinstance(cells, list) else [])][:PAD_SLOTS],
            })
    if not pages: return default_pad_layout()
    # Pad every page out to a full 4×2 grid so the phone always renders the same shape.
    for page in pages:
        while len(page["cells"]) < PAD_SLOTS: page["cells"].append(_pad_clean_cell(None))
    return {"version": 1, "pages": pages}

def load_pad_layout() -> dict:
    try:
        with open(PAD_PREFS, "r", encoding="utf-8") as f:
            return pad_clean_layout(json.load(f))
    except FileNotFoundError:
        return default_pad_layout()
    except Exception as e:
        log.warning("读取快捷键面板布局失败，改用默认布局：%s", e)
        return default_pad_layout()

def save_pad_layout(layout) -> dict:
    """Best effort, like window prefs: a pad that cannot save must still work this session."""
    clean = pad_clean_layout(layout)
    try:
        PAD_PREFS.parent.mkdir(parents=True, exist_ok=True)
        with open(PAD_PREFS, "w", encoding="utf-8") as f:
            json.dump(clean, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log.warning("保存快捷键面板布局失败：%s", e)
    return clean

def _port_in_use(host: str, port: int) -> bool:
    """Is something already listening there? (Cheap TCP connect on the phone's own port.)"""
    probe_host = "127.0.0.1" if host in ("0.0.0.0", "") else host
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.6)
            return s.connect_ex((probe_host, port)) == 0
    except OSError:
        return False

def bind_server_socket(host: str, port: int, backlog: int = 128):
    """Bind the listening socket, balancing two Windows behaviours that pull opposite ways.

    1. `SO_REUSEADDR` on Windows does **not** mean "reuse an address in TIME_WAIT" the way it
       does on Unix: it lets a *second* process bind the same address, and connections are then
       handed to an arbitrary one of the two. That is how a leftover Bridge keeps serving while
       a freshly started one shows a URL and "running" with zero clients — the phone connects to
       the *old* process. So the first choice is the exclusive flag (set before bind).
    2. But `SO_EXCLUSIVEADDRUSE` also refuses a port that *lingering connections* still hold in
       TIME_WAIT — exactly what a stop/start cycle leaves behind (the server closes the phone's
       socket first), so the next START failed with "port in use" for minutes.

    Resolution: check whether somebody is actually *listening* first (that is the case worth
    refusing). Nobody listening + exclusive bind fails ⇒ it is only TIME_WAIT ⇒ bind with
    SO_REUSEADDR so an immediate restart works.

    Raises OSError; the message says which of the two cases it was.
    """
    if _port_in_use(host, port):
        raise OSError(f"端口 {port} 已被占用：已经有一个 Bridge 在监听（手机的连接会进那一个）")

    exclusive = hasattr(socket, "SO_EXCLUSIVEADDRUSE")
    opts = [socket.SO_EXCLUSIVEADDRUSE, socket.SO_REUSEADDR] if exclusive else [socket.SO_REUSEADDR]
    last = None
    for opt in opts:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.setsockopt(socket.SOL_SOCKET, opt, 1)
            s.bind((host, port)); s.listen(backlog)
            return s
        except OSError as e:
            last = e
            s.close()
            # Only fall through to the reuse flag when nobody is listening: that means the
            # port is merely held by connections in TIME_WAIT from a previous stop.
            if _port_in_use(host, port):
                raise OSError(f"端口 {port} 已被占用：已经有一个 Bridge 在监听（手机的连接会进那一个）")
    raise last

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
FONT_MONO_MID = ("Consolas", 18, "bold")   # 精简模式的值，够大又省高度
# 精简模式：细长条。默认高度按内容给足（值那一行 + 细进度条 + 留白），下限比默认再矮一点，
# 这样"再压矮一点"是用户自己能拖的事，不必改代码。
COMPACT_MIN_W, COMPACT_MIN_H = 420, 84
COMPACT_DEF_H = 108
COMPACT_BAR_H = 26          # 固定厚度：不再随窗口高度撑满（原先 150 高的窗口里约 78 px）

class BridgeApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Phone MIDI Bridge")
        self._win_size = (480, 420)
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
        self._sock = None
        self._busy = None            # 'start' | 'stop' while a worker is doing the work
        self._start_result = None
        self._stop_done = False
        self._ssl_pair = None        # TLS context is built once per run, not per START
        self._win_prefs = load_window_prefs()   # sizes remembered from the last run
        # Same dead-man timer as the CLI: a phone that goes quiet must not leave the DAW bent.
        self._pb_idle_sec = 0.5
        # 精简模式（置顶，只看当前值与进度条）。尺寸只在本次运行内记住，不落盘。
        self._compact = False
        self._compact_geom = None
        # 快捷键面板：PC 端镜像 + 编辑器。布局由这里拥有（编辑不必先启动服务器）。
        self._pad_layout = load_pad_layout()
        self._pad_win = None
        self._pad_body = None
        self._pad_page = 0
        self._pad_sel = None
        self._pad_cells = []
        self._pad_tab_btns = []
        self._pad_swatches = []
        self._pad_save_timer = None
        self._pad_confirm_delete = False
        self._build_setup()

    # ── Setup View ────────────────────────────────────────────────────────
    def _build_setup(self):
        self._clear()
        self._mode = "setup"
        self.root.overrideredirect(False)
        self.root.title("手机推子 · Phone MIDI Bridge")
        self.root.attributes("-topmost", False)
        self.root.minsize(400, 340)
        self._set_geometry(self._default_spec(480, 420))

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

        # 后台工作的提示（启动/停止不再卡住窗口，所以要说一句在做什么）
        self._busy_lbl = tk.Label(self.root, text="", font=FONT_HINT, bg=BG, fg=AMBER)
        self._busy_lbl.pack(pady=(0, 6))

        # Author
        tk.Label(self.root, text="Powered by Levi黄", font=("Consolas", 8), bg=BG, fg="#6A6F68", justify="right").place(relx=1.0, rely=1.0, anchor="se", x=-12, y=-8)

    # ── Running View ───────────────────────────────────────────────────────
    def _build_running(self, device_name, port, protocol):
        self._clear()
        self._mode = "running"
        self._device_name, self._port, self._protocol = device_name, port, protocol
        compact = self._compact

        if compact:
            # 精简模式：只看当前值与进度条；无标题栏、置顶、可拖动、右下角可拉伸。
            self.root.title("手机推子 · 精简")
            self.root.overrideredirect(True)          # 去掉标题栏
            self.root.attributes("-topmost", True)    # 否则会被 DAW 盖住
            # The expanded view sets minsize(400, 340); leaving it in place silently clamped
            # the compact height to 340 (measured on the user's screen as a 630x510 window
            # instead of a 420x150 bar). Minimum and default must move together.
            self.root.minsize(COMPACT_MIN_W, COMPACT_MIN_H)
            self._set_geometry(self._compact_spec())

            body = tk.Frame(self.root, bg=BG, highlightbackground=BORDER, highlightthickness=1)
            body.pack(fill=tk.BOTH, expand=True)

            top = tk.Frame(body, bg=BG)
            top.pack(fill=tk.X, padx=10, pady=(6, 0))
            self._mon_value = tk.Label(top, text="—", font=FONT_MONO_MID, bg=BG, fg=FG)
            self._mon_value.pack(side=tk.LEFT)
            self._mon_back = tk.Label(top, text="展开", font=FONT_HINT, bg=SURFACE, fg=FG_DIM,
                                      padx=8, pady=2, cursor="hand2",
                                      highlightbackground=BORDER, highlightthickness=1)
            self._mon_back.pack(side=tk.RIGHT)
            self._mon_back.bind("<Button-1>", lambda _e: self._toggle_compact())

            # 进度条是固定厚度的细条（不随窗口高度撑满）：原先它吃掉剩余空间，150 高的窗口里
            # 有 ~78 px 厚。剩下的高度留白，拉伸窗口不会把条变粗。
            self._bar = tk.Canvas(body, bg=SURFACE, highlightthickness=0, width=1,
                                  height=COMPACT_BAR_H)
            self._bar.pack(fill=tk.X, padx=10, pady=(3, 6))
            self._bar_bg = self._bar.create_rectangle(0, 0, 0, 0, fill="#1E211D", outline="")
            self._bar_fill = self._bar.create_rectangle(0, 0, 0, 0, fill=GREEN, outline="")
            self._bar_mid = self._bar.create_line(0, 0, 0, 0, fill=FG_DIM, width=1)
            self._bar.bind("<Configure>", lambda _e: self._draw_bar(*self._bar_args))
            self._bar_args = (None, "cc")
            tk.Frame(body, bg=BG).pack(fill=tk.BOTH, expand=True)   # 多余高度留白

            # 没有标题栏就得自己实现拖动与拉伸
            grip = tk.Label(body, text="◢", font=("Consolas", 9), bg=BG, fg=FG_DIM, cursor="size_nw_se")
            grip.place(relx=1.0, rely=1.0, anchor="se")
            for widget in (body, top, self._mon_value, self._bar):
                widget.bind("<Button-1>", self._drag_start)
                widget.bind("<B1-Motion>", self._drag_move)
            grip.bind("<Button-1>", self._resize_start)
            grip.bind("<B1-Motion>", self._resize_move)

            # The widgets decide the window size when it is overrideredirect (no window manager
            # to argue with) — a bare tk.Canvas alone asks for ~378x265, which is exactly why
            # the window once came out taller than requested. The bar is now a fixed thin
            # canvas and the requested geometry is re-applied as the last word.
            self.root.update_idletasks()
            self._set_geometry(self._compact_spec())

            self._status_timer = self.root.after(50, self._poll_status)
            return

        self.root.overrideredirect(False)
        self.root.title("手机推子 · Phone MIDI Bridge")
        self.root.minsize(400, 340)
        self.root.attributes("-topmost", False)
        # 展开态恢复上次关闭时的尺寸（没有记录过就还是原来的 480x420）
        self._set_geometry(self._default_spec(480, 420))

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

        # 精简模式：只显示当前值 + 进度条，置顶，方便放在 DAW 角落观察
        tk.Button(self.root, text="精简模式（置顶）", command=self._toggle_compact,
                  font=FONT, bg=SURFACE, fg=FG, activebackground=BORDER,
                  relief=tk.FLAT, padx=14, pady=4, cursor="hand2").pack(pady=(4, 0))

        # 快捷键面板：PC 端镜像手机上的按钮阵列并可编辑（改完即时同步）
        self._pad_btn = tk.Button(self.root, text="快捷键面板…", command=self._open_pad_editor,
                                  font=FONT, bg=SURFACE, fg=FG, activebackground=BORDER,
                                  relief=tk.FLAT, padx=14, pady=4, cursor="hand2")
        self._pad_btn.pack(pady=(6, 0))

        # Stop button
        self._stop_btn = tk.Button(self.root, text="STOP", command=self._on_stop,
                                   font=FONT_BOLD, bg=RED, fg=BG, activebackground="#D32F2F",
                                   relief=tk.FLAT, padx=32, pady=6, cursor="hand2", width=10)
        self._stop_btn.pack(pady=(10, 20))

        tk.Label(self.root, text="Powered by Levi黄", font=("Consolas", 8), bg=BG, fg="#6A6F68", justify="right").place(relx=1.0, rely=1.0, anchor="se", x=-12, y=-8)

        # Start status polling
        self._status_timer = self.root.after(500, self._poll_status)

    def _toggle_compact(self):
        if self._compact:
            self._compact_geom = self.root.geometry()   # 尺寸 + 位置，退出时落盘
        self._compact = not self._compact
        if self._mode == "running":
            self._build_running(self._device_name, self._port, self._protocol)
        else:
            self._build_setup()

    # ── 无标题栏窗口的拖动与拉伸 ──────────────────────────────────────────────
    def _set_geometry(self, spec: str):
        """Apply a geometry spec and remember the requested size/position.

        Tk's own geometry()/winfo_* only report the truth once a window has been mapped,
        which it deliberately is not during the automated checks — so keep the values we asked
        for as well, and let the checks assert on those.
        """
        self.root.geometry(spec)
        m = re.match(r"(\d+)x(\d+)(?:\+(-?\d+)\+(-?\d+))?", spec)
        if m:
            self._win_size = (int(m.group(1)), int(m.group(2)))
            if m.group(3) is not None:
                self._win_pos = (int(m.group(3)), int(m.group(4)))

    def _fit_wh(self, size, min_w, min_h):
        """Clamp a remembered size so it still fits the screen and the mode's minimum."""
        try:
            w, h = int(size[0]), int(size[1])
        except (TypeError, ValueError, IndexError):
            w, h = min_w, min_h
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        return max(min_w, min(w, sw)), max(min_h, min(h, sh))

    def _fit(self, size, min_w, min_h) -> str:
        w, h = self._fit_wh(size, min_w, min_h)
        return f"{w}x{h}"

    def _screen(self):
        return self.root.winfo_screenwidth(), self.root.winfo_screenheight()

    def _default_spec(self, w: int, h: int) -> str:
        """标准窗口的默认位置：屏幕居中（每次打开都回到这里，不记忆）。"""
        sw, sh = self._screen()
        return f"{w}x{h}+{max(0, (sw - w) // 2)}+{max(0, (sh - h) // 2)}"

    def _clamp_pos(self, pos, w, h):
        """Keep the whole compact window on screen (换显示器/分辨率后不会丢)。"""
        sw, sh = self._screen()
        try:
            x, y = int(pos[0]), int(pos[1])
        except (TypeError, ValueError, IndexError):
            return max(0, (sw - w) // 2), max(0, (sh - h) // 2)
        return max(0, min(x, max(0, sw - w))), max(0, min(y, max(0, sh - h)))

    def _compact_spec(self) -> str:
        """精简窗口：尺寸与位置都沿用上次关闭时的值（可以与标准窗口不同）。"""
        w, h = self._fit_wh(self._compact_geom_size() or self._win_prefs.get("compact")
                            or [COMPACT_MIN_W, COMPACT_DEF_H], COMPACT_MIN_W, COMPACT_MIN_H)
        pos = self._win_prefs.get("compact_pos")
        x, y = self._clamp_pos(pos, w, h) if pos else self._clamp_pos(None, w, h)
        return f"{w}x{h}+{x}+{y}"

    def _compact_geom_size(self):
        m = re.match(r"(\d+)x(\d+)", getattr(self, "_compact_geom", "") or "")
        return [int(m.group(1)), int(m.group(2))] if m else None

    def _capture_window(self):
        """Record the compact window's size and position on the way out.

        The standard window is deliberately *not* recorded: it always opens at its default
        position. Called before any teardown, because stopping the server rebuilds the setup
        view and would throw the compact geometry away.
        """
        try:
            if self._compact:
                w, h = self.root.winfo_width(), self.root.winfo_height()
                if w > 1 and h > 1:                   # 1x1 = 未映射
                    self._win_prefs["compact"] = [w, h]
                    self._win_prefs["compact_pos"] = [self.root.winfo_x(), self.root.winfo_y()]
            m = re.match(r"(\d+)x(\d+)\+(-?\d+)\+(-?\d+)", getattr(self, "_compact_geom", "") or "")
            if m:
                self._win_prefs["compact"] = [int(m.group(1)), int(m.group(2))]
                self._win_prefs["compact_pos"] = [int(m.group(3)), int(m.group(4))]
            save_window_prefs(self._win_prefs)
        except Exception as e:
            log.warning("记录窗口位置失败：%s", e)

    def _window_xy(self):
        """Current window origin. Read from the geometry string (what we last requested), not
        winfo_x/y: the two disagree until the window is actually mapped, and the drag maths must
        agree with what the geometry says or the window jumps on the first move."""
        m = re.search(r"\+(-?\d+)\+(-?\d+)", self.root.geometry())
        if m:
            return int(m.group(1)), int(m.group(2))
        return self.root.winfo_x(), self.root.winfo_y()

    def _drag_start(self, event):
        x, y = self._window_xy()
        self._drag_origin = (event.x_root - x, event.y_root - y)

    def _drag_move(self, event):
        if not getattr(self, "_drag_origin", None): return
        dx, dy = self._drag_origin
        self.root.geometry(f"+{event.x_root - dx}+{event.y_root - dy}")

    def _resize_start(self, event):
        self._resize_origin = (event.x_root, event.y_root,
                               self.root.winfo_width(), self.root.winfo_height())

    def _resize_move(self, event):
        if not getattr(self, "_resize_origin", None): return
        x0, y0, w0, h0 = self._resize_origin
        w = max(COMPACT_MIN_W, w0 + (event.x_root - x0))
        h = max(COMPACT_MIN_H, h0 + (event.y_root - y0))
        self._set_geometry(f"{w}x{h}")

    @staticmethod
    def _value_text(out, connected: bool) -> str:
        if not connected: return "—"
        if not out: return "—"
        o = out[0]
        return f"PB {o['value']}" if o["cc"] == "PB" else f"CC{o['cc']} {o['value']}"

    @staticmethod
    def _bar_norm(out):
        """Progress position from the mapped output alone: CC over its 0–127 range, pitch
        bend around the centre of 14-bit space. No extra protocol field needed."""
        if not out: return None, "cc"
        o = out[0]
        if o["cc"] == "PB":
            return (o["value"] / 16383.0), "pb"
        return (o["value"] / 127.0), "cc"

    def _draw_bar(self, norm, kind):
        w = max(1, self._bar.winfo_width()); h = max(1, self._bar.winfo_height())
        self._bar.coords(self._bar_bg, 0, 0, w, h)
        if norm is None:
            self._bar.coords(self._bar_fill, 0, 0, 0, 0)
            self._bar.itemconfigure(self._bar_mid, state="hidden")
            return
        if kind == "pb":
            mid = w / 2.0
            x = mid + (norm - 0.5) * w
            self._bar.coords(self._bar_fill, min(mid, x), 0, max(mid, x), h)
            self._bar.coords(self._bar_mid, mid, 0, mid, h)
            self._bar.itemconfigure(self._bar_mid, state="normal")
        else:
            self._bar.coords(self._bar_fill, 0, 0, norm * w, h)
            self._bar.itemconfigure(self._bar_mid, state="hidden")

    # ── 快捷键面板编辑器（Layout Push 的写入端） ────────────────────────────
    #
    # 与精简监视窗同一思路：把手机上的东西在 PC 上镜像出来，只是这里可编辑——点格子改文字/
    # 颜色，改完立刻落盘并广播给已连接的手机。用独立 Toplevel，因此主窗的几何契约（标准窗
    # 固定 480×420 且不记忆位置、精简窗记忆尺寸与位置）一点都没被碰到。
    # 设计：docs/spec/shortcut-pad.md（D7/D8）；协议：Bridge → 手机 `{"type": "pad_layout"}`。

    def _open_pad_editor(self):
        if self._pad_win is not None:
            try:
                self._pad_win.deiconify(); self._pad_win.lift(); self._pad_win.focus_set()
                return
            except tk.TclError:
                self._pad_win = None
        win = tk.Toplevel(self.root)
        self._pad_win = win
        win.title("快捷键面板 · 编辑")
        win.configure(bg=BG)
        win.geometry("600x600")
        win.minsize(520, 520)
        win.protocol("WM_DELETE_WINDOW", self._close_pad_editor)
        self._pad_body = tk.Frame(win, bg=BG)
        self._pad_body.pack(fill=tk.BOTH, expand=True)
        self._pad_render()

    def _close_pad_editor(self):
        if self._pad_save_timer:
            self.root.after_cancel(self._pad_save_timer); self._pad_save_timer = None
        if self._pad_win is not None:
            try: self._pad_win.destroy()
            except tk.TclError: pass
        self._pad_win = None
        self._pad_cells = []
        self._pad_tab_btns = []
        self._pad_swatches = []

    def _pad_pages(self):
        pages = self._pad_layout.get("pages")
        if not isinstance(pages, list) or not pages:
            pages = default_pad_layout()["pages"]
            self._pad_layout = {"version": 1, "pages": pages}
        if not 0 <= self._pad_page < len(pages): self._pad_page = 0
        return pages

    def _pad_page_data(self):
        return self._pad_pages()[self._pad_page]

    def _pad_cell(self, slot):
        cells = self._pad_page_data().get("cells")
        if not isinstance(cells, list): return None
        return cells[slot] if slot < len(cells) else None

    def _pad_render(self):
        """Full rebuild: page tabs, page title, the 4×2 grid and the cell editor."""
        if self._pad_win is None: return
        for w in self._pad_body.winfo_children(): w.destroy()
        self._pad_cells, self._pad_tab_btns, self._pad_swatches = [], [], []
        pages = self._pad_pages()

        tk.Label(self._pad_body, text="快捷键面板", font=FONT_H1, bg=BG, fg=GREEN).pack(pady=(14, 2))
        tk.Label(self._pad_body,
                 text="改完即时同步到手机。格子上 N36… 就是要在 Nuendo 的映射助手里学习的那条 Note",
                 font=FONT_HINT, bg=BG, fg=FG_DIM).pack(pady=(0, 8))

        # 页签：与手机底部的页签一一对应
        tabs = tk.Frame(self._pad_body, bg=BG)
        tabs.pack(fill=tk.X, padx=16)
        for i in range(len(pages)):
            b = tk.Button(tabs, font=FONT_HINT, relief=tk.FLAT, padx=10, pady=3, cursor="hand2",
                          command=lambda idx=i: self._pad_goto(idx))
            b.pack(side=tk.LEFT, padx=(0, 4))
            self._pad_tab_btns.append(b)
        tk.Button(tabs, text="＋ 加页", font=FONT_HINT, relief=tk.FLAT, padx=8, pady=3,
                  cursor="hand2", bg=SURFACE, fg=FG_DIM,
                  command=self._pad_add_page).pack(side=tk.LEFT, padx=(10, 4))
        if len(pages) > 1:
            tk.Button(tabs, text="删除本页", font=FONT_HINT, relief=tk.FLAT, padx=8, pady=3,
                      cursor="hand2", bg=SURFACE, fg=FG_DIM,
                      command=self._pad_del_page).pack(side=tk.LEFT)

        # 页标题：手机上那一行大标题
        row = tk.Frame(self._pad_body, bg=BG)
        row.pack(fill=tk.X, padx=16, pady=(10, 0))
        tk.Label(row, text="页标题", font=FONT_HINT, bg=BG, fg=FG_DIM).pack(side=tk.LEFT)
        self._pad_title_var = tk.StringVar(value=self._pad_page_data().get("title") or "")
        title_entry = tk.Entry(row, textvariable=self._pad_title_var, font=FONT, bg=SURFACE, fg=FG,
                               insertbackground=FG, relief=tk.FLAT)
        title_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(8, 0), ipady=3)
        title_entry.bind("<KeyRelease>", lambda _e: self._pad_edit_title())

        # 4×2 网格：与手机严格同构（4 列 2 行，行优先就是编号顺序）
        grid = tk.Frame(self._pad_body, bg=BG)
        grid.pack(fill=tk.BOTH, expand=True, padx=16, pady=12)
        for r in range(2): grid.rowconfigure(r, weight=1)
        for c in range(4): grid.columnconfigure(c, weight=1)
        for slot in range(PAD_SLOTS):
            frame = tk.Frame(grid, bg=PAD_COLORS[0], highlightthickness=2,
                             highlightbackground=BG, cursor="hand2")
            frame.grid(row=slot // 4, column=slot % 4, sticky="nsew", padx=3, pady=3)
            label = tk.Label(frame, text="", font=FONT_BOLD, bg=PAD_COLORS[0], fg="#FFFFFF",
                             wraplength=110, justify="center")
            label.pack(fill=tk.BOTH, expand=True, padx=6, pady=(8, 0))
            note = tk.Label(frame, text="", font=("Consolas", 8), bg=PAD_COLORS[0], fg="#C8CDD6")
            note.pack(side=tk.BOTTOM, anchor="e", padx=6, pady=(0, 4))
            for w in (frame, label, note):
                w.bind("<Button-1>", lambda _e, s=slot: self._pad_select(s))
            self._pad_cells.append({"frame": frame, "label": label, "note": note})

        # 选中格子：文字 + 固定调色板（不用系统取色器：模态弹窗，而且容易选到看不清的颜色）
        edit = tk.Frame(self._pad_body, bg=BG)
        edit.pack(fill=tk.X, padx=16)
        tk.Label(edit, text="按钮文字", font=FONT_HINT, bg=BG, fg=FG_DIM).pack(side=tk.LEFT)
        self._pad_text_var = tk.StringVar()
        self._pad_entry = tk.Entry(edit, textvariable=self._pad_text_var, font=FONT, bg=SURFACE,
                                   fg=FG, insertbackground=FG, relief=tk.FLAT, state=tk.DISABLED)
        self._pad_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(8, 0), ipady=3)
        self._pad_entry.bind("<KeyRelease>", lambda _e: self._pad_edit_text())

        pal = tk.Frame(self._pad_body, bg=BG)
        pal.pack(fill=tk.X, padx=16, pady=(10, 4))
        tk.Label(pal, text="颜色", font=FONT_HINT, bg=BG, fg=FG_DIM).pack(side=tk.LEFT, padx=(0, 8))
        for color in PAD_COLORS:
            sw = tk.Frame(pal, bg=color, width=34, height=22, highlightthickness=2,
                          highlightbackground=BG, cursor="hand2")
            sw.pack(side=tk.LEFT, padx=2); sw.pack_propagate(False)
            sw.bind("<Button-1>", lambda _e, c=color: self._pad_set_color(c))
            self._pad_swatches.append(sw)

        self._pad_status_lbl = tk.Label(self._pad_body, text="", font=FONT_HINT, bg=BG, fg=AMBER)
        self._pad_status_lbl.pack(pady=(0, 10))

        self._pad_redraw()

    def _pad_redraw(self):
        """In-place refresh: safe while typing, because it never recreates widgets."""
        if self._pad_win is None: return
        page = self._pad_page_data()
        cells = page.get("cells") if isinstance(page.get("cells"), list) else []
        for i, b in enumerate(self._pad_tab_btns):
            title = (self._pad_pages()[i].get("title") or ("页 %d" % (i + 1)))[:12]
            b.configure(text=title, bg=(BORDER if i == self._pad_page else SURFACE),
                        fg=(FG if i == self._pad_page else FG_DIM), activebackground=BORDER)
        for slot, widgets in enumerate(self._pad_cells):
            cfg = cells[slot] if slot < len(cells) and isinstance(cells[slot], dict) else {}
            color = cfg.get("color") if cfg.get("color") in PAD_COLORS else PAD_COLORS[0]
            selected = (slot == self._pad_sel)
            widgets["frame"].configure(bg=color, highlightbackground=("#60A5FA" if selected else BG))
            widgets["label"].configure(text=cfg.get("text") or "", bg=color)
            widgets["note"].configure(bg=color,
                                      text="N%d" % pad_note_for(self._pad_page * PAD_SLOTS + slot))
        if self._pad_sel is None:
            self._pad_entry.configure(state=tk.NORMAL)
            self._pad_text_var.set("")
            self._pad_entry.configure(state=tk.DISABLED)
        else:
            cfg = self._pad_cell(self._pad_sel) or {}
            self._pad_entry.configure(state=tk.NORMAL)
            self._pad_text_var.set(cfg.get("text") or "")

    # ── 编辑动作 ──

    def _pad_goto(self, index):
        self._pad_page = index
        self._pad_sel = None
        self._pad_confirm_delete = False
        self._pad_render()

    def _pad_select(self, slot):
        self._pad_sel = slot
        self._pad_entry.configure(state=tk.NORMAL)
        self._pad_redraw()
        self._pad_entry.focus_set()

    def _pad_edit_text(self):
        if self._pad_sel is None: return
        cell = self._pad_cell(self._pad_sel)
        if cell is None: return
        text = self._pad_text_var.get()[:PAD_TEXT_MAX]
        if text == (cell.get("text") or ""): return
        cell["text"] = text
        self._pad_cells[self._pad_sel]["label"].configure(text=text)
        self._pad_commit_soon()

    def _pad_edit_title(self):
        page = self._pad_page_data()
        title = self._pad_title_var.get()[:PAD_TEXT_MAX]
        if title == (page.get("title") or ""): return
        page["title"] = title
        self._pad_redraw()
        self._pad_commit_soon()

    def _pad_set_color(self, color):
        if self._pad_sel is None:
            self._pad_status("先点一个格子，再选颜色")
            return
        cell = self._pad_cell(self._pad_sel)
        if cell is None: return
        cell["color"] = color
        self._pad_redraw()
        self._pad_commit()

    def _pad_add_page(self):
        pages = self._pad_pages()
        if len(pages) >= PAD_PAGES_MAX:
            self._pad_status("最多 %d 页" % PAD_PAGES_MAX); return
        pages.append({"title": "新页 %d" % (len(pages) + 1),
                      "cells": [{"text": "", "color": PAD_COLORS[0]} for _ in range(PAD_SLOTS)]})
        self._pad_page = len(pages) - 1
        self._pad_sel = None
        self._pad_commit()
        self._pad_render()
        self._pad_status("已加一页；手机上会立刻多出一个页签")

    def _pad_del_page(self):
        pages = self._pad_pages()
        if len(pages) <= 1:
            self._pad_status("至少保留一页"); return
        # 两次点击确认，而不是模态弹窗：不引额外 import，也不会弹出被 DAW 挡住的对话框
        if not self._pad_confirm_delete:
            self._pad_confirm_delete = True
            self._pad_status("再点一次「删除本页」确认删除这一页"); return
        self._pad_confirm_delete = False
        del pages[self._pad_page]
        self._pad_page = max(0, self._pad_page - 1)
        self._pad_sel = None
        self._pad_commit()
        self._pad_render()

    def _pad_status(self, msg):
        if self._pad_win is None: return
        try: self._pad_status_lbl.configure(text=msg)
        except (tk.TclError, AttributeError): pass

    # ── 落盘与广播 ──

    def _pad_commit_soon(self):
        """Debounce typing: one save+broadcast per pause, not per character."""
        if self._pad_save_timer:
            self.root.after_cancel(self._pad_save_timer)
        self._pad_save_timer = self.root.after(300, self._pad_commit)

    def _pad_commit(self):
        self._pad_save_timer = None
        handler = self._handler
        if handler is not None:
            # The running server owns the layout the phones get; it persists and hands it back.
            self._pad_layout = handler.set_pad_layout(self._pad_layout)
            loop = self._loop
            if loop is not None and not loop.is_closed():
                try: asyncio.run_coroutine_threadsafe(handler.broadcast_pad_layout(), loop)
                except RuntimeError: pass
        else:
            self._pad_layout = save_pad_layout(self._pad_layout)

    def _poll_status(self):
        if self._mode != "running": return
        if self._handler:
            cc = self._handler.last_cc_output
            n = self._handler.client_count
            connected = n > 0
            if self._compact:
                norm, kind = self._bar_norm(cc) if connected else (None, "cc")
                self._bar_args = (norm, kind)
                self._mon_value.config(text=self._value_text(cc, connected))
                self._draw_bar(norm, kind)
            else:
                self._status_clients.config(text=f"clients: {n}")
                if cc:
                    o = cc[0]; self._status_cc.config(text=f"CC{o['cc']} Ch{o['channel']+1} = {o['value']}")
                    # Pulse dot
                    hue = GREEN if o['value'] > 0 else FG_DIM
                    self._indicator.itemconfig(self._dot, fill=hue)
                else: self._status_cc.config(text="cc: --")
        self._status_timer = self.root.after(50 if self._compact else 500, self._poll_status)

    def _show_error(self, msg: str):
        """Say it in the window: the packaged exe has no console, so a startup failure that
        only reaches the log is invisible — the window must not claim to be running."""
        log.error("%s", msg)
        self._clear()
        self._mode = "setup"
        tk.Label(self.root, text="启动失败", font=FONT_H1, bg=BG, fg=RED).pack(pady=(24, 8))
        tk.Label(self.root, text=msg, font=FONT, bg=BG, fg=FG, wraplength=420,
                 justify="left").pack(padx=24)
        tk.Button(self.root, text="返回", command=self._build_setup, font=FONT_BOLD, bg=SURFACE,
                  fg=FG, relief=tk.FLAT, padx=24, pady=6, cursor="hand2").pack(pady=20)

    # ── Lifecycle ──────────────────────────────────────────────────────────
    def _clear(self):
        for w in self.root.winfo_children(): w.destroy()
        for name in ("_status_midi", "_status_clients", "_status_cc", "_indicator", "_dot",
                     "_mon_value", "_mon_back", "_bar", "_bar_bg", "_bar_fill", "_bar_mid",
                     "_busy_lbl", "_start_btn", "_stop_btn", "_tree", "_port_var", "_pad_btn"):
            if hasattr(self, name): delattr(self, name)
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

    def _ssl_for(self, base_dir):
        """Build the TLS context once per run.

        Doing this on every START cost ~0.7 s of frozen window (measured), almost all of it
        importing `cryptography` inside cert generation/checks.
        """
        if self._ssl_pair is not None: return self._ssl_pair
        context, protocol = None, "http"
        try:
            cp, kp = _ensure_cert(base_dir)
            context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
            context.load_cert_chain(cp, kp); protocol = "https"
        except Exception as e:
            log.warning("SSL skipped: %s", e)
            log.warning(_HTTP_SENSOR_WARNING)
        self._ssl_pair = (context, protocol)
        return self._ssl_pair

    def _start_server(self, device_id, device_name, port):
        """Start everything on a worker thread: this window must never stop responding.

        Measured before this change: START blocked the UI thread for ~0.7 s (cert work) and
        STOP for ~5 s (aiohttp's cleanup draining a connected phone), which is exactly the
        "未响应" the user reported. The Tk thread only polls for the result now.
        """
        if self._busy: return
        self._busy = "start"
        self._start_result = None
        self._set_busy("正在启动…")

        def _work():
            try:
                midi = WinMidi(); midi.open(device_id=device_id)
            except WinMidiError as e:
                self._start_result = {"ok": False, "msg": f"无法打开 MIDI 端口：{e}"}; return
            except Exception as e:
                self._start_result = {"ok": False, "msg": f"无法打开 MIDI 端口：{e}"}; return
            try:
                base_dir = _base_dir()
                engine = MappingEngine(str(base_dir / "config" / "default.json"))
                handler = SensorHandler(engine, midi, pb_idle_sec=self._pb_idle_sec)
                ssl_context, protocol = self._ssl_for(base_dir)
                app = web.Application()
                app["handler"] = handler; app["midi"] = midi; app["engine"] = engine
                app.router.add_get("/ws", handler.handle)
                app.router.add_get("/status", handle_status)
                web_dir = base_dir / "web"
                if not web_dir.exists(): web_dir = base_dir.parent / "web"
                if web_dir.exists():
                    ipath = web_dir / "index.html"
                    async def _idx(r): return web.FileResponse(ipath)
                    app.router.add_get("/", _idx)
                    app.router.add_static("/", web_dir, show_index=False)
                sock = bind_server_socket("0.0.0.0", port)
            except Exception as e:
                try: midi.close()
                except Exception: pass
                msg = str(e)
                if isinstance(e, OSError) and _port_in_use("0.0.0.0", port):
                    msg = (f"端口 {port} 已被占用：已经有一个「手机推子」在运行，"
                           f"手机的连接进的是那一个。请先关闭它（或换一个端口）再启动。")
                self._start_result = {"ok": False, "msg": msg}; return

            log.info("Starting on %s://0.0.0.0:%d", protocol, port)
            thread = threading.Thread(target=self._serve, args=(app, sock, ssl_context,
                                                               handler), daemon=True)
            self._start_result = {"ok": True, "midi": midi, "handler": handler, "sock": sock,
                                  "thread": thread, "protocol": protocol,
                                  "name": device_name, "port": port}
            thread.start()

        threading.Thread(target=_work, daemon=True).start()
        self._poll_start()

    def _serve(self, app, sock, ssl_context, handler):
        """Server thread: own the loop, the runner and the listening socket."""
        loop = asyncio.new_event_loop(); asyncio.set_event_loop(loop)
        runner = web.AppRunner(app)
        loop.run_until_complete(runner.setup())
        loop.run_until_complete(web.SockSite(runner, sock, ssl_context=ssl_context).start())
        if handler.pb_idle_sec > 0:
            asyncio.ensure_future(handler.pb_watchdog(), loop=loop)
        # A trigger whose "release" never arrives would hang a Note On in the DAW, so the pad
        # gets its own guard regardless of the pitch-bend setting.
        asyncio.ensure_future(handler.pad_watchdog(), loop=loop)
        self._loop = loop; self._runner = runner
        try:
            loop.run_forever()
        finally:
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            except Exception:
                pass
            loop.close()

    def _poll_start(self):
        if self._start_result is None:
            if self._busy == "start": self.root.after(50, self._poll_start)
            return
        res, self._start_result, self._busy = self._start_result, None, None
        self._set_busy(None)
        if not res.get("ok"):
            self._show_error(res.get("msg") or "启动失败")
            return
        self._midi, self._handler = res["midi"], res["handler"]
        self._sock, self._server_thread = res["sock"], res["thread"]
        self._build_running(res["name"], res["port"], res["protocol"])

    def _on_stop(self):
        """Tear down on a worker thread; the window switches views when it is really done."""
        if self._busy: return
        loop, runner, sock, thread = self._loop, self._runner, self._sock, self._server_thread
        midi, handler = self._midi, self._handler
        self._loop = self._runner = self._sock = self._server_thread = None
        self._midi = self._handler = None
        self._busy = "stop"
        self._stop_done = False
        self._set_busy("正在停止…")

        def _work():
            if loop and runner:
                async def _shutdown():
                    # Close the listeners first (this is what frees the port), then stop
                    # serving. `runner.cleanup()` alone drains live connections and can block
                    # for seconds while the phone is still attached — bounded here instead.
                    try:
                        await runner.shutdown()
                    except Exception as e:
                        log.warning("停止监听时出错：%s", e)
                    try: sock.close()
                    except OSError: pass
                    try:
                        await asyncio.wait_for(runner.cleanup(), timeout=1.0)
                    except Exception:
                        pass                        # draining leftovers is best-effort
                    for task in asyncio.all_tasks(loop):
                        if task is not asyncio.current_task(loop): task.cancel()
                    loop.call_soon(loop.stop)
                try:
                    fut = asyncio.run_coroutine_threadsafe(_shutdown(), loop)
                    fut.result(timeout=3)
                except Exception as e:
                    log.warning("等待服务器停止：%s", e)
            if thread and thread.is_alive():
                thread.join(timeout=3)
            if midi:
                try: midi.close()
                except Exception: pass
            self._stop_done = True

        threading.Thread(target=_work, daemon=True).start()
        self._poll_stop()

    def _poll_stop(self):
        if not self._stop_done:
            self.root.after(50, self._poll_stop)
            return
        self._busy = None
        self._stop_done = False
        self._set_busy(None)
        self._build_setup()

    def _set_busy(self, label):
        """Announce background work without blocking anything.

        Every reference is allowed to be stale: the label lives in the setup view and is gone
        once the running view is up (a destroyed widget raises TclError on config), so this
        must never be the thing that breaks STOP.
        """
        def _apply(widget, **kw):
            try: widget.config(**kw)
            except (AttributeError, tk.TclError): pass
        _apply(getattr(self, "_busy_lbl", None), text=label or "")
        if hasattr(self, "_stop_btn"):
            _apply(self._stop_btn, text="停止中…" if label else "STOP",
                   state=(tk.DISABLED if label else tk.NORMAL))

    def _on_quit(self):
        self._capture_window()                # 先记精简窗尺寸与位置，再拆服务器（拆的过程会切回设置页）
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
        # The pad's guard is independent of the PB setting: a lost trigger release would leave
        # a Note On hanging in the DAW whatever `--pb-idle-ms` says.
        asyncio.ensure_future(handler.pad_watchdog())
    else:
        log.info("PB 守护已关闭（--pb-idle-ms 0）：手机静默时 DAW 会停在最后的弯音值")
    try:
        try:
            sock = bind_server_socket(args.host, args.port)
        except OSError as e:
            if _port_in_use(args.host or "0.0.0.0", args.port):
                log.error("端口 %d 已被占用：已经有一个 Bridge 在运行（手机的连接会进那一个）。"
                          "请先关闭它，或用 --port 换一个端口。", args.port)
            else:
                log.error("端口 %d 无法监听：%s", args.port, e)
            sys.exit(1)
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
