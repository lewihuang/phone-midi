# MIDI Deck 手机控制器 —— 使用与迁移手册（单文件版）

> **这份文档给谁看**：在**另一台电脑**前面的人（也可能是几个月后的你自己），手上有一个
> `MIDI Deck.exe`、一台手机、以及一份从旧机器拷来的文件。目标是**照着做就能把它跑起来**，
> 并且知道**每一步做完怎么验证**。
>
> **为什么不做"一键自动迁移"**：不同产品（Nuendo / Cubase）、不同大版本，配置目录名、命令名、
> 预制存放位置都会有细微差别。写死的脚本一旦对不上版本就会**静默失败**（把宏写进去、但按钮按了没反应）。
> 所以这份手册的做法是：**给出通用规则 + 每一层都给你一条"自己查"的命令 + 一条"怎么验证"的判据**。
>
> 文中带 ✅ 的是**在旧机器上实测过的**；带 ⚠️ 的是**必须按你自己机器确认**的。

---

## 0. 先读这五条（全是踩过的坑，按重要性排序）

### 0.1 依赖链：任何一环断了，表现都是同一种——按了没反应，而且不报错

```
手机格子
  └─ pad.json 里那一格的音符编号 (note)
      └─ loopMIDI 端口名 必须与设备 JSON 里的 FilterValue 一致
          └─ MIDI Remote 设备定义 (DIY_<设备名>.json)
              └─ MIDI Remote 用户映射 (<设备名>_globalmappings.json)：Note → 目标
                  └─ 目标 = 宏名（按名字引用！）或 直接是命令名
                      └─ 宏在 Key Commands.xml 的 <list name="Macros"> 里
                          └─ 宏里的 (分类 :: 命令名) 在目标机存在吗
                              └─ 若指向 PLE / LE 预制：预制文件在目标机吗
```

**所以排查时永远是从下往上（或从上往下）一层一层验，别跳层**（§5 有分层判据表）。

### 0.2 改任何配置文件之前，DAW **必须真的退干净** ✅

DAW 退出时会用内存里的状态**重写**配置文件。开着它改 = 改了个寂寞（本机实测被覆盖过两次）。
而且**进程名带版本号**，`Get-Process -Name Nuendo` **查不到** `Nuendo15.exe`：

```powershell
Get-Process | Where-Object { $_.ProcessName -match '(?i)nuendo|cubase' -or ($_.Path -and $_.Path -match '(?i)nuendo|cubase') }
```

### 0.3 宏名只用 ASCII，而且**一个字都不能改** ✅

- **非 ASCII 宏名会被丢掉**：实测把中文名的宏写进 `Key Commands.xml`，DAW 启动→退出一轮后它就消失了；
  换成 ASCII 名（`CC1 Lane Preset`）就留住了。
- **映射是按名字引用宏的**（本机映射文件里 `Macro` 出现 13 次、`Command` 99 次）。
  **改名 = 那条按钮静默失效。** 新建宏时**照抄**下面 §2.2 表格里的名字。

### 0.4 端口是**按名字**认的 ✅

设备 JSON 里有 `"FilterValue": "PhonePad"`。目标机上 loopMIDI 里的端口**必须叫同一个名字**
（叫成 `loopMIDI Port 1` 就永远收不到消息，而且不报错）。

### 0.5 顺序：**先预制 → 开关 DAW 一次 → 再装宏**

命令表里能看见"某个 PLE 预制"这件事，是 DAW **加载预制文件时登记出来的**。
所以先装宏、后拷预制，宏会因为解析不到命令而失效。正确顺序见 §3。

---

## 1. 这套东西是什么

```
手机浏览器  ──WebSocket(JSON)──→  MIDI Deck (Bridge, PC)  ──winmm──→  loopMIDI 端口  ──→  DAW
  页面/按钮                          路由 + 布局下发 + 配置             虚拟 MIDI             Nuendo / Cubase
```

- 手机端是 **网页**（Bridge 自己当静态服务器）→ 手机**零安装**，打开一个 `https://<PC 的 IP>:8765` 即可。
  ⚠️ 必须 `https`：`http` 下浏览器不提供传感器接口。
