# 2026-09-30 Nuendo 里 `PhoneMIDI` 反复"断开连接"：查到哪儿了、还缺哪一块证据

用户报：**"现在 nuendo 中的 midi remote，有一个 Phone MIDI 的设备是我自己创建的，用于手机拓展
快捷键用的虚拟设备，走的是 LoopMIDI 的 PhonePad 端口。现在这个设备经常用着用着显示为『断开
连接』"**。补充的事实（问出来的，很关键）：

- 断开时**手机端显示「已连接」**、**Bridge 里照样有信号输出**；
- 同一个 loopMIDI 里的另一个端口（推子用的 `loopMIDI Port`）在 Nuendo 里**不受影响**；
- **只有重启 Nuendo 才能恢复**。

这一轮**没有现成复现**（不能再让用户白等一次），所以产出分两部分：已排除的可能 + 留好的仪器。

---

## 1. 先摆事实（2026-09-30 21:3x 实测，机器没重装、没改配置）

| 事实 | 怎么来的 |
|------|----------|
| Windows 11 Pro，Build **26300**，`midisrv` = **Windows MIDI 服务**（新 MIDI 栈），`wdmaud2.drv` 已启用 | `Win32_OperatingSystem` / `Win32_Service` / `Drivers32`（`midi=wdmaud.drv`、`midi1=wdmaud2.drv`，**没有**第三方 `midiN` 驱动） |
| 虚拟端口来自 loopMIDI 1.0.16.27（teVirtualMIDI 驱动，`ROOT\MEDIA\0001`）；配置里两个端口：`loopMIDI Port`、`PhonePad` | HKCU `Tobias Erichsen\loopMIDI\Ports` |
| `PhonePad` 在系统里的**身份**：`SWD\MMDEVAPI\MIDIU_KSA_<container>_0_1`（出）与 `…_1_1`（入）；`loopMIDI Port` 是 `_0_0` / `_1_0` | `tools/midi_endpoint_identity.py` |
| Bridge 走 **winmm**：`PhonePad` 在下标 **OUT[2] / IN[1]**（下标会随任何 MIDI 设备插拔整体位移） | `tools/midi_ports_probe.py` |
| 设备定义 `DIY_PhoneMIDI.json`：**只有 1 个输入端口**（`DetectionSingleInput` + `DetectionInputNameFilterEquals` = `PhonePad`），**没有输出端口** | 解析该 JSON（62 690 B） |
| Nuendo 的端口表里 `PhonePad` 三种体系都在（`I/O\|DirectMusic\|PhonePad`、`I/O\|Windows MIDI\|PhonePad`，另有 WinRT 的 `…MIDIU_KSA_<container>_0_1`） | `%APPDATA%\Steinberg\Nuendo 15_64\Port Setup.xml` |
| 事件日志里**没有** midisrv / loopMIDI 的崩溃、服务重启、WER 报告；`midisrv` 自 19:10:00 起一直活着（系统 19:07:39 启动） | System/Application 日志、WER ReportArchive |

## 2. 已经**排除**的（都不是原因）

1. **"端口在系统里消失/重建"**——在会话过程中没有发生，且和 Bridge 的开关无关。
   实测（`tools/midi_endpoint_identity.py` 的前身，`endpoint_churn_probe`）：自己打开 `PhonePad`
   句柄、握 3 秒、关掉，同时每 100 ms 采样 winmm 列表 + PnP 身份——**全程零变化**。
   → 客户端句柄的开/关**不会**让 loopMIDI 端点消失。断开时端口仍在（与用户的"Bridge 有输出"一致）。
2. **loopMIDI 的反馈检测把端口掐了**——`DetectFeedback=1`、`CommandTreshhold=5000`、
   `TreshholdDuration=5`（≈1000 条/秒，约 MIDI 线速的 2 倍）。实测 `PhonePad` 上**一条消息都没有**
   （`tools/pad_monitor.py --seconds 5`），而 2026-09-28 那次真回灌是 ~956 条/秒、会被这项抓个正着。
   → 当前没有回灌，也不足以触发阈值。
3. **Bridge 自己往端口乱写**（回灌/清场风暴）——本轮日志里没有任何"清场""重复按下"异常；
   Bridge 只有 2 个进程（PyInstaller 的父子），CPU 2.5 小时 158 s，正常。
4. **Nuendo 崩溃导致设备丢失**——Application 日志里今天没有 Nuendo 崩溃；用户描述的"重启 Nuendo
   才恢复"是**手动重启**，不是崩溃重启。

## 3. 剩下的假设（按可能性排序，都还没被证伪）

1. **Windows MIDI 服务（新栈）与"动态端口"的老问题**：`PhonePad` 是 teVirtualMIDI 动态注册的端点，
   微软在《Windows MIDI Services 2026 release – known issues and workarounds》里明确列过
   *"Dynamic ports (loopMIDI, loopBE, virtualTE / teVirtualMIDI / rtpMIDI / NI Service) are not always
   visible"*，且要求"**先起 loopMIDI，再起 MIDI 服务**"；本机 19:08:43 起 loopMIDI、19:10:00 起
   `midisrv`（顺序是对的）。若端点在某些时刻对**应用侧**不可见、而 nuendo 不重新枚举绑定，
   现象就正好是"手机已连接 / Bridge 有输出 / DAW 说断开 / 只能重启 DAW"。
