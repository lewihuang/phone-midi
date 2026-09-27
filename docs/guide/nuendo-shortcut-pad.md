# Nuendo 设置指南 — 把宏绑到手机按钮上

> **要迁移到另一台电脑（可能是 Cubase、可能不是同版本）** → 看
> [docs/guide/README.md](README.md)（使用与迁移手册·单文件版）：六个搭建阶段、依赖链、
> 分层排查表、以及"哪三项做不到无损迁移"。本页是**本机（Nuendo 15）**的逐步操作记录。

目标：**手机上按一格 → Nuendo 里一个宏执行**（例：把当前轨道变红）。

设计与取舍见 [spec/shortcut-pad.md](../spec/shortcut-pad.md) 与 [ADR 0004](../adr/0004-midi-note-triggers.md)。
本页是照着做的步骤，按你机器上**实测通过**的路径写。

---

## 0. 三样东西怎么对应

```
手机上一格        触发编号 id          MIDI 消息                Nuendo 侧
─────────────  →  ─────────────  →  ─────────────────────  →  ────────────────
第 1 页 第 1 格     0                Note 36 · 通道 16 · 127    你映射的那个宏
第 1 页 第 2 格     1                Note 37 · 通道 16 · 127    另一个宏
…                                                 （松开时同编号力度 0）
第 2 页 第 1 格     8                Note 44 · 通道 16 · 127
```

- **编号由格子位置决定**（`id = 页号 × 8 + 序号`），手机上每格右下角就写着 `N36`…，不用记。
- **通道 16** 是快捷键专用，和推子的 CC 分开，Nuendo 侧可以按通道过滤。
- 手机不知道"宏"是什么；它只发编号。宏只在 Nuendo 里存在。

---

## 1. 先确认一条 Note 能让宏跑起来（30 秒，不用手机）

在 Nuendo 里建好宏之后，先用脚本验证——它把整条链路里唯一没法离线验证的一环提前付掉：

```powershell
python tools\send_note.py            # 发 Note 36、通道 16 到 loopMIDI Port
```

- 宏执行了 → 链路成立，继续第 2 步。
- 没执行 → 见本页最后一节「没反应怎么查」。

## 2. 在 Nuendo 里建 MIDI Remote 设备

1. **工作室 / Studio → MIDI Remote 管理器** → 新建一个设备。
2. **输入端口选 `PhonePad`**（面板专用端口，见上一节；还没建就先建一个 loopMIDI 端口）。
   如果暂时只在一个端口上试，就选 `loopMIDI Port`，但要接受"音源会跟着弹音"。
3. 输出端口：**留空**；必须选就选同一个（本版本没有状态回读，DAW 不需要往回发东西）。
4. 不要选 `MOTU M Series` / `A-Series Keyboard`：那是硬件端口，手机的消息不会出现在那里。

## 3. 把一条 Note 分配给宏

1. 打开**映射助手（Mapping Assistant）**。
2. 添加一个控制，元素类型选 **触发 Pad**（对应"按下即发一次"；按钮类元素带 on/off 状态，语义不同）。
3. 点**学习**，然后跑 `python tools\send_note.py --note 36`（或直接按手机上的第 1 格）——它学到 Note 36。
4. 在功能列表里找到**你的宏**，分配。
5. 对第 2 格重复一次，用 `--note 37`，依此类推。配置按设备保存，之后开关机都记得。

## 4. 手机上打开面板

1. 手机浏览器打开 `https://<PC 的 IP>:<端口>/pad.html`（主页底部也有「快捷键面板」入口）。
2. 右上角显示**已连接**才可点。未连接时格子是灰的、点不动（这是有意的：不让你以为发出去了）。
3. 按一格 → Nuendo 里宏执行。按下的格子会闪一下表示"已发出"。
4. 底部页签切页（只有一页时不显示页签）。

## 5. 在 PC 上改按钮（会即时同步到手机）

Bridge 窗口（展开态）→ **「快捷键面板…」** 按钮：

- 点一个格子 → 改**文字**、选**颜色**（「取色…」打开系统取色器，或直接在 hex 框里填 `#rrggbb`；右边 8 个色块只是预设快捷方式）；
- 改**页标题**；**＋ 加页** 最多 8 页；删页要点两次（防误删）；
- 每次改动都会**立刻落盘**（`%APPDATA%\phone-midi-bridge\pad.json`）并**广播给已连接的手机**，
  手机上不需要刷新、也不需要重连。

> 只改布局**不需要重新打包 exe**；只有改前端代码（`web/*`）才需要。

### 改音符编号（v1.1）

编辑器里选中一格后，**「音符」输入框**（0–127）就是这一格实际发出的 MIDI 音符：

- **默认值**是按位置来的 `36 + 触发编号`，所以不改就跟 v1 完全一样，**旧映射不用重学** ✓
- **改了这个数字**，就需要在 Nuendo 的映射助手里**为这一格重学一次**（音符变了，旧的映射收不到它）
- **拖动换位不需要重学** ✓ —— 音符跟着按钮走，触发编号跟着位置走（这正是"解绑"要买的东西）
- 编辑器里音符显示成**琥珀色**表示**这个编号被多处使用**（跨页也算）。不禁止，但值得留意：同一个音符会让那些按钮在 DAW 里做同一件事
- 把某个按钮的编号改成音源键区之外的音（例如 90 以上）可以顺便避开"音源跟着弹音"——不过用**独立端口**（上一节）才是正解

---

## 面板要用一个**独立的** MIDI 端口（重要）

