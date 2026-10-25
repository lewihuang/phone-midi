# 2026-10-24 `DIY - PhoneMIDI`「映射为空 / 未连接」取证记录

## 现象（用户 2026-10-24）

Nuendo 的 MIDI Remote 里，设备 **`DIY - PhoneMIDI`**（Shortcut Pad 用的那个，绑 loopMIDI 的
`PhonePad` 输入）会不定期变成**空白/未连接**：设备条目还在，但**所有映射到它的快捷键都不见了**。
Nuendo 与 MIDI Deck 的其他功能都正常；手机端与 Bridge 也正常。

## 已知机制（前两轮结论，不再重复取证）

| 轮次 | 结论 | 文档 |
|------|------|------|
| 2026-09-30 | 端口在 winmm 层一直在，Nuendo 说断开；只有重启 Nuendo 才能恢复 | [changelog](../changelog/2026-09-30_phonepad-remote-disconnects.md) |
| 2026-10-13 | `Port Setup.xml` 里 teVirtualMIDI 容器的 WinRT slot 名字**长期错位**；Bridge 的三个 bug（类级基线、下标误用、只比名字）已修 | [changelog](../changelog/2026-10-13_winrt-endpoint-identity-and-dual-port-watchdog.md) |
| 2026-10-14 | **触发条件锁定为「系统睡眠 → 唤醒」**：唤醒后 MidiSrv 重枚举动态端点失败，Nuendo 13:33 把 4 个 globalmappings 重写，`PhoneMIDI` 变空壳；端点没有被删除重建，MidiSrv 也没重启 | 同上 §8 |

## 本次基线（2026-10-24 09:15，状态正常）

