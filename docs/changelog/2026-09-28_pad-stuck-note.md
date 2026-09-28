# 2026-09-28 面板 Note 悬挂（真机"这个宏/按钮停不下来"）

用户报：「在 shortcut pad 功能中，偶尔会发现 midi 信号的不间断发送无法停止」。
追问确认：看到的是 **DAW 里那个宏/按钮停不下来、Note 一直亮着**（不是推子的 CC 在刷）。
这正是 `docs/guide/nuendo-shortcut-pad.md` 里那条"属于异常"的现象——这一轮把它查清并修掉了。

一句话：**一格被按下两次时，Bridge 会发两条 Note On，却只有一条 Note Off 能配它**；剩下那条
在 DAW 里永远关不掉，而手机端**没有任何路子**能补一条 Note Off（所以"按多少次都没用"）。

---

## 现象与根因

`bridge/server.py` 原来按**触发编号**记"这一格正按着"，而且是**单条记录**：

```python
def pad_note_on(self, tid):
    self.pad_midi.send_note(note, PAD_CHANNEL, 127)
    self._pad_held[tid] = (time.monotonic(), note)   # 直接覆盖，不计数

def pad_note_off(self, tid):
    if tid not in self._pad_held: return False        # 没记着 → 什么都不发
```

于是 `down, down, up` 得到 `Note On, Note On, Note Off`：第一条 `up` 把记录 pop 掉、补一条 Off，
第二条 `up` 已经没有记录、**静默丢弃**。DAW 侧净结果 = 一直有一条 Note On 亮着。

**手机端确实会发出两次 `down`**（用桩 DOM 驱动 `padgrid.js` 实测）：

| 真机上的来法 | 手机发出的消息 |
|---|---|
| 同一格压了两根手指 / 两个触点 | `down, down, up, up` |
| 面板页与推子页第 4 页条同时按同一编号（24–31 是同一批） | `down, down, up, up`（两个客户端） |
| **丢了"松开"之后 1 秒内重按同一格** | `down, down, up`（最常见） |

第三种最隐蔽：手指滑出格子又没吃到 `setPointerCapture`、系统手势抢走触点、页面切走，都会让那个
`up` 消失；Bridge 的 1 秒兜底本来会替你补 Off，**但用户在 1 秒内又按了一下**——新 `down` 覆盖了
记录，随后的 `up` 把它 pop 掉，兜底此时已经没有东西可放了。

## 为什么 1 秒兜底（`pad_watchdog`）救不了

兜底只遍历 `_pad_held` 里的记录。悬挂产生的那一刻，那条记录**已经被第一条 `up` 消费掉了**，
所以兜底永远看不到它。修好之前唯一的出路是 DAW 侧 MIDI panic / 重载 MIDI Remote——
重启 Bridge 也不管用（DAW 里那条 Note 是 DAW 自己的状态）。

---

## 改动

| 文件 | 改动 |
|------|------|
| `bridge/server.py`（`pad_note_on`） | 该编号**已在按下状态**时：只刷新兜底计时，**不再发第二条 Note On**（并记一行 `重复按下` 日志，便于下次取证）。一格 = 一个音符，与"有几根手指 / 几个客户端"解耦 |
| `bridge/server.py`（`pad_note_off`） | 没有记录时**也补一条 Note Off**（幂等）。这是"已经悬挂的 Note"唯一的自愈通道——旧版本留下的那条，会在下一次松开时被关掉。代价（写进注释了）：别的客户端误发松开会提前关掉这一格，比留一条永远关不掉的 Note 划算 |
| `bridge/server.py`（新增 `pad_all_off(reason)`） | 通道 16 上**全部 48 个触发编号**各发一条 Note Off + 一条 **CC123 All Notes Off**，并清空按住的记录。Bridge **自己也不知道**哪一条挂着（上一进程崩了/被强杀），所以整条通道扫一遍 |
| `bridge/server.py`（GUI 启动 / `_on_stop` / CLI 启动） | 三处调用 `pad_all_off`：**启动时**（端口刚开、还没有客户端，最安全）与**停止时**（必须在 `midi.close()` 之前，关掉之后谁都发不出 Off）。因此"重启 Bridge"从此能清掉上一次留下的悬挂 |
| `bridge/server.py`（运行界面） | 新增 **「全部停」按钮**（在「快捷键面板…」右边，不占额外高度）：不想重启 Bridge 时的手动出口，点完按钮文字回显"已清 48 个音"（状态行每 50 ms 被轮询重写，借它会打架） |
| `tests/bridge_pad_check.py` | 新增 §3d/§3e（触发幂等、悬挂自愈、清场覆盖 48 个编号 + CC123）与 §5 的三条「全部停」断言（58 → 67 项） |