**问题**：Bridge 的端口有两个身份——① MIDI Remote 设备的输入；② `All MIDI Inputs` 的一员，
而工程里的音源/乐器轨读的就是 ②，且音源是 **OMNI**，所以**通道 16 也拦不住**。
结果：按面板按钮时音源跟着弹音（真机观察：Note 36 落在键区外没出声，Note 37 起开始弹）。

**不能靠取消 `All MIDI Inputs` 解决**：推子的 CC1 也是靠它进 DAW 的，取消它推子就失效（真机已验证）。

**正确做法：给面板单开一个端口**，两个身份彻底分开。

1. **loopMIDI 里新建一个端口**，名字随意，例如 `PhonePad`（和推子的那个分开）。
2. **Bridge 设置页**：上面的端口列表照旧选推子用的那个（`loopMIDI Port`）；
   下面新增的 **「面板端口」** 下拉框选 `PhonePad` → START。
   运行页会显示 `面板端口: PhonePad（与推子分离）`（绿色）。若显示橙色的"与推子相同"，说明还没分开。
3. **Nuendo**：MIDI Remote 管理器里**为这个新端口再建一个设备**（推子那个设备别动），
   输入端口选 `PhonePad`；**注意不要给它勾 "All MIDI Inputs"**（工作室设置 → MIDI 端口里，
   新端口默认可能会被勾上，取消它——这个端口只有面板用，取消不会有副作用）。
4. 在**新设备**的映射助手里，把各条 Note 学一遍并分配给对应的宏。
   （推子那个设备与它的映射完全不受影响。）

这样：推子走 `loopMIDI Port`（照旧，All MIDI Inputs 开着），面板走 `PhonePad`（不在名单里），
音源再也不会收到面板的音符。

### 其余选项（按需）

- **如果你宁可不开新端口**：可以给**推子那个端口**取消 `All MIDI Inputs` —— 只有当你的推子映射
  不是靠 MIDI Learn/All MIDI Inputs 时才有效，否则推子会失灵（**你的机器上已验证会失灵**）。
- 命令行模式用 `--pad-name PhonePad` 达到同样效果。

---

## 面板端口在 Nuendo 里"看不见"时（真机踩到的坑）

**症状**：Bridge 往面板端口（如 `PhonePad`）发消息，手机端一切正常，但 Nuendo 里毫无反应；
把面板端口改成推子那个端口（`loopMIDI Port`）就立刻可用。

**原因**：Nuendo 能看到的 MIDI 端口由它启动时的枚举决定，而 **Windows 上老式的 loopMIDI 端口可能只被 DirectMusic 后端看见**。
判据（直接读文件，不用猜）：

```
%APPDATA%\Steinberg\Nuendo 15_64\Port Setup.xml
```

对比同一个端口在三种后端里的出现情况 —— 现场数据：

| 端口 | DirectMusic | Windows MIDI | WinRT MIDI |
|------|-------------|--------------|------------|
| `loopMIDI Port`（老端口） | ✓ | ✓ | ✓ |
| `PhonePad` / `loopMIDI Port 1`（新建的） | ✓ | ✗ | ✗ |

只有 DirectMusic 有条目 → MIDI Remote 的设备枚举看不到它 → 设备永远收不到消息。

**修法（推荐，实测有效）：重启 Windows MIDI 服务。**
判据同上：如果新建端口**只有 DirectMusic** 一条，说明 Windows 的 MIDI 服务还没把它包装成新式设备
（loopMIDI 的虚拟端口不产生 PnP 到达事件，所以服务不重启就永远看不见它）：

```powershell
# 管理员 PowerShell：先退出 DAW，再执行
Restart-Service midisrv
```

做完后 port 会多出 `I|Windows MIDI|<端口名>` 一条 ✓（`Windows MIDI` 才是 MIDI Remote 用的那套枚举），
再重启 DAW 即可。**重启 DAW 本身没用**——枚举的是服务已经准备好的列表。

> 若 `Restart-Service` 被拒（某些系统把 `midisrv` 设为不可停止），重启 Windows 等效（服务是自动启动的）。