- **三个并列模块**：`Digital Fader`（手机姿态当推子，A 抬手 / B 翻转 / C 摇晃）、
  `Shortcut Pad`（6 页 × 8 格的宏按钮阵列，本项目的主战场）、`X/Y Pad`（屏幕二维控制面）。
- Digital Fader 的 A/B 运行界面底部，**镜像了 Shortcut Pad 第 4 页那八格**（"CC 廊条"）：
  用推子时手就在手机上，顺手切 DAW 的控制器显示。

---

## 2. 当前已经做好的功能（以旧机器上的实测状态为准）

### 2.1 手机六页按钮对照表 ✅（来自 `%APPDATA%\phone-midi-bridge\pad.json`）

**第 1 页「播放控制」**

| 格 | 文字 | Note | DAW 侧 |
|---|---|---|---|
| 1 | 播放 | 36 | 播放/开始 |
| 2 | 停止 | 37 | 停止 |
| 3 | 录制 | 38 | 录音 |
| 4 | 循环（点击激活） | 39 | 循环开关 |
| 5 | 倍速播放 | 40 | 2× 播放 |
| 6 | 半速播放 | 41 | 1/2× 播放 |
| 7 | 快进 | 42 | 前进 |
| 8 | 快退 | 43 | 后退 |

**第 2 页「2」**：8 格全空（N44–N51），**保留没用**。

**第 3 页「音符长度」**（实际是**量化**设置，见下）

| 格 | 文字 | Note | DAW 侧命令（分类 `MIDI Quantize`） |
|---|---|---|---|
| 1 | 1/1 | 52 | `Set Quantize to 1th` |
| 2 | 1/2 | 53 | `Set Quantize to 2th` |
| 3 | 1/4 | 54 | `Set Quantize to 4th` |
| 4 | 1/8 | 55 | `Set Quantize to 8th` |
| 5 | 1/16 | 56 | `Set Quantize to 16th` |
| 6 | 1/32 | 57 | `Set Quantize to 32th` |
| 7 | 开/关三连音 | 58 | `Toggle Quantize Triplet` |
| 8 | 开/关附点 | 59 | `Toggle Quantize Dotted` |

> 这 8 条都是**直接绑命令**（不需要宏）。⚠️ 三连音/附点是**开关**：它们开着时"1/4"会变成 1/4T / 1/4 附点。

**第 4 页「cc廊」**（切卷帘窗里显示的控制器；每个按钮 = 调一个"控制器预制"槽位）

| 格 | 文字 | Note | DAW 命令 | 预制槽位 |
|---|---|---|---|---|
| 1 | CC1 | 60 | `Controller Lane Setup 1` | 槽 1 = CC1 |
| 2 | CC11 | 61 | `Controller Lane Setup 2` | 槽 2 = CC11 |
| 3 | CC64 | 62 | `Controller Lane Setup 3` | 槽 3 = CC64 |
| 4 | Velocity | 63 | `Controller Lane Setup 4` | 槽 4 = 力度 |
| 5 | CC7 | 64 | `Controller Lane Setup 5` | 槽 5 = CC7 |
| 6–8 | 空 | 65–67 | — | 备用 |

> **槽位与页面顺序是一致的**（1→1、2→2、3→3、4→4、5→5），只是**宏的创建顺序**不同，别被宏列表顺序骗了。
> 槽位里"装的是什么"**只能靠 §3 阶段 6 手工重建**（见 §6）。

**第 5 页「着色」**（给**当前选中**的轨道上色）

| 格 | 颜色 | Note | 宏名 |
|---|---|---|---|
| 1 | 红 | 68 | `Set Track Red` |
| 2 | 琥珀 | 69 | `Set Track Yellow` |
| 3 | 绿 | 70 | `Set Track Green` |
| 4 | 蓝 | 71 | `Set Track Blue` |
| 5 | 靛 | 72 | `Set Track Purple` |
| 6 | 品红 | 73 | `Set Track Magenta` |
| 7 | 青 | 74 | `Set Track Cyan` |
| 8 | 粉 | 75 | `Set Track Pink` |

> 这些宏里调的是 **PLE（工程逻辑管理器）预制**：`Process Project Logical Editor :: Set Red` 等。
> 预制文件是**文件**、要一起拷（§3 阶段 3）。

**第 6 页「Mark跳转」**（跳到编号标记；⚠️ 这台机器上**还没做映射**，见 §3 阶段 5）