快照：`%APPDATA%\phone-midi-bridge\diag\20261024-091544_normal\`
（`snapshot.json` + `report.md` + `files/` 原始副本）

| 项 | 值 |
|----|----|
| 系统 | Windows 11 Pro build 26300；开机 **2026-10-22 23:33:20** |
| 电源 | 10-24 **00:03 进入睡眠 → 08:56:50 唤醒**（Power-Troubleshooter + Kernel-Power 107/131） |
| loopMIDI | PID 21200，2026-10-22 23:34:17 启动；端口 `loopMIDI Port`、`PhonePad` 两个 |
| MidiSrv | PID 11136，2026-10-22 23:35:41 启动 |
| Bridge | PID 33940/36172，2026-10-24 08:58:30 启动；端口 **38765**；`midi_out=loopMIDI Port`、`pad_port=PhonePad` |
| Nuendo | PID 11364，2026-10-24 09:04:42 启动 |
| 当前连接 | Bridge 客户端 0（手机页面没开，不影响设备映射） |

**端点身份（WinRT / MidiSrv）**

```
loopMIDI Port  SWD\MMDEVAPI\MIDIU_KSA_<container>_0_0  (I) / _1_0 (O)
PhonePad       SWD\MMDEVAPI\MIDIU_KSA_<container>_0_1  (I) / _1_1 (O)
```

**winmm（Bridge 走这条）**：OUT `[1] loopMIDI Port`、`[2] PhonePad`；IN `[0] loopMIDI Port`、`[1] PhonePad`。

**Nuendo 的端口缓存（Port Setup.xml，09:04:41，sha `d752fa30…`）**：PhonePad 在 DirectMusic 与
Windows MIDI 段里都有；WinRT 段的 slot→名字仍是**已知错位**：

```
_0_0 → Pianoteq      _0_1 → DAW      _0_2 → loopMIDI Port
_1_0 → Pianoteq      _1_1 → DAW      _1_2 → loopMIDI Port
```

（系统侧实际是 `_0_0`=loopMIDI Port、`_0_1`=PhonePad。**这个错位是常态**，不是本次的新变化。）

**PortUID（Defaults.xml）**：Input PhonePad `5AADCFB72D0B4AC39C2AD60FFDFBCFE8`，
Output PhonePad `28A978C155524B22B703C551CB605919`；引用 `I|DirectMusic|PhonePad`。

**映射文件**：`DIY_PhoneMIDI_4ADD894F…_globalmappings.json`，20618 B，**36 个绑定**，mtime 09:04:41。

## 取证工具

```powershell
python tools\diag_snapshot.py --tag normal     # 正常时（已完成）
python tools\diag_snapshot.py --tag broken --note "PhoneMIDI 空白"
python tools\diag_diff.py normal broken        # 输出重点结论 + diff_vs_normal.md
```

快照采集：进程与启动时间、电源/开机事件、winmm 端口表与下标、Drivers32、WinRT 端点身份、
loopMIDI 注册表、Bridge `/status` 与日志、Nuendo 的 Port Setup / Defaults PortUID / 设备定义 /
4 个 globalmappings；关键文件原件一并复制。

## 故障时（**先别重启 Nuendo**）

1. 立刻 `python tools\diag_snapshot.py --tag broken --note "..."`；
2. `python tools\diag_diff.py normal broken`；
3. 截一张 Nuendo MIDI Remote 管理器的图（设备列表 + 该设备详情）；
4. 回忆一下：刚才是睡眠唤醒过？Nuendo 重启过？改过 loopMIDI 端口？

## 判读表

| diff 里看到 | 结论 |
|---|---|
| `DIY_PhoneMIDI…globalmappings` 绑定数 36 → 0/变少 | 映射被 Nuendo 写空（与 10-13/10-14 同一表现） |
| 端点 InstanceId 变了 / 少了 | 端口被删掉重建 → 只能重新枚举（重启 Nuendo 或移除再添加） |
| Port Setup 哈希变了、slot→名字又变 | 唤醒后重新枚举失败，回退到错缓存 |
| PortUID 变了 | 同上，Nuendo 侧端口身份换过 |
| A 之后有睡眠/唤醒；Nuendo/MidiSrv/loopMIDI 启动时间变了 | 触发条件命中 |
| 以上都没变，只有映射文件变了 | DAW 侧重新绑定路径；先试“移除设备再添加”，不用重启 |

---

## 2026-10-24 21:37 第一次复现（第 3 次故障）

快照：`%APPDATA%\phone-midi-bridge\diag\20261024-213736_broken\`
对比：[diff_vs_normal.md](<C:/Users/yellow/AppData/Roaming/phone-midi-bridge/diag/20261024-213736_broken/diff_vs_normal.md>)
现象：Nuendo 的 MIDI Remote 里 `DIY - PhoneMIDI` 标题在、48 个 pad 全空（用户截图），设备显示未连接。

### 时间线

| 时刻 | 事件 | 证据 |
|------|------|------|
| 15:49:28–30 | Nuendo 关闭（写 Port Setup / Midi Devices / Defaults） | 三个文件 mtime |
| 15:49:34 | **Bridge 关闭**（面板清场后停止） | bridge.log |
| 16:47:34 | 系统进入睡眠 | Kernel-Power 42 |
| 18:30:34 | 唤醒 | Power-Troubleshooter 1 / Kernel-Power 131 |
| 18:37:08 | **Nuendo 重新启动**（PID 40216） | 进程启动时间 |
| 18:49:23 | Nuendo 重写 4 个 `*_globalmappings.json`（**内容与正常时逐字节相同**） | mtime + sha256 |
| 21:37:36 | 抓故障快照 | — |

### diff 结论

**没有变化**（很关键，排除了“文件被清空/端口被重建”）：

- `DIY_PhoneMIDI…globalmappings.json`：**36 个绑定，20618 B，sha256 与正常时相同**（只有 mtime 变）；
  4 个映射文件都只是被周期性重写（正常时 09:15:29 也发生过一次，Nuendo 启动后约 11–12 分钟）。
- `DIY_PhoneMIDI.json` 设备定义：未变。
- `Port Setup.xml`：哈希相同（`d752fa30…`），只有 mtime 变（15:49 关闭时重写）。
- PortUID（Defaults.xml）：PhonePad / loopMIDI Port 的 GUID 未变。
- loopMIDI 注册表、winmm 端口顺序与下标：未变。
- WinRT 端点：`…_0_1` / `…_1_1` 身份未变，`IsPresent=True`、`ProblemCode=0`、
  `LastArrivalDate` 仍是 10-22 23:35:42（跨睡眠没有重新登记）。
- 映射文件内容没变；设备定义、端口缓存、GUID 都没变。

**发生了变化**：

- 16:47 睡眠 → 18:30 唤醒 → **18:37 Nuendo 重启**；
- Bridge 自 15:49 起未运行。

### 当前（21:37）端点是否可用

- `midiInOpen(PhonePad, idx=1)` → **rc=0**（成功）；
- `midiOutOpen(PhonePad, idx=2)` → **rc=0**（成功）；
- `Get-PnpDevice` 里两个 PhonePad 端点都在、OK。

→ **Windows 侧现在一切正常，只有 Nuendo 的绑定还停在失败状态**（它不会自己重试）。

### 判读

这次不是“映射被写空”，而是 **Nuendo 在 18:37 启动时没能把 `PhonePad` 认成设备的输入端口**，
设备被加载成“未连接/空壳”，之后的周期保存又把原本的映射文件原样写回（所以文件仍是 36 条）。
与 2026-10-13 / 10-14 的结论一致（检测期失败 + 不重试），触发条件再次指向 **睡眠→唤醒后启动 DAW**。

### 仍未确定

- 空是从 18:37 启动就发生，还是用了一段时间后才发生？（用户回忆）
- 18:49 左右是否打开过 MIDI Remote Manager？（那只是周期性保存，不一定是故障时刻）
- 18:37 那一刻，WinRT 枚举里 `PhonePad` 是否短暂缺席 —— 现场没有记录，需要下一次用“唤醒采样器”抓。

### 恢复与下一步

1. 恢复：重启 Nuendo（已知有效）；或 MIDI Remote 管理器里移除再添加设备（不用重启，
   但**先备份** `DIY_PhoneMIDI_…_globalmappings.json` —— 快照里已有副本）。
2. 更准的取证：加一个**唤醒后采样器**（每 2 秒记录 winmm 端口、WinRT 端点、打开测试），
   挂到“唤醒”事件上，专门抓 18:37 这种时刻端点是否对应用不可见。
3. 长期对策候选（待验证，不先动）：电源计划永不休眠；唤醒后自动 `Restart-Service midisrv`
   再重启 Nuendo；给设备定义加 DirectMusic/Windows MIDI 的回退检测；换非动态虚拟端口。