**另一条老办法（只在上面无效时试）：`midi port enabler` 开关。**
安装目录 `midi port enabler` 文件夹里是两个零字节标记文件，Steinberg 的 KB 说把它们**往上挪一层**到主程序目录
（[论坛引用](https://forums.steinberg.net/t/extra-settings/661993/9)："These files are used as a sort of 'switch'"）。

- ⚠️ **只挪 `ignoreportfilter`**（忽略端口过滤）。KB 原文也确实写着 "Only move the ignoreportfilter file"。
- ⚠️ **不要挪 `enableemulated`**：它会把"模拟端口"一并列出，结果是**你机器上每个端口都多出一份【模拟】副本**
  （真机上踩过，而且副本会让 MIDI Remote 的按名匹配出现歧义）。
- 回滚 = 删掉主目录里的那份副本（原文件留在 `midi port enabler\` 里）。

**替代路线**（不依赖端口枚举，推荐作为退路）：保留一个端口（`loopMIDI Port`，已验证可用），
把触发消息换成**音源不会理的类型**——例如 **Polyphonic Aftertouch**（128 个编号、编号仍从 36 起）

---

## 用手机按钮切换卷帘窗的「控制器预制」（第 4 页 / CC 廊那八格）

目标：手机上按一格 → **卷帘窗（Key Editor）下方面板换成某套控制器布局**（例如"只看 CC1"、
"CC11 + CC7 + 力度"）。手机上什么都不用改，走的就是上面那条 Note 链路。

### 1. 先存预制（在卷帘窗里）

1. 打开卷帘窗（`Open Key Editor`），在下方控制器区点 **Controller Lane Setup**。
2. 按需要加 lane、每条选一个控制器类型（Velocity / CC1 / CC11 …）。
3. **Controller Lane Setup → Add Preset** → 起名（例：`CC1`、`表情+音量`、`力度+踏板`）。
4. 做出你要的几套（第 4 页是 8 格 → 最多 8 套；命令一共给到 **16** 套）。
5. **顺序 = 命令编号**：`Controller Lane Setup 1` 对应预制列表里的第 1 个，依此类推。
   所以**按你要的按钮顺序依次 Add Preset**；以后别往中间插新的（插了会整体移位）。

### 2. 建宏（一个预制一个宏）

Nuendo 的 **宏**里放：

```
宏 1  =  Controller Lane Setup 1
宏 2  =  Controller Lane Setup 2
…        …
宏 8  =  Controller Lane Setup 8
```

**宏 1 已经替你建好了**（2026-09-27，直接写进 `Key Commands.xml`，改的时候 Nuendo 没在跑）：

| 宏名 | 内容 |
|------|------|
| `控制器预制 1（CC1）` | 一条命令：`MIDI → Controller Lane Setup 1` |

- 它出现在 Key Commands 对话框的 **Macro 分类**里，也在 MIDI Remote 映射助手的功能列表里 —— **启动 Nuendo 就能看到**
  （配置是启动时读的）。改前已备份成 `Key Commands.xml.bak-<时间戳>`。
- ⚠️ **宏里装不下"CC1 这套布局长什么样"，它只是"切到第 1 套预制"**。所以要让这个按钮真的显示 CC1，
  必须**先把 CC1 那套存成第 1 个预制**（Add Preset 的先后顺序决定编号）。**一个预制都没有时按它 = 什么都不发生**
  —— 那不是宏坏了。
- 其余几套照做：宏 2 = `Controller Lane Setup 2` … 宏 8 = `Controller Lane Setup 8`。

> **手工往 `Key Commands.xml` 里写宏：实测记录（2026-09-27，未结案）**
>
> - 在 GUI 里建的宏（用户建的 `test`，含 `Mute`）确认存在这个文件的**两个位置**，形状是：
>   ```xml
>   <item>
>      <string name="Name" value="test"/>
>      <list name="Commands" type="list">
>         <item>
>            <string name="Category" value="Edit"/>
>            <string name="Name" value="Mute"/>
>         </item>
>      </list>
>   </item>
>   ```
>   命令引用的写法 = **(顶层分类名, 命令名)**，已用三条已知的宏交叉验证：
>   `Edit/Mute`、`Project/Folding: Tracks To Folder`、`Mixer/Add Track To Selected: Group Channel`。
>   所以 `Controller Lane Setup 1` 的引用是 `MIDI/Controller Lane Setup 1`（它在顶层 `MIDI` 分类里）。
> - **按这个形状手工写进去的中文命名宏（`控制器预制 1（CC1）`），在「Nuendo 开→关一轮」之后被丢掉了**
>   （文件被它用自己的内存状态重写）。命令引用已排除嫌疑，剩下的嫌疑是**非 ASCII 宏名**
>   （该文件在我改之前 0 个非 ASCII 字符，Nuendo 自己从不往这里写中文）。
> - 正在做**单变量试验**：同名同命令、只把宏名换成 ASCII（`CC1 Lane Preset`）再看是否留存。
>   结论出来之前，**别把"手工写宏"当成可靠做法**：要稳就在 Macros 对话框里建（20 秒），
>   或者在 GUI 里建一个含 `Controller Lane Setup 1` 的宏、让我读一遍它写出来的原文再照着写。
- 命令在 **Key Commands 对话框的 MIDI 分类**里，搜 `Controller Lane Setup` 就能看到 16 条
  （**本机现状：16 条都还没分配电脑键盘键**，见下面「怎么确认」，不影响宏）。
- **如果按下去没反应**（焦点不在卷帘窗上）：在 Macros 对话框里给这个宏**最前面**加一条
  `Editors → Open Key Editor`，这样会先把卷帘窗拿到前台再切预制。*（这条我没替你加：卷帘窗已经开着时
  再按它会不会顺手关掉，只能在你机器上试一次才算数。`Editors` 分类里另有 `Open/Close Editor`，
  说明"开关"语义是单独一条命令，所以 `Open Key Editor` 大概率只是打开/置前。）*

### 3. 把 Note 挂到宏上（和普通按钮一样）

在 MIDI Remote 映射助手里，把第 4 页那八格学的 Note 逐个分配给上面的宏：

| 手机格子（第 4 页） | 触发编号 | MIDI Note | 分配给的宏 |
|---|---|---|---|
| 第 1 格 | 24 | **60** | 宏 1（Controller Lane Setup 1） |
| 第 2 格 | 25 | **61** | 宏 2 |
| … | … | … | … |
| 第 8 格 | 31 | **67** | 宏 8 |

不打开手机也能先验：`python tools\send_note.py --note 60`（脚本见第 1 节）。

### 4. 怎么确认命令与宏真的在（不用猜）

Nuendo 把**整张命令表 + 所有用户宏**都写在同一个文本文件里：

```
%APPDATA%\Steinberg\Nuendo 15_64\Key Commands.xml
   ├─ <list name="Categories">  ← 命令表（Controller Lane Setup 1–16 在这里，分类 = MIDI）
   └─ <list name="Macros">      ← 用户宏（我们建的宏就在这里）
```

```powershell
$f = "$env:APPDATA\Steinberg\Nuendo 15_64\Key Commands.xml"
# ① 所有控制器相关命令（本机结果：Controller Lane Setup 1–16 全在）
Select-String -Path $f -Pattern 'value="[^"]*Controller[^"]*"'
# ② 宏列表 —— 注意必须按 UTF-8 读，否则中文宏名会显示成乱码（那只是读法问题，不是文件坏了）
[System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8) `
  -split "`r`n" | Select-String -Pattern 'list name="Macros"' -Context 0,40
```

- 分配电脑键盘键之后，对应 `<item>` 里会多出一行 `<string name="Key" value="…" wide="true"/>`
  —— 这是"我到底设上了没有"的判据（同 `Port Setup.xml` 那套思路）。

**手工改这个文件的四个坑（都实测踩过）**：

1. **必须先真的把 Nuendo 退干净**——它**运行时会在退出时用内存里的状态覆盖整个文件**。
   实测：开着 Nuendo 时写进去的宏，退出后就被抹掉了。
2. **进程名带版本号**：真实进程是 `Nuendo15.exe`（路径 `F:\Steinberg\Nuendo 15\`），
   所以 `Get-Process -Name Nuendo` **查不到它、会误报"未运行"**。用名字+路径双重匹配：
   ```powershell
   Get-Process | Where-Object { $_.ProcessName -match '(?i)nuendo' -or ($_.Path -and $_.Path -match '(?i)nuendo') }
   ```
   （另一个坑：`Write-Host` 与管道输出的**打印顺序会交错**，看输出时别被带跑——按表头数对象，别按位置猜。）
3. 文件是 **UTF-8 无 BOM + CRLF**（Nuendo 自己的写法），且含有 Nuendo 自写的**未声明实体**
   （如 `&Euml;`），严格 XML 解析器会拒绝加载 → 改动要**按文本插入**、不要用 DOM 重写整份文件。
   判据：插入后把插入块抠掉，必须与原串**逐字符相同**。
4. 本机 shell 是 **Windows PowerShell 5.1（没有 `pwsh`）**；带中文的 `.ps1` 必须存成
   **UTF-8 带 BOM**，否则 5.1 按 ANSI(GBK) 解析、中文打乱后直接变成语法错误（报错信息里全是乱码）。
   同理，**读这个文件也要按 UTF-8**，否则中文宏名显示成乱码（那只是读法问题，不是文件坏了）。

### 5. 这套做法的边界（诚实说明）

- **命令编号对应的是预制列表的顺序，不是名字**。删掉或插入一个预制，后面全体移位 →
  所以固定用 8 套就别再插新的。
- **预制存在哪里我在这台机器上没查到确证**：偏好目录里只有"当前那一条 lane 布局"
  （`UserPreferences.xml` 里的 `controllerLaneSetup`，现在是一条 Height=191 的 **CC1** 轨道），
  没有预制库文件。**所以最保险是存进你的模板工程**：存好预制后**新建一个工程**看一眼预制还在不在
  —— 在 = 全局，不在 = 跟工程（那就让模板带上）。
- **命令最多到 16 套**；再多的预制只能用界面里的 Controller Lane Setup 菜单点。
- **不做状态回读**：手机上不会亮"现在显示的是第几套"。要那个得等 Bridge 有 MIDI 输入（spec §6）。

---

## 建"把当前选中轨道变成红色"的宏（PLE 预制 → Key Command → 宏 → Note）

**为什么不直接用 `Set Track/Event Color`**（Edit → Key Commands 里能搜到，默认 `Shift+Ctrl+C`）：
它会**弹出取色框等人点一下**。宏按下去只会把窗口留在那儿，手机按钮要的是"按一下就完成"，
所以走 **Project Logical Editor（PLE，工程逻辑管理器）**——它的颜色动作是**固定值**，不需要人再点。

> 这条链路有实测背书：Steinberg 论坛上有人用 **16 个 PLE 预制（每个一种颜色）+ 宏** 实现"给选中的轨道批量上色"，
> 原话见 [TIP! Setting incremental +1 colors on existing tracks](https://forums.steinberg.net/t/tip-setting-incremental-1-colors-on-existing-tracks/729892)。

### 步骤

**1. 先确认"红色"在工程的颜色表里**
`Project → Colors…`（本机命令名就叫 `Colors`）打开颜色表 —— 工厂色表是 `Color 1…16`，可以改名。
PLE 的 Set Color **只能从这张表里选**，所以"红色"必须真的在表里（不在就加一个/把某个改成红色）。

**2. 打开 PLE 并填两半（`Project → Project Logical Editor…`）**

上半是**过滤**（选出谁）：Filter Target / Condition / Parameter 1 / Parameter 2 / bool

| Filter Target | Condition | Parameter 1 |
|---|---|---|
| `Container Type is` | `Equal` | `Track` |
| （bool 列选 `And`） | | |
| `Property` | `Property is set` | `Track is selected` |

下半是**动作**（对它们做什么）：Action Target / Operation / Parameter 1 / Parameter 2

| Action Target | Operation | Parameter 1 |
|---|---|---|
| `Set Color` | `Set to fixed value` | 点开**选色器**挑红色（表里那个） |

- 用下半区的 **−** 把原有动作行清掉，只留 `Set Color` 这一条。
- `Container Type is = Track` 这条很重要：即使你**同时选中了事件**，也只会刷轨道、不会连事件一起刷。
- `Property is set → Track is selected` 保证只动**当前选中**的轨道 —— "当前选中轨道"就是这个按钮的全部语义。
- 参数 1 的确切措辞随版本略有差别（论坛里也有人写 `Event is selected` 照样工作，因为上面那条
  `Container Type = Track` 已经把范围限死了）。**点 `Apply` 先在工程里试一下**：该红的那条轨道变红、别的不动，就算对了。

**3. 存成预制**：PLE 窗口预设区 → 保存/Store Preset → 命名 `轨道变红`
（落到 `%APPDATA%\Steinberg\Nuendo 15_64\Presets\Project Logical Editor\…`；
手册也说预制存好后可以直接从 Project 菜单执行）。

**4. 给它一个键盘快捷键**：`Edit → Key Commands` → 分类 **`Process Project Logical Editor`**
（这个分类里就是 PLE 的预制清单，工厂预制逐条列在里面）→ 找到 `轨道变红` → 分配一个键。
_看不到就先重启 Nuendo —— 命令表是启动时读的（同"宏"那一节）。_

**5. 建宏**：和建 `test` 一样的地方新建宏 → 加一条命令 `Process Project Logical Editor → 轨道变红` → 命名 `轨道变红`
（宏就是"命令序列"：以后想再加"顺便跳到下一轨"之类，往同一个宏里继续加即可）。

**6. 挂到手机上**：MIDI Remote 映射助手 → 触发 Pad → 学 Note → 分配给这个宏。
不想开手机也能先验：`python tools\send_note.py --note <编号>`。

### 三个要点

- **颜色在"建预制时"就固定了**，所以这个按钮永远给同一个红，跟你当前调色板选着什么颜色无关 —— 这正是手机按钮要的确定性。
- 想再要"变绿/变蓝"，就复制这个预制改个颜色、再建一个宏、再挂一个 Note。16 色以内都不费事。
- PLE 改的是**工程数据**（轨道颜色），撤销是 Ctrl+Z 或 `Undo`；它不写任何配置文件，所以不涉及我们改配置那套坑。

---

## 把整套配置搬到另一台电脑（宏 + MIDI Remote 映射 + 手机布局）

**四样东西，位置都不同，缺一样就会"按钮按了没反应"：**

| # | 东西 | 位置（本机实测） | 备注 |
|---|------|------------------|------|
| 1 | **宏 + 键盘命令** | `%APPDATA%\Steinberg\Nuendo 15_64\Key Commands.xml` | 宏在 `<list name="Macros">`；另有官方通道 `File → Export Key Command Assignments` |
| 2 | **自建 PLE / LE 预制** | **`~\Documents\Steinberg\<产品>\User Presets\Project Logical Editor\*.xml`**（本机 8 个 `Set Red…Magenta`）<br>LE 的在 `…\User Presets\Logical Edit\` | ⚠️ **不在** APPDATA 的 `Presets\`（那是**工厂**预制的位置）；**按产品分目录**（Nuendo 的不能直接给 Cubase 用） |
| 3 | **MIDI Remote 设备定义** | `~\Documents\Steinberg\Nuendo\MIDI Remote\Driver Scripts\Local\DIY\PhoneMIDI\DIY_PhoneMIDI.json` | 48 条 `MidiBindingToNote`；`"FilterValue": "PhonePad"` = **输入端口按名字匹配** |
| 4 | **MIDI Remote 用户映射** | `~\Documents\Steinberg\Nuendo\MIDI Remote\User Settings\DIY_PhoneMIDI_<HASH>_globalmappings.json` | 25 KB；**文件名里的 HASH 原样保留** |
| 5 | **手机端按钮布局（本项目 Bridge）** | `%APPDATA%\phone-midi-bridge\`（`pad.json` 最关键） | Bridge 本体 `bridge\dist\MIDI Deck.exe` |

**已做过的跨产品演练（本机 Nuendo 15 vs Cubase 15，同日实测）**：

| 宏引用的命令 | Nuendo 15 | Cubase 15 |
|---|---|---|
| `MIDI :: Controller Lane Setup 1…5` | 有 | **有** ✓ 可直接搬 |
| `Process Project Logical Editor :: Set Red…Magenta` | 有 | **缺** ——不是因为命令不存在，而是**目标机还没这些预制**：把 8 个 xml 拷进 `Documents\Steinberg\Cubase\User Presets\Project Logical Editor\`，**开一次 DAW 关掉**（让它把预制登记进命令表）才会可解析 |

- 颜色是**按名字**引用的（`Set Red.xml` 里是 `<string name="String" value="Red"/>`）→ 目标机颜色表要有同名颜色；
  默认色表就含 Red/Yellow/Green/Blue/Purple/Pink/Cyan/Magenta ✓（改过色表要核对）。
- **顺序很重要：先拷预制 → 开关 DAW 一次 → 再装宏**。反过来装，宏会因为命令解析不了而不生效（静默）。

**唯一无法无损搬运的一项**：**控制器预制（Controller Lane Setup 1–5 的内容）**。
APPDATA 的 `Presets\`、Documents 的 `User Presets\`、`UserPreferences.xml` / `Defaults.xml` 里**都没有**它的定义
（偏好里只有"当前那一条 lane"的 `controllerLaneSetup`）→ 它只跟着**工程**走 ⇒ 目标机上必须重新 `Add Preset`
（每个约 30 秒），或者把工程/模板一起带过去。


> 路径里的 `Nuendo 15_64` **随版本变**（换了大版本就是 `Nuendo 16_64`），按新机器的实际目录名放。
> `Documents\Steinberg\Nuendo\...` 那一支**不带版本号**。

### ⚠️ 两个已实测的硬约束

1. **宏名一个字都不能改**。映射文件里是**按名字**引用目标的（本机 `Macro` 出现 13 次、`Command` 99 次）。
   改名 = 那条按钮静默失效（不报错、就是没反应）。
2. **宏名必须是 ASCII**。实测：中文命名的宏写进 `Key Commands.xml` 后，Nuendo 启动→退出一轮就被丢掉；
   同命令、只把名字换成 ASCII（`CC1 Lane Preset`）就留住了（映射文件里也只见 ASCII 那个名字）。

### 新电脑上的顺序（顺序错了会白折腾）

1. 装 **loopMIDI**，建**同名**端口：**`PhonePad`**（必须与设备 JSON 里的 `FilterValue` 完全一致）+ 推子那个端口
2. 拷 Bridge 与它的配置（`%APPDATA%\phone-midi-bridge\`）→ 启动、选好端口
3. ⚠️ **新建的 loopMIDI 端口在 Nuendo 里可能看不见**（`Port Setup.xml` 里只有 DirectMusic 条目）
   → **管理员重启 `Restart-Service midisrv`，再启动 DAW**（旧端口没这个毛病，原因见上面「面板端口在 Nuendo 里看不见时」）
4. 装**同版本** Nuendo（`Presets\*.xml` 里带 `AppVersion` 字段，跨版本可能被清洗）
5. 把上表 1–4 拷到位（**先备份新机器自己的** `Key Commands.xml`，如果你是整份覆盖）
6. 启动 Nuendo → 按下表核对

### 迁移后核对清单（每条都有判据）

| 查什么 | 怎么查 | 期望 |
|---|---|---|
| 宏都在 | Key Commands 对话框的 Macro 列表数个数；或 `Key Commands.xml` 里搜宏名 | 个数与本机一致（本机 5 个工厂宏 + 你自己那些） |
| 设备在 | 工作室 → MIDI Remote 管理器 | 有 `PhoneMIDI`，输入端口 = `PhonePad` |
| 映射在 | 读 `User Settings\DIY_PhoneMIDI_*_globalmappings.json` | `Macro` 引用数与旧机一致（本机 **13**） |
| 端口真的通 | `python tools\send_note.py --port PhonePad --note 60` | DAW 里有反应 |
| 整链通 | 手机按一格 | 宏执行；**没反应就先用上一条把"手机侧"和"DAW 侧"分开** |
| 音符对得上 | 手机格子上的 `N` 号 vs DAW 侧学到的 Note | 一致（不一致说明 `pad.json` 没跟着搬，或被改过） |

### 最容易漏的三件

- **CC 廊那个"控制器预制"**（`Controller Lane Setup 1`）在偏好目录里**没找到** → 它大概率**跟着工程/模板**，
  新电脑要么重新 `Add Preset`，要么把**模板工程**一起带过去。
- **`pad.json` 与 DAW 映射是一对**：新电脑上若重新排布格子导致音符编号变了，DAW 侧就得**重学**；
  连 `pad.json` 一起搬最稳（"位置不出音符"这件事只有在本项目里成立，DAW 只认 Note）。
- **推子/面板端口名**：设备 JSON 是按**名字**认端口的，新机器上端口叫别的名字（如 `loopMIDI Port 1`）
  就永远收不到消息 —— 先在 loopMIDI 里改成同名，再开 DAW。

---

## 建"一键跳到某个标记（marker）"的宏

**命令表里直接有编号跳转**，一条命令一个标记，全在 **`Transport`** 分类：

| 手机格子（第 6 页「Mark跳转」） | 触发编号 | MIDI Note | 宏里放的命令 |
|---|---|---|---|
| 第 1 格 | 40 | **76** | `To Marker 1` |
| 第 2 格 | 41 | **77** | `To Marker 2` |
| 第 3 格 | 42 | **78** | `To Marker 3` |
| 第 4 格 | 43 | **79** | `To Marker 4` |
| 第 5 格 | 44 | **80** | `To Marker 5` |
| 第 6 格 | 45 | **81** | `To Marker 6` |
| 第 7 格 | 46 | **82** | `To Marker 7` |
| 第 8 格 | 47 | **83** | `To Marker 8` |

步骤：新建 8 个宏（每个**一条**命令）→ 映射助手把 Note 76…83 逐个分配给它们。
**如果映射助手的功能列表里能直接看到 `To Marker 1` 这类命令，就不用建宏**，直接分配即可
（能不能看到取决于它列不列 Key Command —— 和前面宏那次一样，以你界面为准）。

### 用位置标记还是循环标记

命令表里两族都有（都在 `Transport`）：

| 类型 | 命令 | 语义 |
|---|---|---|
| 位置标记（position marker） | `To Marker 1` … `To Marker 9` | 把光标/播放头**跳到**编号 N 的标记 |
| 循环标记（cycle marker） | `To Cycle Marker 1` … `To Cycle Marker 9` | 跳到编号 N 的循环标记 |
| | `Recall Cycle Marker 1` … `9` | 把**左右定位器**设到该循环标记（通常是"跳过去并圈住这一段"） |
| | `Zoom Cycle Marker 1` … `9` | 跳到并缩放到该循环标记 |
| 逐格走 | `Locate Next Marker` / `Locate Previous Marker` | 在所有标记之间前后走（两个按钮就够用） |

只想先要两个"上一个/下一个"按钮的话，最后那一对最省事。

### 三个必须知道的点

1. **跳的是"编号"（Marker ID），不是列表顺序**。默认按创建顺序给 1、2、3…，但可以改。
   所以按下去跳到哪儿不对，就用 **`Transport → Open Markers`** 打开标记窗口核对编号，
   或用 `Set Marker 1` … `Set Marker 9` 把编号重新指到你要的位置（这两条的准确行为先按一次核对）。
2. **直接编号跳转只到 9**（`To Marker 1..9`；另有 `To Marker X` / `To Marker with Take No. X`
   两个特殊条目）。**需要超过 9 个跳转点就用 Arranger 轨**：`Arranger → Trigger Arranger Event 1..20`
   （20 个，同样是绝对编号，分类在 `Arranger`）。
3. **想"跳过去就开始播"**：往同一个宏里再加一条播放命令（`Transport → Start`；别用 `StartStop`，
   那是开关）。按一次核对它是不是"开始播放"。

---

## 建"一键把量化设置成某个长度"的宏（以 1/4 为例）

**这条最简单：不用建任何预制，Nuendo 自带 8 条命令，正好对上第 4 页那八格。**

| 手机格子 | 触发编号 | MIDI Note | 宏里放的命令（分类 `MIDI Quantize`） |
|---|---|---|---|
| 第 1 格 | 24 | 60 | `Set Quantize to 1th` |
| 第 2 格 | 25 | 61 | `Set Quantize to 2th` |
| 第 3 格 | 26 | 62 | `Set Quantize to 4th` ← 1/4 |
| 第 4 格 | 27 | 63 | `Set Quantize to 8th` |
| 第 5 格 | 28 | 64 | `Set Quantize to 16th` |
| 第 6 格 | 29 | 65 | `Set Quantize to 32th` |
| 第 7 格 | 30 | 66 | `Set Quantize to 64th` |
| 第 8 格 | 31 | 67 | `Set Quantize to 128th` |

步骤（一个长度一个宏）：

1. 和建 `test` 一样的地方新建宏（**Macros**）→ 命名 `量化 1/4`
2. 加**一条**命令：分类 **`MIDI Quantize`** → `Set Quantize to 4th`
3. 想让按钮"设好并且立刻量化"，再往同一个宏里加一条：分类 **`MIDI`** → `Quantize`（**这是可选**：
   不加 = 只改设置，之后照常用你自己的量化键；加了 = 按下就既设好又量化）
4. 映射助手 → 触发 Pad → 学 Note → 分配给这个宏（上表）
5. 验：在卷帘窗里按一下（或 `Edit → Macros`），看工具栏量化显示变成 `1/4`；再 `python tools\send_note.py --note 62`

### 一个必须知道的限制：直音 / 三连 / 附点是**另外两个开关**

- `MIDI Quantize` 分类里另有 `Toggle Quantize Triplet`、`Toggle Quantize Dotted`。
  **如果它们开着，`Set Quantize to 4th` 得到的是 1/4T 或 1/4 附点，而不是直音 1/4。**
- 命令表里**没有"强制关闭"这两个开关的命令**（只有 Toggle），所以宏只能保证"把值设成 1/4"，
  不能保证"直音 1/4"。⇒ **用之前确认这两个开关是关的**（或者把它们也放进宏 —— 但 toggle 是
  "偶数次等于没按"，当条件用不可靠）。
- 判据（10 秒测出来）：把两个开关关掉按一次 `Set Quantize to 4th`，看显示是不是 `1/4`；
  再打开 Triplet 按一次，看它是变成 `1/4T` 还是仍回到 `1/4` —— 前者说明开关确实会影响结果。

### 想用**自己命名的量化预制**（带 swing 之类）

命名预制没法用一个按钮直接选中（命令表里只有 8 个长度值 + `Select Next Quantize` /
`Select Prev Quantize`）。两个办法：
- 用 `MIDI → Quantize Setup` 打开量化面板，把常用的存成预制，然后在工具栏下拉里点选（手动）；
- 或者用"上一个 / 下一个量化"两个按钮在下拉列表里遍历 —— 顺序固定，所以是确定的相对移动，
  但不如上面 8 个**绝对长度**的按钮稳（列表顺序一变就错位）。

量化值是**工程设置**（随工程保存），所以不涉及我们改配置那套坑，也没有"重启才生效"的问题。

---

## 建"把选中音符设成固定长度"的宏（以 1/4 为例）

> 与上一节的区别：上一节改的是**量化设置**（工具栏那个值），本节改的是**音符本身的长度**。


三条路，**推荐第一条**（确定性最好、且以后能随便改成 1/8、1/2）：

### 路 A（推荐）：MIDI Logical Editor 预制

1. `MIDI → Logical Editor…`（注意是 **LE**，不是 Project 菜单里的 PLE）
2. **Filter**（上半，清空后填）：
   | Filter Target | Condition | Parameter 1 |
   |---|---|---|
   | `Type` | `Equal` | `Note` |
   | *（bool `And`）* | | |
   | `Property` | `Property is set` | `Event is selected` |
3. **Action**（下半，清空后填）：`Length` | `Set to fixed value` | **480**
4. ⚠️ 窗口上方当前模式必须是 **Transform** —— 手册明确：Delete 模式下**动作列表会被忽略**
5. 存预制：预设区 Save/Store → 命名 `音符 1_4`（名字里别用 `/`、`\`）
6. `Edit → Key Commands` → 分类 **`Process Logical Preset`** → 找到 `音符 1_4` → 分配一个键
   （看不到就重启 Nuendo：命令表是启动时读的）
7. 建宏 → 加命令 `Process Logical Preset → 音符 1_4` → 命名 `音符 1/4`
8. 映射助手 → Note → 分配给这个宏；先用 `Edit → Macros` 或键盘键单测，再上手机

**为什么分类名是这些（可自证）**：你机器上 `Process Logical Preset` 分类里的条目名与
`Presets\Logical Edit\**\*.xml` 的文件名**一一对应**（例：`Increase Length +10 Ticks` ↔
`\Notes Length\Increase Length +10 Ticks.xml`）；PLE 同理对应 `Presets\Project Logical Editor\**`。
所以"预制 ↔ 可按键命令"这条映射是用你自己的工厂数据验证过的。

### 路 B（零预制，两条内置命令）

宏 = [`MIDI Quantize → Set Quantize to 4th`] + [`Quantize Lengths`]（两条都在 `MIDI` 分类）。
省事，但有两个前提**要在你机器上按一次确认**：① `Toggle Quantize Dotted` / `Toggle Quantize Triplet`
没开着；② `Quantize Lengths` 确实按"当前量化值"改长度。副作用：它会把**全局量化值**改成 1/4。

### 路 C（也是两条命令）

[`Set Insert Length → 4`] + [`Fixed Lengths`]。手册原文（[Fixed Lengths](https://steinberg.help/cubase_pro_artist/v9/en/cubase_nuendo/topics/midi_processing/midi_processing_lengths_fixed_c.html)）：
> This function resizes all selected notes to the length set with the **Length Quantize pop-up menu on the MIDI editor toolbar**.

你命令表里 `Set Insert Length` 那一组正好是 `T . 1 2 4 8 16 32 64 128`，选 `4` 就是 1/4。
**判据**：宏跑完音符真变成 1/4 就成立；没变就说明那条命令不是它读的值 → 走路 A。

### 长度 ↔ ticks 对照（1/4 = 480 已在你机器上验证）

Nuendo 内部 **480 ticks = 1/4 音符**。证据：工厂预制
`Presets\Logical Edit\Notes Length\Randomize Length to 4th +-10%.xml` 里存的两个十进制值是
**432 / 528**，正是 480 的 ±10%。

| 音符 | ticks | 音符 | ticks |
|---|---|---|---|
| 1/1 | 1920 | 1/8 | 240 |
| 1/2 | 960 | 1/16 | 120 |
| **1/4** | **480** | 1/32 | 60 |

附点 ×1.5（1/4 附点 = 720）、三连 ×2/3（1/4 三连 = 320）。

---

## 映射不生效时：先读配置，别猜

Nuendo 把 MIDI Remote 设备与分配存在文本 JSON 里，直接看比在界面里翻快得多：

| 文件 | 看什么 |
|------|--------|
| `~\Documents\Steinberg\Nuendo\MIDI Remote\Driver Scripts\Local\DIY\<设备名>\*.json` | `DetectionInputNameFilterEquals`（输入端口）、`MidiBindingToNote` 的 `ChannelNumber`（0-based）与 `Pitch`、`SurfaceElements` 的元素类型（`Button` / `TriggerPad` / `Fader`） |
| `~\Documents\Steinberg\Nuendo\MIDI Remote\User Settings\DIY_<设备名>_*_globalmappings.json` | `ValueBinding`：`HostValue` 指向哪个宿主值（如 `StopValue`）、`Type`（`Toggle` / `Absolute` …） |

**两条经验**（都来自真机）：

1. **绑"命令 / 宏"比绑"运输状态值"可靠**。宏是"按下即执行一次"，与瞬时触发天然吻合；
   `Transport.Stop` 是**状态值**，Steinberg 工厂脚本里它配的是 `MR_Button`（见
   `midiremote_factory_scripts\Public\*\*.js`：`makeValueBinding(btnStop.mSurfaceValue, mTransport.mValue.mStop).setTypeToggle()`）。
   用 `TriggerPad` + 状态值这条路，在真机上不生效；换成**命令 / 宏**立刻可用。
2. **判据先分开**：用 `python tools\send_note.py --port PhonePad` 直接往面板端口发一条 Note。
   它能停 = DAW 侧没问题（去查手机 → Bridge 那一段）；它不停 = DAW 侧的绑定问题。

## 没反应怎么查

| 现象 | 查什么 |
|------|--------|
| **按按钮时音源/乐器轨跟着弹音** | 面板与推子共用了端口（音源轨是 OMNI，通道 16 也照收）。见上一节：给面板单开一个端口，**不要**去取消推子端口的 All MIDI Inputs |
| 手机格子点不动 / 显示未连接 | Bridge 是否已按 START；手机上打开的地址是否是 Bridge 显示的那个 URL |
| 点得动但不执行 | ① 端口：Nuendo 的设备输入端口 = Bridge 状态卡上的那个名字？② 通道：是否按通道 16 过滤了？③ 学到的消息是不是 **Note**（不是 CC/Bend）？④ 编号是否对得上（手机格子右下角的 N 号） |
| 按一下执行了两次 | 宏里是否含"切换"类命令；一次按下只发一条 Note On（松开发 Note Off），映射助手只应绑 Note On |
| 松开后 DAW 里 Note 一直亮 | 属于异常：Bridge 有 1 秒兜底会自动补 Note Off；若持续出现请记录现象 |
| 换了台手机连不上新页面 | 手机缓存的是旧版前端：`web/*` 改动后要把 `?v=` 升版并重打包 exe，然后关掉旧 exe 重新启动 |