| 格 | 文字 | Note | 建议命令（分类 `Transport`） |
|---|---|---|---|
| 1–8 | 1…8 | 76–83 | `To Marker 1` … `To Marker 8` |

### 2.2 DAW 侧：18 个宏 = 5 个工厂宏 + **13 个自建宏** ✅

**自建宏照着这张表重建（名字必须完全一致）**：

| 宏名（ASCII！） | 里面的命令（分类 :: 命令名） |
|---|---|
| `CC1 Lane Preset` | `MIDI :: Controller Lane Setup 1` |
| `CC11 Lane Preset` | `MIDI :: Controller Lane Setup 2` |
| `CC64 Lane Preset` | `MIDI :: Controller Lane Setup 3` |
| `Velocity Lane Preset` | `MIDI :: Controller Lane Setup 4` |
| `CC7 Lane Preset` | `MIDI :: Controller Lane Setup 5` |
| `Set Track Red` | `Process Project Logical Editor :: Set Red` |
| `Set Track Yellow` | `Process Project Logical Editor :: Set Yellow` |
| `Set Track Green` | `Process Project Logical Editor :: Set Green` |
| `Set Track Blue` | `Process Project Logical Editor :: Set Blue` |
| `Set Track Purple` | `Process Project Logical Editor :: Set Purple` |
| `Set Track Pink` | `Process Project Logical Editor :: Set Pink` |
| `Set Track Cyan` | `Process Project Logical Editor :: Set Cyan` |
| `Set Track Magenta` | `Process Project Logical Editor :: Set Magenta` |

**5 个工厂宏**（`Selected Tracks to new Folder…`、`Duplicate Selected Tracks without Data`、
`Zoom to Project`、`Export Audio Mixdown Whole Song`、`Move Selection to New TrackVersion`）
**每台机器出厂就有，不用搬**。

### 2.3 DAW 侧：MIDI Remote 概况 ✅

- 设备：`PhoneMIDI`（DIY 设备，输入端口按名字匹配 `PhonePad`）
- 设备定义里有 **48 条 `MidiBindingToNote`**（6 页 × 8 格）
- 用户映射里：**13 条指向宏**（第 4、5 页那 13 个按钮）+ **约 99 条直接指向命令**（第 1、3 页等）

---

## 3. 从零搭一台新电脑（六个阶段，每阶段都有"怎么验"）

### 阶段 0 —— 前置：虚拟端口与系统服务

1. 装 **loopMIDI**（Windows），建**两个**端口：
   - `PhonePad` —— 给按钮/宏用（名字必须与设备 JSON 里一致）
   - 推子用的那个端口（旧机器上叫 `loopMIDI Port`）
2. ⚠️ **管理员重启 MIDI 服务**，否则新端口在 Nuendo/Cubase 里**看不见**（旧机器上实测过）：

   ```powershell
   Restart-Service midisrv      # 管理员 PowerShell；做完要重启 DAW
   ```
3. 手机与电脑在同一局域网。

**怎么验**：`Get-Service midisrv` 在跑；Nuendo 的工作室设置 → MIDI 端口列表里能看到 `PhonePad`。

### 阶段 1 —— Bridge（MIDI Deck）与手机布局

1. 把 `MIDI Deck.exe` 拷过去（单文件，无需 Python）。想改前端才需要源码模式。
2. 拷 Bridge 的用户配置：`%APPDATA%\phone-midi-bridge\`
   （`pad.json` = 六页按钮布局，**最关键**；另有 `fader.json` / `xy.json` / `ui.json` / `window.json`）
3. 启动 Bridge → 端口列表选推子端口，**「面板端口」选 `PhonePad`**（分离端口，避免音源跟着弹音）。

**怎么验**：Bridge 窗口显示形如 `https://192.168.x.x:8765` 的网址（端口以窗口里实际填的为准，
改过会被记住）；手机浏览器打开它，
能看到三个模块；进 Shortcut Pad 后六页的文字/颜色/音符与 §2.1 一致。

### 阶段 2 —— 让 DAW 生成它自己的配置

