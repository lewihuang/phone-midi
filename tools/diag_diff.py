"""对比两份 `diag_snapshot.py` 快照，把"故障前后到底哪里变了"按证据重要性排出来。

    python tools\\diag_diff.py normal broken
    python tools\\diag_diff.py <快照目录A> <快照目录B>

参数可以给 tag（自动找该 tag 最新的一份）或目录。输出：
  * 控制台：几行"重点结论"（电源/重启/端点身份/映射文件/端口表）；
  * `<B>/diff_vs_<A tag>.md`：完整对比（每节都列 A→B）。

判断优先级（与 2026-09-30 / 10-13 两次取证的结论一致）：
  1. 映射文件被写小了/绑定变 0 —— "映射为空"的直接物证；
  2. WinRT 端点 InstanceId 变了 —— 端口被删掉重建；
  3. Nuendo 的 Port Setup 缓存被重写、slot→名字又变了 —— 检测期对不上；
  4. 睡眠/唤醒或 Nuendo/MidiSrv/loopMIDI 重启 —— 触发条件；
  5. Bridge 端口表/体检日志变化 —— 老 MIDI 栈视角下端口有没有动过。
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

DIAG_ROOT = Path(os.environ.get("APPDATA", "")) / "phone-midi-bridge" / "diag"


def load_dir(arg):
    p = Path(arg)
    if p.is_dir() and (p / "snapshot.json").is_file():
        return p
    cands = sorted(DIAG_ROOT.glob(f"*_{arg}")) if DIAG_ROOT.is_dir() else []
    if not cands:
        sys.exit(f"找不到快照：{arg}（也不是 {DIAG_ROOT} 下的 tag）")
    return cands[-1]


def load(snap_dir):
    with open(snap_dir / "snapshot.json", "r", encoding="utf-8") as f:
        return json.load(f)


def brief(v, n=90):
    s = str(v)
    return s if len(s) <= n else s[:n] + "…"


def by_name(items, key="name"):
    out = {}
    for it in items or []:
        out.setdefault(it.get(key), []).append(it)
    return out


def proc_signature(p):
    return f"{p.get('pid')}@{p.get('start')}"


def diff_processes(a, b, lines, findings):
    pa = by_name(a.get("processes") or [])
    pb = by_name(b.get("processes") or [])
    names = sorted(set(pa) | set(pb))
    rows = []
    for n in names:
        sa = sorted(proc_signature(x) for x in pa.get(n, []))
        sb = sorted(proc_signature(x) for x in pb.get(n, []))
        if sa != sb:
            rows.append((n, ", ".join(sa) or "—", ", ".join(sb) or "—"))
            findings.append(f"进程 {n} 变了：{', '.join(sa) or '—'} → {', '.join(sb) or '—'}")
    lines += ["## 进程", ""]
    if not rows:
        lines.append("所有相关进程的 PID 与启动时间都没变。")
    else:
        lines += ["| 进程 | A | B |", "|---|---|---|"]
        lines += [f"| {n} | {x} | {y} |" for n, x, y in rows]
    lines.append("")


def diff_power(a, b, lines, findings):
    at = (a.get("meta") or {}).get("captured_at") or ""
    evs = [e for e in ((b.get("power") or {}).get("power") or []) if (e.get("t") or "") >= at]
    boots = [e for e in ((b.get("power") or {}).get("boots") or []) if (e.get("t") or "") >= at]
    lines += ["## 电源 / 启动事件（A 之后新增）", ""]
    if not evs and not boots:
        lines.append("A 之后没有新的睡眠/唤醒/开机记录。")
    for e in evs:
        lines.append(f"- {e.get('t')} · {e.get('src')} #{e.get('id')} · {brief(e.get('msg'), 100)}")
        if e.get("id") in (42, 107) or "Power-Troubleshooter" in (e.get("src") or ""):
            findings.append(f"电源事件：{e.get('t')} {brief(e.get('msg'), 60)}")
    for e in boots:
        lines.append(f"- {e.get('t')} · {e.get('src')} #{e.get('id')}")
    lines.append("")
    ba = (a.get("system") or {}).get("boot")
    bb = (b.get("system") or {}).get("boot")

    def boot_delta(x, y):
        try:
            return abs((datetime.fromisoformat(y) - datetime.fromisoformat(x)).total_seconds())
        except Exception:
            return None

    delta = boot_delta(ba, bb) if (ba and bb) else None
    if delta is not None and delta > 120:
        findings.append(f"系统重启过：开机时间 {ba} → {bb}")
        lines.append(f"\n**系统开机时间变了**：{ba} → {bb}\n")
    elif delta is not None and delta > 0:
        lines.append(f"（开机时间差 {int(delta)} 秒，属于时钟校正，不算重启。）\n")


def diff_midi(a, b, lines, findings):
    ma, mb = a.get("midi") or {}, b.get("midi") or {}

    def port_rows(m):
        return ({(p["name"], p["index"]) for p in (m.get("winmm") or {}).get("out", [])},
                {(p["name"], p["index"]) for p in (m.get("winmm") or {}).get("in", [])},
                [p["name"] for p in (m.get("winmm") or {}).get("out", [])],
                [p["name"] for p in (m.get("winmm") or {}).get("in", [])])

    oa, ia, ona, ina = port_rows(ma)
    ob, ib, onb, inb = port_rows(mb)
    lines += ["## WinMM 端口表（Bridge 走这条）", ""]
    if ona == onb and ina == inb:
        lines.append("OUT / IN 的端口**顺序与下标都没变**。")
    else:
        lines += ["| | A | B |", "|---|---|---|"]
        lines.append(f"| OUT | {' / '.join(ona)} | {' / '.join(onb)} |")
        lines.append(f"| IN | {' / '.join(ina)} | {' / '.join(inb)} |")
        findings.append("winmm 端口表变了（顺序/成员）")
    lines.append("")

    def ep_map(m):
        eps = (m.get("pnp_endpoints") or [])
        # 只看 MIDI 端点：SoftwareDevice 里还有一堆与 MIDI 无关的系统设备（RRAS 等）
        eps = [e for e in eps if ("MIDIU" in (e.get("instance") or "")
                                  or e.get("class") == "MidiEndpoint"
                                  or "midi" in (e.get("name") or "").lower())]
        return {e.get("instance"): e for e in eps if e.get("instance")}

    ea, eb = ep_map(ma), ep_map(mb)
    lines += ["## WinRT / MidiSrv 端点身份", ""]
    removed = sorted(set(ea) - set(eb))
    added = sorted(set(eb) - set(ea))
    changed = []
    for k in sorted(set(ea) & set(eb)):
        if ea[k].get("status") != eb[k].get("status") or ea[k].get("name") != eb[k].get("name"):
            changed.append((k, ea[k], eb[k]))
    if not (removed or added or changed):
        lines.append("端点集合与身份**完全一致**（InstanceId 没变）。")
    for k in removed:
        lines.append(f"- 消失：`{k}`（{ea[k].get('name')}）")
        findings.append(f"端点消失：{ea[k].get('name')} {k}")
    for k in added:
        lines.append(f"- 新出现：`{k}`（{eb[k].get('name')}）")
        findings.append(f"新端点：{eb[k].get('name')} {k}")
    for k, x, y in changed:
        lines.append(f"- 变化：`{k}` {x.get('name')}/{x.get('status')} → {y.get('name')}/{y.get('status')}")
        if x.get("name") != y.get("name"):
            findings.append(f"端点改名：{x.get('name')} → {y.get('name')}（{k}）")
        if x.get("status") != y.get("status"):
            findings.append(f"端点状态：{x.get('status')} → {y.get('status')}（{y.get('name')}）")
    for label in ("install", "removal"):
        for k in sorted(set(ea) & set(eb)):
            if (ea[k].get(label) or "") != (eb[k].get(label) or ""):
                lines.append(f"- `{k}` 的 {label} 变了：{ea[k].get(label)} → {eb[k].get(label)}")
                findings.append(f"端点 {label} 变了：{k}")
    lines.append("")

    la = json.dumps((ma.get("loopmidi_registry") or {}), sort_keys=True, ensure_ascii=False)
    lb = json.dumps((mb.get("loopmidi_registry") or {}), sort_keys=True, ensure_ascii=False)
    lines += ["## loopMIDI 端口定义（HKCU）", ""]
    lines.append("未变。" if la == lb else "**变了**：\n```json\n" + lb + "\n```")
    if la != lb:
        findings.append("loopMIDI 端口定义/参数变了（容器内 slot 可能整体重排）")
    lines.append("")


def diff_nuendo(a, b, lines, findings):
    na, nb = a.get("nuendo") or {}, b.get("nuendo") or {}
    lines += ["## Nuendo 端口缓存（Port Setup.xml）", ""]
    pa = na.get("port_setup") or {}
    pb = nb.get("port_setup") or {}
    if not pa.get("exists") or not pb.get("exists"):
        lines.append(f"文件缺失：A={pa.get('path')} B={pb.get('path')}")
    else:
        lines.append(f"- 哈希：{pa.get('sha256', '')[:12]} → {pb.get('sha256', '')[:12]}")
        lines.append(f"- mtime：{pa.get('mtime')} → {pb.get('mtime')}")
        if pa.get("sha256") != pb.get("sha256"):
            findings.append("Nuendo 重写了 Port Setup.xml（端点表被重新枚举）")
        sa = (na.get("port_setup") or {}).get("parsed") or {}
        sb = (nb.get("port_setup") or {}).get("parsed") or {}
        wa = sa.get("winrt_sys_names") or []
        wb = sb.get("winrt_sys_names") or []
        if wa != wb:
            lines += ["- WinRT slot→名字变了：", f"  - A: {', '.join(wa)}", f"  - B: {', '.join(wb)}"]
            findings.append("Port Setup 的 WinRT slot→名字映射变了")
        else:
            lines.append(f"- WinRT slot→名字：{', '.join(wb)}")
        for flag in ("has_phonepad_directmusic", "has_phonepad_windows_midi", "winrt_has_phonepad"):
            if sa.get(flag) != sb.get(flag):
                lines.append(f"- **{flag}**：{sa.get(flag)} → {sb.get(flag)}")
                findings.append(f"Port Setup：{flag} {sa.get(flag)} → {sb.get(flag)}")
        mid = (nb.get("midi_devices_bin") or {}).get("mtime")
        if (na.get("midi_devices_bin") or {}).get("mtime") != mid:
            lines.append(f"- `Midi Devices.bin` mtime：{(na.get('midi_devices_bin') or {}).get('mtime')} → {mid}")
    lines.append("")

    dpa = (na.get("defaults_xml") or {}).get("parsed") or {}
    dpb = (nb.get("defaults_xml") or {}).get("parsed") or {}

    def guid_map(x):
        return {(p.get("dir"), p.get("name")): p.get("guid") for p in (x.get("ports") or [])}

    ua, ub = guid_map(dpa), guid_map(dpb)
    changed_guid = [(k, ua.get(k), ub.get(k)) for k in sorted(set(ua) | set(ub))
                    if ua.get(k) != ub.get(k)]
    lines += ["## Nuendo PortUID（Defaults.xml）", ""]
    if not changed_guid and dpa.get("phonepad_refs") == dpb.get("phonepad_refs"):
        lines.append("PhonePad / loopMIDI Port 的 PortUID 与引用都没变。")
    for (d, n), x, y in changed_guid:
        lines.append(f"- {d} {n}：`{x}` → `{y}`")
        if n in ("PhonePad", "loopMIDI Port"):
            findings.append(f"PortUID 变了：{d} {n}（{x} → {y}）")
    if dpa.get("phonepad_refs") != dpb.get("phonepad_refs"):
        lines.append(f"- PhonePad 引用：{dpa.get('phonepad_refs')} → {dpb.get('phonepad_refs')}")
        findings.append("Defaults.xml 里 PhonePad 的引用变了")
    lines.append("")

    def gm_map(n):
        return {Path((g.get("file") or {}).get("path", "")).name: g
                for g in (n.get("globalmappings") or [])}

    ga, gb = gm_map(na), gm_map(nb)
    lines += ["## MIDI Remote 映射文件（“映射为空”的直接物证）", ""]
    lines += ["| 文件 | A 绑定数 | B 绑定数 | A 大小 | B 大小 |", "|---|---|---|---|---|"]
    for name in sorted(set(ga) | set(gb)):
        x, y = ga.get(name), gb.get(name)
        fa = (x or {}).get("file") or {}
        fb = (y or {}).get("file") or {}
        lines.append(f"| {name} | {(x or {}).get('bindings_total')} | {(y or {}).get('bindings_total')} | "
                     f"{fa.get('size')} | {fb.get('size')} |")
        if x and y and fa.get("sha256") != fb.get("sha256"):
            findings.append(f"映射文件变了：{name}（绑定 {(x or {}).get('bindings_total')} → "
                            f"{(y or {}).get('bindings_total')}）")
            cmds_a = {c.get("CommandName") for pg in (x.get("pages") or []) for c in (pg.get("commands") or [])}
            cmds_b = {c.get("CommandName") for pg in (y.get("pages") or []) for c in (pg.get("commands") or [])}
            lost = sorted(c for c in cmds_a - cmds_b if c)
            gained = sorted(c for c in cmds_b - cmds_a if c)
            if lost:
                lines.append(f"  - B 比 A 少了 {len(lost)} 条命令：{', '.join(lost[:8])}"
                             + (" …" if len(lost) > 8 else ""))
            if gained:
                lines.append(f"  - B 比 A 多了 {len(gained)} 条命令：{', '.join(gained[:8])}"
                             + (" …" if len(gained) > 8 else ""))
        elif x and y and fa.get("mtime") != fb.get("mtime"):
            # 内容相同但被重写：说明 Nuendo 在 B 的时刻重新保存过 MIDI Remote 映射
            lines.append(f"  - 内容相同，但被重写：{fa.get('mtime')} → {fb.get('mtime')}")
        elif x and not y:
            findings.append(f"映射文件消失：{name}")
        elif y and not x:
            findings.append(f"新增映射文件：{name}")
    lines.append("")

    def drv_map(n):
        return {((d.get("vendor") or "") + "_" + (d.get("device") or "")): d
                for d in (n.get("drivers") or [])}

    da, db = drv_map(na), drv_map(nb)
    lines += ["## MIDI Remote 设备定义（DIY_*.json）", ""]
    for key in sorted(set(da) | set(db)):
        x, y = da.get(key), db.get(key)
        fx = (x or {}).get("file") or {}
        fy = (y or {}).get("file") or {}
        status = "未变" if fx.get("sha256") == fy.get("sha256") else "**变了**"
        lines.append(f"- {key or '?'}：{status}（{fx.get('mtime')} → {fy.get('mtime')}）")
        if fx.get("sha256") != fy.get("sha256"):
            findings.append(f"设备定义变了：{key}")
            lines.append(f"  - 检测规则 A：{brief(json.dumps((x or {}).get('detection'), ensure_ascii=False))}")
            lines.append(f"  - 检测规则 B：{brief(json.dumps((y or {}).get('detection'), ensure_ascii=False))}")
    lines.append("")


def diff_bridge(a, b, lines, findings):
    ba, bb = a.get("bridge") or {}, b.get("bridge") or {}
    lines += ["## Bridge", ""]
    lines.append(f"- 端口：{ba.get('port')} → {bb.get('port')}（监听 {ba.get('listening')} → {bb.get('listening')}）")
    sa, sb = ba.get("status") or {}, bb.get("status") or {}
    if not bb.get("listening"):
        lines.append("- **B 时刻 Bridge 没有运行**（端口没监听），客户端与端口表无从比较。")
    else:
        lines.append(f"- 客户端：{sa.get('clients')} → {sb.get('clients')}")
        lines.append(f"- 端口表：{' | '.join(sb.get('midi_ports') or []) or '—'}")
        if sa.get("midi_ports") != sb.get("midi_ports"):
            findings.append("Bridge 看到的端口表变了（/status.midi_ports）")
    for name in ("window.json", "fader.json", "xy.json", "ui.json", "pad.json"):
        xa = (ba.get("configs") or {}).get(name) or {}
        xb = (bb.get("configs") or {}).get(name) or {}
        if xa.get("sha256") != xb.get("sha256"):
            lines.append(f"- `{name}` 变了：{xa.get('mtime')} → {xb.get('mtime')}")
    for name in ("exe", "server_py"):
        xa = ba.get(name) or {}
        xb = bb.get(name) or {}
        if xa.get("sha256") != xb.get("sha256"):
            lines.append(f"- `{name}` 变了（换过程序？）")
            findings.append(f"Bridge {name} 变了（升级/替换过）")
    lines.append("")

    la = (ba.get("log") or {})
    lb = (bb.get("log") or {})
    old_events = set(la.get("port_events") or [])
    new_events = [ln for ln in (lb.get("port_events") or []) if ln not in old_events]
    lines += ["## Bridge 日志里的新端口事件", ""]
    if not new_events:
        lines.append("A 之后没有新的端口体检/重开记录。")
    for ln in new_events[-25:]:
        lines.append(f"- {brief(ln, 160)}")
        if "重开" in ln or "已不在" in ln:
            findings.append(f"Bridge 记录到端口变化：{brief(ln, 100)}")
    old_warn = set(la.get("warnings") or [])
    new_warn = [ln for ln in (lb.get("warnings") or []) if ln not in old_warn]
    if new_warn:
        lines += ["", "新警告/错误：", ""]
        lines += [f"- {brief(ln, 160)}" for ln in new_warn[-10:]]
        findings.append(f"Bridge 新警告 {len(new_warn)} 条")
    lines.append("")


def diff_files(a, b, lines):
    def fm(s):
        return {f.get("rel") or Path(f.get("src", "")).name: f for f in (s.get("files") or [])}

    fa, fb = fm(a), fm(b)
    lines += ["## 快照里保存的原始文件", ""]
    rows = []
    for rel in sorted(set(fa) | set(fb)):
        x, y = fa.get(rel), fb.get(rel)
        sx = (x or {}).get("size")
        sy = (y or {}).get("size")
        if rel == "bridge/bridge_log_tail.txt":
            rows.append((rel, f"{sx} B", f"{sy} B", "每次都变（日志尾巴）"))
        elif (x or {}).get("mtime") != (y or {}).get("mtime") or sx != sy:
            rows.append((rel, f"{sx} B", f"{sy} B", "**变了**"))
    if not rows:
        lines.append("关键文件的大小与 mtime 都没变（日志尾巴除外）。")
    else:
        lines += ["| 文件 | A | B | 说明 |", "|---|---|---|---|"]
        lines += [f"| {r} | {x} | {y} | {note} |" for r, x, y, note in rows]
    lines.append("")


def main():
    if len(sys.argv) < 3:
        sys.exit("用法：python tools\\diag_diff.py <正常快照> <故障快照>")
    da, db = load_dir(sys.argv[1]), load_dir(sys.argv[2])
    a, b = load(da), load(db)

    findings, lines = [], []
    lines += [f"# 快照对比：{a['meta']['tag']} → {b['meta']['tag']}", "",
              f"- A：`{da}` · {a['meta']['captured_at']} · {a['meta'].get('note') or ''}",
              f"- B：`{db}` · {b['meta']['captured_at']} · {b['meta'].get('note') or ''}",
              ""]

    diff_power(a, b, lines, findings)
    diff_processes(a, b, lines, findings)
    diff_nuendo(a, b, lines, findings)
    diff_midi(a, b, lines, findings)
    diff_bridge(a, b, lines, findings)
    diff_files(a, b, lines)

    lines += ["## 重点结论", ""]
    if findings:
        lines += [f"- {f}" for f in findings]
    else:
        lines.append("- 没发现端点身份 / 映射文件 / 端口表 / 进程启动时间上的变化。"
                     "若界面仍异常，优先查 Nuendo 自己的缓存与 MIDI Remote 重绑定路径。")
    lines.append("")

    out = db / f"diff_vs_{a['meta']['tag']}.md"
    out.write_text("\n".join(lines), encoding="utf-8")

    print("\n重点结论")
    print("=" * 60)
    for f in findings or ["（没发现上述五类变化）"]:
        print(" -", f)
    print(f"\n完整对比已写入：{out}")


if __name__ == "__main__":
    main()
