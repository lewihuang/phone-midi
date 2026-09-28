#!/usr/bin/env python3
"""盯着面板那个 MIDI 端口，看 Note On/Off 是否成对 —— 悬挂 Note 的现场取证。

为什么需要它：整条链路里"DAW 里那条 Note 一直亮着、宏停不下来"这个症状（用户 2026-09-28 报的
就是它）在 DAW 里看是一团黑箱——是手机多发了 down？还是 Bridge 没补 Off？还是 DAW 侧绑定把
Note Off 也当成了按下？这个脚本把**面板端口上的每一个字节**打出来，并实时算出"哪条 Note 欠着
Note Off"，于是责任在哪一段一眼就能分。

判定很直接：
  * 每条 Note On 都有配对的 Note Off → 这段链路干净（问题在 DAW 侧的映射）；
  * 出现 `HANGING` → Bridge 发了 On 却没发 Off（正是 D42/D43 要防的那一类，见
    docs/changelog/2026-09-28_pad-stuck-note.md）；
  * 出现 `clear sweep / self-heal` → 一批"无主的 Off"（清场，或 D42 的自愈通道）。启动、停止、
    点「全部停」都会来一批 48 条，所以默认**按批汇总成一行**（`--raw` 可以逐条打）。

它**只读**：不发送任何消息，也不独占端口（loopMIDI 的回环端口可以同时被 Bridge 写、被它读）。

用法:
  python tools/pad_monitor.py --list                   # 列出所有 MIDI 输入端口
  python tools/pad_monitor.py                          # 默认听名字含 "PhonePad" 的端口，Ctrl+C 结束
  python tools/pad_monitor.py --port loopMIDI          # 面板与推子共用端口时听那个
  python tools/pad_monitor.py --seconds 120            # 听 120 秒自动结束
  python tools/pad_monitor.py --raw                    # 连"无主的 Off"也逐条打（默认按批汇总）

依赖：`pip install mido python-rtmidi`（和 tools/receiver.py 同一套）。
输出刻意只用 ASCII：Windows 控制台编码各不相同，中文注释留在源码里就够了。
退出码 1 = 结束时还有悬挂的 Note（方便脚本化）。
"""

import argparse
import sys
import time

try:
    import mido
except ImportError:
    sys.exit('需要 mido：pip install mido python-rtmidi')


def describe(notes: list[int]) -> str:
    """一小批音符写成 `36,37`；多了就只给范围（清场一次 48 条，逐条列没意义）。"""
    if len(notes) <= 6:
        return ','.join(str(n) for n in sorted(notes))
    return f'{min(notes)}-{max(notes)}'


def pick_port(want: str) -> str:
    """按名字**子串**匹配输入端口（大小写不敏感），和 Bridge 挑输出端口的规矩一致。"""
    names = list(mido.get_input_names())
    if not names:
        sys.exit('系统里没有任何 MIDI 输入端口（loopMIDI 装了吗？）')
    for n in names:
        if want.lower() in n.lower():
            return n
    sys.exit(f'没有名字含 "{want}" 的输入端口。现有端口：\n'
             + '\n'.join(f'  - {n}' for n in names))


def main():
    ap = argparse.ArgumentParser(description='看面板端口上的 Note On/Off 是否成对')
    ap.add_argument('--list', action='store_true', help='列出所有 MIDI 输入端口后退出')
    ap.add_argument('--port', default='PhonePad', help='端口名（子串匹配，默认 "PhonePad"）')
    ap.add_argument('--seconds', type=float, default=0.0, help='听多少秒后自动结束（0 = 直到 Ctrl+C）')
    ap.add_argument('--raw', action='store_true', help='连"无主的 Off"也逐条打（默认按批汇总成一行）')
    args = ap.parse_args()

    if args.list:
        for n in mido.get_input_names():
            print(f'  - {n}')
        return 0

    port_name = pick_port(args.port)
    print(f'listening on {port_name} ... (Ctrl+C to stop)')
    print('按下/松开手机上的格子，然后回来看这份流水。\n')

    outstanding: dict[int, int] = {}     # 音符 → 还欠几条 Note Off
    on = off = 0
    started = time.time()
    stray: list[int] = []                # 攒着"无主的 Off"，成批汇总（清场一次就是 48 条）
    stray_until = 0.0

    def flush_stray():
        nonlocal stray_until
        if not stray:
            return
        notes, stray[:] = stray[:], []
        stray_until = 0.0
        print(f'{time.strftime("%H:%M:%S")}  Note Off x{len(notes)} ({describe(notes)})'
              '   <-- clear sweep / self-heal (no matching On)')

    with mido.open_input(port_name) as port:
        try:
            while True:
                if args.seconds and time.time() - started > args.seconds:
                    break
                if stray and time.time() > stray_until:
                    flush_stray()
                for msg in port.iter_pending():
                    stamp = time.strftime('%H:%M:%S')
                    if msg.type == 'note_on' and msg.velocity > 0:
                        flush_stray()
                        on += 1
                        outstanding[msg.note] = outstanding.get(msg.note, 0) + 1
                        extra = ('   <-- another On for this note is still open!'
                                 if outstanding[msg.note] > 1 else '')
                        print(f'{stamp}  Note On  {msg.note:3d}  vel={msg.velocity}{extra}')
                    elif msg.type == 'note_off' or (msg.type == 'note_on' and msg.velocity == 0):
                        off += 1
                        if outstanding.get(msg.note):
                            flush_stray()
                            outstanding[msg.note] -= 1
                            if not outstanding[msg.note]:
                                del outstanding[msg.note]
                            print(f'{stamp}  Note Off {msg.note:3d}')
                        elif args.raw:
                            print(f'{stamp}  Note Off {msg.note:3d}'
                                  '   <-- no matching On (clear / self-heal)')
                        else:
                            stray.append(msg.note)
                            stray_until = time.time() + 0.05
                    elif msg.type == 'control_change':
                        flush_stray()
                        print(f'{stamp}  CC{msg.control} = {msg.value}')
                time.sleep(0.005)
        except KeyboardInterrupt:
            pass
        finally:
            flush_stray()

    print(f'\nNote On {on} / Note Off {off}')
    if outstanding:
        print('HANGING (Note On with no matching Note Off):', dict(outstanding))
        print('→ 这是 Bridge 侧那一类问题：看 bridge.log 里的"重复按下 / 超过 1000 ms 没收到松开'
              '/ 面板清场"三行；DAW 里可以先用 PC 窗口的「全部停」收干净。')
        return 1
    print('OK: every Note On has a matching Note Off')
    return 0


if __name__ == '__main__':
    sys.exit(main())