**先开一次 DAW，再关掉。** 目的是让它在 `%APPDATA%\Steinberg\<产品> <版本>_64\` 下生成
`Key Commands.xml`。**没有这个文件就没法装宏**（也可以直接在 GUI 里建宏，见阶段 4 的路线 A）。

**怎么查自己的产品目录名** ⚠️（不同产品/版本名字不同）：

```powershell
Get-ChildItem "$env:APPDATA\Steinberg" -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'Key Commands.xml') }
# 旧机器上是：Nuendo 15_64 / Cubase 15_64 / Cubase 14_64
```

### 阶段 3 —— 拷"自建预制"（**必须在装宏之前**）

把旧机器这些文件拷到目标机**对应产品**的同一个相对位置：

| 从（旧机器） | 到（目标机） | 缺了会怎样 |
|---|---|---|
| `Documents\Steinberg\Nuendo\User Presets\Project Logical Editor\Set Red.xml` … `Set Magenta.xml`（8 个） | `Documents\Steinberg\<目标产品>\User Presets\Project Logical Editor\` | 8 个着色按钮全部失效 |
| （可选）`…\User Presets\Logical Edit\` 里的自建预制 | 同结构 | 只有用到它们的宏才受影响（当前 13 个宏**没用到**） |

> ⚠️ **是按产品分目录的**：`Documents\Steinberg\Nuendo\...` 里的东西不会自动给 `Cubase` 用，
> 目标机是 Cubase 就放到 `Documents\Steinberg\Cubase\...`。

**拷完再开关 DAW 一次**（让它把这些预制登记进命令表）。✅ 实测依据：旧机器上 Nuendo 的命令表里有
`Process Project Logical Editor :: Set Red` 等 8 条，而本机 Cubase 15 的命令表里**这 8 条全缺**
——差别就在于"预制文件在不在那个产品的 User Presets 里"。

**怎么验**：打开 PLE（工程逻辑管理器），预设列表里能看到 `Set Red` … `Set Magenta`。

### 阶段 4 —— 装 13 个宏

**路线 A（推荐，版本无关、约 5 分钟）**：在 DAW 里手建。

对 §2.2 表里的每一行：
1. `编辑 → 键命令 / Key Commands` → 打开 **Macros（宏）** 区
2. 新建宏 → 命名（**照抄表格里的 ASCII 名字，一个字都别改**）
3. 在命令树里找到那条命令（分类见表格）→ 加进宏
4. 保存

**路线 B（会改文件的人）**：写 `Key Commands.xml`（**先关 DAW**）。手工改要守四条：
- 文件是 **UTF-8 无 BOM + CRLF**；含 DAW 自写的**未声明实体**（如 `&Euml;`）→ **只能按文本插入**，别用 XML DOM 重写
- 宏要写在**两处**：`<list name="Macros">` 里加定义，命令表的 **`Macro` 分类**里加一条同名条目（否则它不会出现在可分配列表里）
- 追加到**末尾**，不要插在中间
- 改完**把插入块抠掉、逐字符比对原文件必须完全相同**，再保存

单条宏的样子（照抄，缩进别动）：

```xml
      <item>
         <string name="Name" value="Set Track Red"/>
         <list name="Commands" type="list">
            <item>
               <string name="Category" value="Process Project Logical Editor"/>
               <string name="Name" value="Set Red"/>
            </item>
         </list>
      </item>