## 实测

- **重复按下**：`down, down, up` → `[(42,15,127), (42,15,0)]`，`_pad_held` 为空（修之前是
  `[(42,15,127), (42,15,127), (42,15,0)]`，且此后**再按多少次都清不掉**）。
- **无记录的松开**：`up`（Bridge 不认识这个编号）→ 补一条 `(43,15,0)`。
- **清场**：48 条 Note Off（36–83，通道 16）+ 最后一条 `CC123 Ch16 = 0`，按住的记录归零。
- **真 Bridge 日志**（`tests/run.ps1`，`bridge_boot_check` / `bridge_ui_check` 起的是真进程）：
  `面板清场（启动）：通道 16 发 48 个 Note Off + CC123`、`面板清场（停止）：…`、
  `快捷键触发 6 重复按下（Note 42 已发过）：只刷新兜底计时，不再发 Note On`。
- **整套离线验证**：`tests/run.ps1` 只剩 exe 快照那一条（`server.py` 改了当然要重打包，
  见下），其余全绿——`bridge_pad_check.py` **67/67**、`pages_smoke.mjs` **107/107**、
  `bridge_boot_check.py` 9/9、`bridge_ui_check.py` 37/37（展开态仍是 480×420、控件未被挤）、
  `bridge_xy_check.py` 21/21、`bridge_protocol_check.py` 21/21、两个 .mjs DSP 套件全绿。

## 本轮不修（查到了，但不在这次范围内）

1. **CLI 模式的兜底根本没在跑**：`_cli_mode` 里 `asyncio.ensure_future(handler.pad_watchdog())`
   是在**没有运行中的事件循环**时创建的，而 `aiohttp.run_app` 会自己 `new_event_loop()`
   （aiohttp 3.14 源码已核对）→ 那个任务永远不 tick。日志证据：51 条
   `Task was destroyed but it is pending! ... pad_watchdog()` 全部出现在 CLI 启动后 1 秒，
   GUI 启动（`Starting on https://…:8765`）之后 0 条。**用 `--no-gui` 起 Bridge 的人没有兜底。**
2. 同一行还嵌在 `if args.pb_idle_ms > 0:` 里：`--pb-idle-ms 0` 会把面板兜底一起关掉，
   而紧挨着的注释写的是"与 PB 设置无关"。
3. **手机端三处"断连/返回时先松开按住的格子"其实发不出去**：`send()` 要求
   `readyState === OPEN`，而 `onclose` 时 socket 已关；`app.js` 的 `returnToSetup()` 更是先
   `ws = null` 再 `releaseAll()`。现在靠 Bridge 的断连清扫 + 1 秒兜底，行为正确但注释是假的。
4. `web/padgrid.js` 对同一格**不去重**（第二根手指会真发第二条 `down`）。Bridge 侧已幂等，
   所以现在无害，但仍是多余的协议噪声。
5. `PAD_HOLD_GUARD_SEC = 1.0` 是**从按下时刻**算的固定窗：按住超过 1 秒会被"替你松开"。
   真正的判据应该是"那个客户端断开/静默"，不是固定 1 秒。
6. `tests/pages_smoke.mjs` 的断连用例在桩里没有把 `readyState` 置成 CLOSED，所以第 3 条被
   测试掩盖了（它断言"松手消息发出去了"，真机上发不出去）。

## 文档与产物

- `docs/spec/shortcut-pad.md`：§5 补协议规则；决策表补 **D42/D43**；§10.3 补两条验收。
- `docs/guide/nuendo-shortcut-pad.md`：故障表里"松开后 Note 一直亮"那一行改成给出手动出口。
- `bridge/dist/MIDI Deck.exe` 重打包（`server.py` 改了，跑的是 exe 的话必须换新的）。

> 上面"本轮不修"里的第 1–5 条当天就接着修掉了（外加两条新查出来的：断开时误松开别人的键、
> 停止时弯音不回中），见 [2026-09-28_pad-lifecycle-hardening.md](2026-09-28_pad-lifecycle-hardening.md)。