2. **端点身份变了而名字没变**：Windows 把同一个 `PhonePad` 以新 InstanceId 重新登记（或 WinRT 侧
   的 `…_0_1` → 别的尾号）。Nuendo 的 MIDI Remote 绑定按名字匹配，但**已经建立的那一份绑定**
   可能指着旧身份。本机 `Port Setup.xml` 里出现过 `MIDIU_KSA_<container>_0_2` / `_1_2`，
   而当前系统只有 `_0_0/_0_1` 与 `_1_0/_1_1`——**说明这两个端点号以前确实存在过、后来变了**。
3. **Bridge 侧句柄变陈旧**：端口若被换身份，`midiOutShortMsg` 是**静默失败**的——Bridge 界面上
   照样"有信号"（它只是把发出去的东西显示出来）。这一条以前**无法观测**，本轮已补上体检（见 §4）。
4. **DAW 侧的重新绑定路径**：Steinberg 的 MIDI Remote 在端口短暂不可用后**不会自己重新认**，
   只能重载设备/重启 DAW。若 1 或 2 真的发生，这一条就决定了"为什么必须重启"。

## 4. 这一轮补上的东西（都是"下次断开时能定性"用的）

### Bridge：端口体检（新看门狗）

`bridge/server.py`：

- `WinMidi.port_names()` —— 只取名字，够回答"端口还在不在 / 顺序变没变"；
- `WinMidi.reopen_if_gone()` —— 端口列表变了就写日志（少了谁/多了谁/共几个），
  自己正拿着的端口没了就**按名字重新打开**（`midiOutShortMsg` 静默失败那条路的自愈）；
  只是别的设备插拔导致**下标位移**时，只提示不重开（端口还在，句柄有效）；
- `SensorHandler.port_watchdog()` —— 每 3 秒体检一次，和 pad / PB 两条兜底一起挂在
  `app.on_startup` 上（CLI 与 GUI 两条路径都盖到）。**正常运行时这份日志是安静的**；
- `/status` 也带上 `midi_ports`（以后不用猜）。

### 工具（都不需要 DAW、不影响正在跑的东西）

| 工具 | 干什么 |
|------|--------|
| `tools/midi_watch.py` | 长期盯着 `PhonePad`/`loopMIDI` 的**出现/消失**，只在变化时写 `%TEMP%\midi_watch.log` |
| `tools/midi_endpoint_identity.py` | 在"正常时"和"断开时"各跑一次，对比端点的 InstanceId 有没有变 |
| `tools/midi_ports_probe.py` | 一次性的 winmm 端口表（下标很关键） |
| `tools/pad_monitor.py`（已有） | 端口上到底有没有数据在跑 |

### 测试

`tests/bridge_port_check.py`（新，10 条）：起点只记一笔、没变时不写、量失败不抛、消失被看见、
按名字重开、重开失败下一轮再试、下标位移只提示、体检任务真的挂在跑着的循环上（`--pb-idle-ms 0`
只关 PB 那条）、`/status` 带端口列表。`tests/run.ps1` 已加进套件。

## 5. 下一步：怎么把最后那块证据拿到

下次 Nuendo 再显示"断开连接"时，**先别重启 Nuendo**，按顺序做：

1. `python tools\midi_endpoint_identity.py` —— 看 `PhonePad` 的 InstanceId 与下标是否与正常时一致；
2. 看 `%APPDATA%\phone-midi-bridge\bridge.log` —— 有没有 `MIDI 端口列表变了` / `端口…已不在列表里`
   （有 = Bridge 侧看见了；没有 = 端口在 Windows 眼里没变，责任在 DAW 侧）；
3. 管理员 PowerShell：`Restart-Service midisrv` —— 如果**不用重启 Nuendo** 设备就回来了，
   那就把责任钉在"Windows MIDI 服务 + 动态端口"这条上（也顺便是一个可用的止血手段）；
4. 若 1–3 都指向端点没变，就在 Nuendo 的 MIDI Remote 管理器里把该设备**移除再添加**（不重启 DAW），
   看能不能恢复——能恢复说明是 DAW 侧的重新绑定路径。

## 6. 产物

- `bridge/server.py`：`port_names()` / `reopen_if_gone()` / `port_watchdog()` / `/status` 带 `midi_ports`。
- `tests/bridge_port_check.py`（新，10 条）、`tests/run.ps1`（套件 +1）。
- `tools/midi_watch.py`、`tools/midi_endpoint_identity.py`、`tools/midi_ports_probe.py`（新）。
- `bridge/dist/MIDI Deck.exe` **重打包**（旧 exe 里没有体检；用户已同意重启一次让体检生效）。