```

**怎么验**（两条路都适用）：Key Commands 的 **Macro 列表里数个数** —— 应该是"工厂 5 个 + 你建的 13 个"。

### 阶段 5 —— MIDI Remote：设备与映射

拷这两个（目标机对应产品的目录结构下）：

| 从（旧机器） | 说明 |
|---|---|
| `Documents\Steinberg\Nuendo\MIDI Remote\Driver Scripts\Local\DIY\PhoneMIDI\DIY_PhoneMIDI.json` | 设备定义（48 条 Note 绑定 + 端口名 `PhonePad`） |
| `Documents\Steinberg\Nuendo\MIDI Remote\User Settings\DIY_PhoneMIDI_<HASH>_globalmappings.json` | **用户映射**（Note → 宏/命令）⚠️ **文件名里的 `<HASH>` 原样保留** |

（如果你还有别的 DIY 设备，比如 `Fade6`，它是一对文件：设备 JSON + 同名 `<HASH>_globalmappings.json`。）

**第 6 页那八格还没做映射** —— 这次要一起做的话：映射助手 → 触发 Pad → 学 Note 76…83 →
分配 `To Marker 1` … `To Marker 8`（分类 `Transport`；位置标记用 `To Marker N`，
循环标记用 `To Cycle Marker N`）。⚠️ 跳的是**标记编号（ID）**，不是列表顺序。

**怎么验**：
- 工作室 → MIDI Remote 管理器：有 `PhoneMIDI`，输入端口 = `PhonePad`
- 读映射文件数一数：`Macro` 出现 **13** 次（与本机一致）

### 阶段 6 —— 手工补两件（没有文件可拷）

1. **5 个控制器预制**（第 4 页那五个按钮真正生效的前提）：
   卷帘窗 → 下方控制器区 → `Controller Lane Setup` → 加 lane、选控制器类型 → **Add Preset**。
   按 §2.1 第 4 页表：**槽 1 = CC1、槽 2 = CC11、槽 3 = CC64、槽 4 = Velocity（力度）、槽 5 = CC7**。
   ⚠️ **编号顺序 = Add Preset 的先后顺序**，所以一定要按这个顺序存。
2. **颜色表核对**：8 个 PLE 预制是按**颜色名字**引用的（`Set Red.xml` 里就是 `value="Red"`）。
   默认色表自带 Red / Yellow / Green / Blue / Purple / Pink / Cyan / Magenta ✓；**目标机改过色表就自己核对一次**
   （把 `Set Red` 跑一遍，看是不是真的变红）。

---

## 4. 版本 / 产品差异怎么自理（为什么不做全自动）

| 你要查什么 | 一行命令 / 操作 |
|---|---|
| 我的产品配置目录叫什么 | `Get-ChildItem "$env:APPDATA\Steinberg" -Directory \| Where-Object { Test-Path (Join-Path $_.FullName 'Key Commands.xml') }` |
| 某条命令在我这台机器上叫什么 / 在不在 | DAW 里 `编辑 → 键命令`，用搜索框搜关键词（如 `controller lane`、`quantize`、`marker`）；或读 XML 搜 `<string name="Name" value="` |
| 我的宏到底装上了没有 | Macro 列表数个数；或读 XML：见附录 C |
| 我的预制放在哪 | `Get-ChildItem "$env:USERPROFILE\Documents\Steinberg" -Recurse -Directory -Filter 'User Presets'` |
| MIDI Remote 设备与映射在哪 | `Documents\Steinberg\<产品>\MIDI Remote\`（`Driver Scripts\Local\DIY\` = 设备；`User Settings\` = 映射） |

**已实测的产品差异**（旧机器 Nuendo 15 ↔ 本机 Cubase 15）：

| 命令 | Nuendo 15 | Cubase 15 |
|---|---|---|
| `MIDI :: Controller Lane Setup 1…5` | 有 | **有** → 5 个 CC 廊宏跨产品可用 |
| `Process Project Logical Editor :: Set Red…Magenta` | 有 | **缺** → 因为预制文件没在那个产品的 `User Presets` 里（按 §3 阶段 3 拷过去即可） |

> 结论：**跨产品迁移是可行的**，但"命令是否存在"必须按目标机自己的命令表核对，
> 这就是不做全自动脚本的根本原因。

---

## 5. 故障排查：按层验，别跳层

| 症状 | 先查哪一层 | 判据 |
|---|---|---|
| 手机显示"未连接"，格子点不动 | Bridge 在跑吗 / 手机地址对吗 | Bridge 窗口的网址能打开；状态是"已连接" |
| 点了没反应（最模糊的一种） | **从 DAW 侧往回查**：先用脚本直接发 Note | `python tools\send_note.py --port PhonePad --note 60` |
| 上面那条**也没反应** | DAW 侧（端口 / 设备 / 映射 / 宏） | ① 端口列表有 `PhonePad` 吗（没有 → 阶段 0.2 重启 `midisrv`）② MIDI Remote 里有 `PhoneMIDI` 且输入端口对 ③ 映射里那条 Note 指向的目标还在吗（**宏名改过就断**）④ 宏引用的命令/预制在不在 |
| 上面那条**有反应** | 手机 / Bridge 侧 | 手机的 Note 编号与映射里的编号是否一致（看 `pad.json`）；Bridge 是不是发到了 `PhonePad` |
| 按按钮时音源跟着弹音 | 端口分离 | 面板端口必须与推子端口分开（Bridge 里选「面板端口」= `PhonePad`），别去动推子端口的 `All MIDI Inputs` |
| 改了配置/宏，重启后没了 | 改的时候 DAW 开着吗 | 见 §0.2；写完再回读一次文件确认（附录 C） |
| 宏在列表里看不到 | 名字 / 加载时机 | 中文名会被丢（§0.3）；预制要先拷再开关 DAW 一次（§0.5） |
| 手机页面是旧的 | 手机缓存 / exe 快照 | 改过前端要 `?v=` 升版并**重打包 exe**；手机强刷一次 |
| MIDI Remote 设备 `PhoneMIDI` **用着用着显示"断开连接"**（手机显示已连接、Bridge 也有输出；推子那个端口不受影响；**只有重启 DAW 才恢复**） | 先分清"端口变了"还是"DAW 没重新认" | ① `python tools\midi_endpoint_identity.py` 对比断开前后的 InstanceId 与下标 ② 看 `%APPDATA%\phone-midi-bridge\bridge.log` 有没有 `MIDI 端口列表变了`（Bridge ≥ 2026-09-30 会自己体检）③ 管理员 `Restart-Service midisrv`（**不用重启 DAW**）：设备回来了 → 责任在 Windows MIDI 服务 + 动态端口；没回来 → 在 DAW 侧的重新绑定 ④ 在 MIDI Remote 管理器里把该设备移除再添加，能恢复就说明只是 DAW 没重新认 |

> **关于 `tools\send_note.py`（分层排查里最好用的那一支）**：它需要目标机装了 **Python + mido**。
> 没有的话，替代判据：① 在 DAW 的 MIDI Remote 管理器里看该设备的输入活动指示；
> ② 用现成的 MIDI 监视工具（如 MIDI-OX）看 `PhonePad` 端口上有没有消息进来；
> ③ 最土也最有效：**换一个"确定能用"的按钮**（比如第 1 页的"播放"）先确认链路通了，
> 再回头怀疑那条命令 / 那个宏。

> **`mido` 的端口名带序号**（Windows 上返回的是 `PhonePad 2` 这种），写脚本比对端口名时
> 要用**包含匹配**，别用精确相等 —— 这坑我们刚在核对脚本里踩过一次。

---

## 6. 明确**做不到无损**的三项（先说清楚，省得白折腾）

1. **5 个控制器预制的内容**：在 `%APPDATA%\...\Presets\`、`Documents\...\User Presets\`、
   `UserPreferences.xml`、`Defaults.xml` 里**都没有**它的定义 → 只跟着**工程**走 →
   **目标机必须按 §3 阶段 6 重建**（约 2 分钟），或者把**工程/模板**一起带过去。
2. **颜色表**：预制按颜色**名字**引用，目标机改过色表就要核对（默认色表一致）。
3. **机器相关的偏好**：`Port Setup.xml` / `UserPreferences.xml` / `Defaults.xml`
   （音频设备、窗口位置、端口枚举…）**不要整份拷**，很可能把目标机的音频配置弄坏。
   需要时只取其中一小段，或在目标机上手动设一次。

---

## 附录 A —— 旧机器实测文件清单（2026-09-27）

| 文件 | 大小 | 说明 |
|---|---|---|
| `%APPDATA%\Steinberg\Nuendo 15_64\Key Commands.xml` | 320 096 B | 18 个宏 + 全部键位 |
| `Documents\Steinberg\Nuendo\User Presets\Project Logical Editor\Set *.xml` | 8 × ~5.6 KB | 8 个着色 PLE 预制 |
| `Documents\Steinberg\Nuendo\User Presets\Logical Edit\*` | 2 个 | 较早的 LE 预制（当前宏未引用） |
| `Documents\Steinberg\Nuendo\MIDI Remote\Driver Scripts\Local\DIY\PhoneMIDI\DIY_PhoneMIDI.json` | 68 605 B | 设备定义 |
| `Documents\Steinberg\Nuendo\MIDI Remote\User Settings\DIY_PhoneMIDI_<HASH>_globalmappings.json` | 22 574 B | 用户映射 |
| `%APPDATA%\phone-midi-bridge\pad.json` | 5 360 B | 六页按钮布局 |

## 附录 B —— 便携的"宏定义"文本（13 条，可照抄）

```
CC1 Lane Preset        = MIDI :: Controller Lane Setup 1
CC11 Lane Preset       = MIDI :: Controller Lane Setup 2
CC64 Lane Preset       = MIDI :: Controller Lane Setup 3
Velocity Lane Preset   = MIDI :: Controller Lane Setup 4
CC7 Lane Preset        = MIDI :: Controller Lane Setup 5
Set Track Red          = Process Project Logical Editor :: Set Red
Set Track Yellow       = Process Project Logical Editor :: Set Yellow
Set Track Green        = Process Project Logical Editor :: Set Green
Set Track Blue         = Process Project Logical Editor :: Set Blue
Set Track Purple       = Process Project Logical Editor :: Set Purple
Set Track Pink         = Process Project Logical Editor :: Set Pink
Set Track Cyan         = Process Project Logical Editor :: Set Cyan
Set Track Magenta      = Process Project Logical Editor :: Set Magenta
```

## 附录 C —— 核对用的 PowerShell 片段（复制粘贴即可）

```powershell
# ① DAW 关了吗（进程名带版本号，所以按名字+路径双重匹配）
Get-Process | Where-Object { $_.ProcessName -match '(?i)nuendo|cubase' -or ($_.Path -and $_.Path -match '(?i)nuendo|cubase') }

