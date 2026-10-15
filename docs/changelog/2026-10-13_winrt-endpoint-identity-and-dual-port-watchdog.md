# 2026-10-13 MIDI Remote 里 `PhoneMIDI` / `XY` 变成**空白设备**：WinRT 端点身份 + Bridge 双端口体检的老盲区

用户报（附图）：Nuendo 的 MIDI Remote 界面里，`DIY - PhoneMIDI` 与 `DIY - XY` 两个设备的
**标题还在，控件网格全空**；同一屏的 `DIY - Fade6`（6 个 QC 旋钮）与 `Roland - A-49`
（2 个 QC 旋钮）完全正常。这一次的现象是"**空白**"，与 2026-09-30 那次"**断开连接**"
（见 `2026-09-30_phonepad-remote-disconnects.md`）是同一根因的两种表现。

本轮既把 DAW 侧的机制钉死了，也修掉了 Bridge 侧三个让这件事**看不见、不自愈**的真 bug。

---

## 1. 先摆事实（本轮实测，机器没重装、配置没动）

| 事实 | 怎么来的 |
|------|----------|
| 空掉的两个设备**都绑在 loopMIDI 虚拟端口上**：`PhoneMIDI` → `FilterValue="PhonePad"`、`XY` → `FilterValue="loopMIDI Port"`；正常的两个都是**物理设备**（`Fade6` → `TEENSY MIDI`，`A-49` → Roland 硬件） | 解析 `Documents\Steinberg\Nuendo\MIDI Remote\Driver Scripts\Local\DIY\*\DIY_*.json` 的 `DetectionUnits`/`FilterValue` |
| 系统**当前**的 WinRT 端点名字完全正确：`MIDIU_KSA_<container>_0_0`=`loopMIDI Port`、`_0_1`=`PhonePad`、`_1_0`=`loopMIDI Port`、`_1_1`=`PhonePad` | `Get-PnpDevice -Class MidiEndpoint,SoftwareDevice`（MidiSrv 登记的端点 = WinRT MIDI 层对外暴露的名单，MIDI Remote 检测读的就是它） |
| Nuendo 缓存的 `Port Setup.xml`（2026-10-12 15:53，17 448 B）里，**同一个容器的端点名字整体错位**：`_0_0`/`_1_0` 缓存成 **Pianoteq**、`_0_1`/`_1_1` 缓存成 **DAW**、`_0_2`/`_1_2` 缓存成 **loopMIDI Port** | 解析该 XML 的 `<item>` 块（ID + SysName） |
| `PhonePad` **从来没有出现在 Nuendo 的 WinRT MIDI 段里**（该段有 loopMIDI Port，没有 PhonePad）；它只存在于 `DirectMusic` 与 `Windows MIDI` 两个旧体系 | 对 XML 里 `WinRT MIDI` 段做 `any(SysName=='PhonePad')` → False |
| 缓存里 `loopMIDI Port` 是 `_0_2`/`_1_2`，**现在系统里是 `_0_0`/`_1_0`** —— 说明这个 teVirtualMIDI 容器被**从"三端口（Pianoteq/DAW/loopMIDI Port）"改成过"两端口（loopMIDI Port/PhonePad）"，容器内所有端点的 slot 编号整体重排过** | 缓存 vs 实时 PnP 对比 |
| 启动时序**是对的**：系统开机 10-07 09:10:03 → loopMIDI 进程 09:11:26 → `MidiSrv.exe` 09:12:39（微软文档要求"先起 loopMIDI、再起 MIDI 服务"） | `Win32_OperatingSystem.LastBootUpTime` / 进程 `StartTime` / `Win32_Service`+`Win32_Process.CreationDate` |
| 有残留**空设备目录**：`...\MIDI Remote\Driver Scripts\Local\DIY\XY Pad\`（0 个 json）—— 9-26 建 `XY Pad`、9-28 改名成 `XY` 留下的 | `find ... -type d` 逐个统计 json 数 |
| 事件日志/崩溃转储里**没有** midisrv / loopMIDI / Nuendo 的崩溃 | `Documents\Steinberg\CrashDumps` 为空；进程存活 |

---

## 2. 结论：三层责任，钉在哪一层

```
teVirtualMIDI（loopMIDI）容器里的端口被增删/改名
        ↓
容器内所有端点身份（WinRT slot 编号）整体重排
        ↓