# ② 我的产品目录 & 宏清单
#    注意：不是 DAW 的目录（Drum Machine / Sampler Track / Library Manager…）也有 Key Commands.xml，
#    但里面没有 Macros 段 —— 所以要判空跳过，且每轮都重新取，别复用上一轮的变量。
$dirs = Get-ChildItem "$env:APPDATA\Steinberg" -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'Key Commands.xml') }
foreach ($d in $dirs) {
  $t = [System.IO.File]::ReadAllText((Join-Path $d.FullName 'Key Commands.xml'), [System.Text.Encoding]::UTF8)
  $i = $t.IndexOf('<list name="Macros"')
  if ($i -lt 0) { "{0}: （没有 Macros 段，多半不是 DAW 的配置）" -f $d.Name; continue }
  $names = @([regex]::Matches($t.Substring($i), '^         <string name="Name" value="([^"]+)"/>', 'Multiline') | ForEach-Object { $_.Groups[1].Value })
  "{0}: {1} 个宏 -> {2}" -f $d.Name, $names.Count, ($names -join ', ')
}
# 本机实测输出：
#   Cubase 14_64: 5 个宏      Cubase 15_64: 5 个宏
#   Nuendo 15_64: 18 个宏 -> …(5 工厂 + 13 自建)
#   Drum Machine_64 / Sampler Track_64 / Steinberg Library Manager_64: （没有 Macros 段…）

# ③ 映射文件里引用了多少宏 / 命令（与本机对比：宏 13、命令 ~99）
$m = Get-ChildItem "$env:USERPROFILE\Documents\Steinberg" -Recurse -Filter '*_globalmappings.json' |
     Where-Object { $_.Name -like '*PhoneMIDI*' } | Select-Object -First 1
$t = [System.IO.File]::ReadAllText($m.FullName, [System.Text.Encoding]::UTF8)
"{0}: Macro 引用 {1} 次 / Command 引用 {2} 次" -f $m.Name, ([regex]::Matches($t,'Macro')).Count, ([regex]::Matches($t,'Command')).Count

# ④ 设备 JSON 认的端口名（必须与 loopMIDI 里的端口名一致）
#    这个键可能出现多次（都指向同一个端口名），所以去重后再看
$d = Get-ChildItem "$env:USERPROFILE\Documents\Steinberg" -Recurse -Filter 'DIY_PhoneMIDI.json' | Select-Object -First 1
$t = [System.IO.File]::ReadAllText($d.FullName, [System.Text.Encoding]::UTF8)
[regex]::Matches($t,'"FilterValue"\s*:\s*"([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique | ForEach-Object { "   端口名 = $_" }
# 本机实测：端口名 = PhonePad
```

---

*本手册的事实来源：2026-09-27 在装有 Nuendo 15 / Cubase 15 的机器上实测（文件路径、大小、
命令表解析、跨产品对照、覆盖与丢名现象）。凡带 ⚠️ 的条目请按你的机器确认后再动手。*