┌─ 表现 A（2026-09-30）：名字没变、身份变了 → Nuendo 旧绑定失效 → 设备"断开连接"
└─ 表现 B（本轮）：检测时该端口在 WinRT 枚举里找不到/对不上 → Nuendo **跳过加载**该设备
                   → 设备变**空白壳**（只有标题，没有控件）
        ↓
两者都只能靠**重启 Nuendo 重新枚举**（或 MIDI Remote 管理器里移除再添加）恢复
```

- **Windows 侧（根因）**：`PhonePad`/`loopMIDI Port` 是 teVirtualMIDI 动态注册的端点。微软在
  Windows MIDI Services 的 known issues 里明确列过 *"Dynamic ports (loopMIDI, loopBE,
  virtualTE / teVirtualMIDI / rtpMIDI / NI Service) are not always visible"*。本机的
  `Port Setup.xml` 缓存正是这个已知问题的现场：**同一容器的端点名字整体错位**。
- **DAW 侧**：Steinberg 的 MIDI Remote 在检测期读不到端口时**不会等**，直接把这个设备
  加载成空壳；且端口以后回来了它**也不会自己重新认**（这就是"为什么必须重启 DAW"）。
- **Bridge 侧（本轮修掉）**：Bridge 对这一切**结构性地看不见**——下面第 3 节。

> 关键区分：本轮系统端点名字**现在是正确的**，错的是 Nuendo 的**缓存**。所以"空白"发生在
> Nuendo **启动/重载该设备的那一刻**（10-13 22:21 那次会话），而不是现在。

---

## 3. Bridge 侧修掉的三个 bug（都有实测复现）

这一节是**代码 bug**，与上面的 Windows 问题相互独立：即使 Windows 侧正常，这三个 bug 也会让
"端口消失"这类事件在 Bridge 侧失明或误判。

### Bug 1（决定性）：`_prev_ports` 是**类**属性，两个实例互相吃掉对方的基线

```python
# 修复前（server.py:90 / 172）
class WinMidi:
    _prev_ports: list[str] | None = None           # ← 类级
    def reopen_if_gone(self):
        prev, WinMidi._prev_ports = WinMidi._prev_ports, now   # ← 读写都走类
```

生产配置是**双端口**：`window.json` 里 `midi_out="loopMIDI Port"`、`pad_port="PhonePad"`，
即两个 `WinMidi` 实例。看门狗按顺序跑：

```python
# server.py:443
for m in (self.midi, self.pad_midi):
    if m is not None: m.reopen_if_gone()
```

一轮体检的真实时序（`PhonePad` 消失）：

1. **推子实例**先跑 → 判定"列表变了"、写日志、**把类级 `_prev_ports` 刷成新列表**；
   它持有 `loopMIDI Port`，不重开（也没资格重开 PhonePad）。
2. **面板实例**后跑 → 读到的 prev 是推子刚写的新列表 → `now == prev` → 直接 `return None`。
   **持有 `PhonePad` 的实例，恰恰是唯一看不见 `PhonePad` 消失的实例。**

用项目真实 `reopen_if_gone`（只桩 winmm）实测：

```
--- PhonePad 消失那一轮 ---  pad reopen_if_gone() -> None
--- PhonePad 回来那一轮 ---  pad reopen_if_gone() -> None
pad 实例的重开次数 = 0，仍持有陈旧句柄 = 是
```

连带症状（日志实证）：15:08:41 STOP → 15:08:44 START 之后**没有**新的"体检起点"行——
类级状态跨 handler 未重置，第二个 handler 的第一次体检 `prev is not None`，起点日志被吞。

### Bug 2：`list_ports()` 稀疏化后，`_device_id` 被同时当"真实设备号"和"列表下标"用

```python
# server.py:121-123   caps 失败的设备被 pass 掉 → ports 变稀疏
except WinMidiError: pass
# server.py:147       但这里拿 len(ports) 当上界
if device_id >= len(ports): raise WinMidiError(...)
# server.py:158       这里拿 device_id 当下标
self._opened_name = ports[self._device_id][1]
```

实测：真实 device 4 存在、但它的 caps 查询失败时，`open(device_id=4)` 抛
`Device 4 out of range`；若下标没越界则**张冠李戴**，`_opened_name` 记成别的端口名。
而 caps 查询失败最容易发生的时刻，正是端点被删掉重建的那一瞬间——本故障的现场。

### Bug 3：体检只比"名字列表"，无法识别"名字没变、身份变了"

`port_names()` 只取 winmm 的 `szPname`。winmm 层永远看得见 `PhonePad`（5 次真实会话的体检
起点全部含 `PhonePad`，从未记录过任何真实变化），但 Nuendo 用的是 WinRT 栈，**它的身份变化在
winmm 侧完全不可见**。所以这套体检对"DAW 说断开/空白、Bridge 说一切正常"这个组合
**结构性失明**。

> 日志核对：`bridge.log` 里 3 条"少了 PhonePad"全部出现在 21:45/21:46，且同一时刻的起点列表里
> 有测试桩 `FakeFader` —— 那几行是跑 `tests/bridge_port_check.py` 写进真日志的，**不是真实事件**。

### 改法

| 位置 | 改动 |
|------|------|
| `WinMidi.__init__` | `_prev_ports` 从**类**属性挪成**实例**属性（两个实例不再共享基线） |
| `WinMidi.open()` | 按 `device_id` 打开时，越界判断用 `count_devices()` 而非 `len(ports)`；`_opened_name` 改为 `device_name(self._device_id)` 单独取，取不到记 `None` 并写日志 |
| `WinMidi.reopen_if_gone()` | 把"列表变化写日志"与"自己端口消失就重开"**拆成两个独立判断**；补上两个死角：① 起点时端口已消失；② 列表变了但**数量不变**（一个消失、另一个同时出现）。另加重开失败后、端口回来时的重试分支 |
| 新增 `_port_diff_note()` | 把"少了谁/多了谁/现在共几个"独立成函数：变化告警与"起点就发现自己在用的端口不在"两处共用 |

**为什么拆两个独立判断**：真正的语义是"**每次体检都该独立判断『我现在拿着的端口还在不在』**"，
变化日志只是顺带。旧逻辑把"端口消失"的判定放在 `now != prev` **里面**，于是上面两个死角都会漏。

---

## 4. 测试（第 8 条：补上双实例盲区）

`tests/bridge_port_check.py`：**10 → 12 条**。

原先测不出 Bug 1 的原因有两个结构性前提：① 每个用例只建**一个** `FakeWinMidi`；②
`with_stub()` 每次都把类级 `_prev_ports = None` 重置、且端口表挂在实例上。两处都已改：

| 用例 | 断言 |
|------|------|
| **6b 双实例共存**（新） | 两个 `WinMidi` 共享**同一张**端口表（模拟同一个系统），`PhonePad` 消失又回来后，`pad.opened == [("PhonePad", 2), ("PhonePad", 2)]` —— **修复前恒为 0 次重开**，必挂 |
| **6c STOP→START 基线重置**（新） | 新实例的 `_prev_ports is None`，第一次体检必须重新记起点（修复前被旧类级基线吞掉） |
| **6 下标位移**（改） | 先体检一次建基线**再**插端口 —— 修复前"起点时端口已消失"会被"记起点"挡掉，必然拿不到 `多了 新插上的键盘` |
| 桩对齐 | `FakeWinMidi.__init__` 初始化 `self._prev_ports = None`（与 `server.WinMidi.__init__` 一致）；`with_stub()` 去掉类级重置 hack |

```
py -3.12 tests/bridge_port_check.py
all 12 checks passed
```

全套件 10 个套件（`bridge_protocol_check` / `bridge_boot_check` / `bridge_ui_check` /
`bridge_pad_check` / `bridge_port_check` / `bridge_xy_check` / `exe_web_check` +
`vibrato.test.mjs` / `pages_smoke.mjs` / `mode_b_latency.test.mjs`）**全部 exit=0**。

---

## 5. DAW / Windows 侧：为什么只能重启，以及止血手段

Bridge 这一侧修完，能保证的是"**Bridge 自己的句柄不会再悄悄失效**"。但"设备变空白"发生在
**Nuendo 检测/加载的那一刻**，那段在 Windows + DAW 侧，Bridge 管不到。

下次再遇到（或现在就已经是空白状态）：

1. 管理员 PowerShell：`Restart-Service midisrv`，然后**只重启 Nuendo**（让它重新枚举 WinRT 端点）；
2. 不想重启 DAW：MIDI Remote 管理器里把该设备**移除再添加**，触发重新检测；
3. 复核判据：`python tools\midi_endpoint_identity.py`（端点 InstanceId 有没有变）、
   `%APPDATA%\phone-midi-bridge\bridge.log`（有没有"MIDI 端口列表变了"/"已不在列表里"）。

**根治（消除身份位移）**：

4. **不要再增删/改名 loopMIDI 端口**。每改一次，容器内所有端点的 slot 编号就整体重排，
   Nuendo 缓存的绑定全部指向错的身份。固定成两个端口、名字永不变（`loopMIDI Port` + `PhonePad`）。
5. 清理残留空目录 `...\Driver Scripts\Local\DIY\XY Pad\`（0 json）。**待确认**：空设备目录是否
   会被扫描成无名设备条目——证据不足，但清掉无害。
6. 可考虑把 `DIY_PhoneMIDI.json` / `DIY_XY.json` 的检测从"名字精确匹配"改为**同时声明
   DirectMusic / Windows MIDI 旧体系的端口**，或改用 `DetectionPortPair`，让 Nuendo 在
   WinRT 枚举失败时还有回退路径。（**未做**，需先确认 Steinberg 设备定义里这些键的写法。）

---

## 6. 产物

- `bridge/server.py`：`_prev_ports` 改实例级；`open()` 越界与取名修正；
  `reopen_if_gone()` 逻辑拆分 + 起点/数量不变/重试三个分支；新增 `_port_diff_note()`。
- `tests/bridge_port_check.py`：10 → 12 条（新增 6b 双实例共存、6c STOP→START 基线重置；
  6 改为先建基线）。
- `bridge/dist/MIDI Deck.exe`：**重打包**（2026-10-14 00:21，17434 474 B；
  打包前已停止正在运行的两个 MIDI Deck 进程）。旧 exe（2026-09-30 21:47）不含本轮修复。

## 7. 还没做的 / 待确认

- **DAW 侧恢复**：由用户手动执行（`Restart-Service midisrv` + 重启 Nuendo）。
- **不动手的事项**：`DIY_*` 设备定义的检测键改法（第 5 节第 6 条）——需要先在 Steinberg
  的 MIDI Remote API 文档/示例里确认 `DetectionPortPair` 等键的合法写法，本轮不猜。
- **空设备目录的影响**：标为"待确认"，未做硬结论。

---

## 8. 2026-10-14 追加：第二次复现——触发条件锁定为**睡眠唤醒**

用户在 Nuendo 正常使用一段时间后，**未改动任何 loopMIDI 配置**，`PhoneMIDI` 再次变空白。
这一轮的取证把上一轮"端点身份错位"的假设收窄为：**睡眠唤醒 → MidiSrv 对动态端点重新
枚举失败**（微软 known issue 的另一条触发路径），并补全了完整时间线。

### 本轮新事实（全部有事件/时间戳支撑）

| 时刻（10-14） | 事件 | 证据 |
|---|---|---|
| 09:35 | **正常重启**（用户确认；非崩溃非掉电） | EventLog 6006（正常关机 09:35:14）→ 6005（启动 09:36:23） |
| 09:37–09:38 | loopMIDI 09:37:33 起 → MidiSrv 09:38:32 起（顺序合规） | 进程 `StartTime` / `Win32_Process.CreationDate` |
| 09:45:45 | Nuendo15 启动，**此后数小时设备正常**（用户实测"中间有过正常的重启"，重启后一切正常） | `Port Setup.xml` 09:45 写入；用户陈述 |
| 12:18–13:23 | **系统睡眠**（S3，约 1 小时 5 分钟），唤醒源为 USB 控制器 | Power-Troubleshooter ID 1（13:23:34，"系统已从低功耗状态中恢复"）；Kernel-Power ID 130/131（SuspendStart/ResumeCount） |
| 13:23:29 | 唤醒瞬间系统时间跳变 3 880 357 ms | Kernel-General ID 1 |
| **13:33** | **Nuendo 重写全部 4 个 MIDI Remote globalmappings 文件**（`DIY_PhoneMIDI` / `DIY_XY` / `DIY_Fade6` / `Roland_A-49`）——变空白发生时刻 | 4 个 `.json` mtime 全部 = 13:33 |
| 之后 | 用户截图：`PhoneMIDI` 标题在、控件网格全空 | 用户供图（2026-10-14） |

### 已排除（这一轮补的证据）

- **端点没有被删除重建**：`DEVPKEY_Device_InstallDate`——`loopMIDI Port` = 2026-05-29、
  `PhonePad` = 2026-09-26 19:39:22，`LastRemovalDate` 均为空；唤醒时段 System 日志里
  没有任何 Kernel-PnP 的删除/添加/迁移事件。
- **winmm 层全程无抖动**：09:15 起 bridge.log 的端口体检**零变化、零重开**（修复后的看门狗
  已在真实会话里跑过，日志沉默 = 老 MIDI 栈视角下端口一直在）。
- **MidiSrv 没有被重启**：唤醒后 PID 2508 仍是 09:38:32 启动的那个进程。
- **正常重启不是触发条件**：09:36 那次重启后设备正常工作了约 4 小时，直到睡眠唤醒。

### 一个重要细节：陈旧缓存在**干净重启后依然原样**

09:36 是**完全干净的重启**（loopMIDI 与 MidiSrv 都按正确顺序重新起来），但 09:45 新写入的
`Port Setup.xml` 里，teVirtualMIDI 容器的 WinRT 名字**仍然是** `Pianoteq` / `DAW` /
`loopMIDI Port`（slot `_0_2`/`_1_2`）——即 §1 那份错位映射**跨重启存活**了。这说明：

- MidiSrv 对这个容器的端点元数据不是每次枚举时重建的，而是**持久化的、且持久化内容是错的**；
- 然而 09:45–13:33 设备**正常工作**——说明 Nuendo 在端口正常在线时并不依赖这份 WinRT
  名字缓存（可能走了 DirectMusic / Windows MIDI 段，那两段名字一直正确）；
- 睡眠唤醒改变了这一点：唤醒后 MidiSrv 重新枚举，动态端点短暂不可见，Nuendo 此时若回退到
  这份错缓存做匹配，就连旧体系的名字都对不上了 → 设备被加载成空白壳并写回 globalmappings。

> 推断链到"Nuendo 回退到错缓存"这一步是**推断**（Nuendo 无对应日志可查），其前每一环
> （睡眠、唤醒、枚举失败属于 known issue、13:33 写回）均有直接证据。

### 触发条件小结

```
正常重启                    → 不触发（09:36 实证）
睡眠 → 唤醒                 → 触发（12:18→13:23→13:33 实证）
teVirtualMIDI 容器 slot 错位 → 常态隐患（跨重启存在，使唤醒后的匹配更容易失败）
```

### 对策更新（在 §5 基础上）

1. **止血**（唤醒后已空白时）：管理员 `Restart-Service midisrv` → 重启 Nuendo，或 MIDI
   Remote 管理器里把设备移除再添加。§5 的三步判据不变。
2. **自动化止血（可选）**：用任务计划程序挂"唤醒"触发器（System 日志 /
   Power-Troubleshooter / 事件 ID 1），动作 `Restart-Service midisrv`——把 Windows 侧的
   枚举问题在唤醒后自动修掉；Nuendo 侧仍需手动移除再添加设备（若 Nuendo 开着）。
3. **回避触发源**：工作室常开机器可在电源计划里把"使计算机进入睡眠状态"设为**从不**
   （显示器休眠可保留——触发点是系统 S3 睡眠，不是息屏）。
4. §5 第 4 条（不要增删/改名 loopMIDI 端口）继续有效：slot 错位这个常态隐患只有
   "容器重建"能清掉，而重建本身又是一次 slot 重排，须配合 midisrv 重启 + Nuendo 重启做。

---

*证据来源：`Get-PnpDevice`（WinRT/MidiSrv 端点表）、`%APPDATA%\Steinberg\Nuendo 15_64\Port Setup.xml`、
`HKCU\Software\Tobias Erichsen\loopMIDI`、进程/服务启动时间、`Documents\Steinberg\Nuendo\MIDI Remote\`
下的设备定义与用户映射、`%APPDATA%\phone-midi-bridge\bridge.log`、System 事件日志
（EventLog 6005/6006、Power-Troubleshooter ID 1、Kernel-Power 130/131/566、Kernel-General ID 1）、
PnP `DEVPKEY_Device_InstallDate/LastRemovalDate`，以及用户的两张 MIDI Remote 界面截图（10-13、10-14）。*
