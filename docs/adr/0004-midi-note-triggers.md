# ADR 0004: 快捷键面板的触发经 MIDI Note 进入 DAW，不做键盘注入

## 日期

2026-09-18

## 状态

已采纳，待实现（[spec/shortcut-pad.md](../spec/shortcut-pad.md)）。
Nuendo 15 实测：MIDI Remote 可把一条 **Note 分配给任意宏**；控制元素可选"触发 Pad"。
端到端"宏真的执行"用 `tools/send_note.py` 验证。

## 背景

要把手机/平板当作 DAW 的宏命令按钮阵列（参照 Stream Deck）。手机点一下 = DAW 里一个宏执行。
手机 → Bridge → loopMIDI 这条管道已经存在，但它今天只会发 **CC 与 Pitch Bend**：
`WinMidi` 只有 `send_cc()` 与 `send_pitch_bend()`，没有 note，也**完全没有 MIDI 输入**。

于是有个真问题：**"一次点击"应该用什么形式离开 Bridge？**

- 如果走键盘注入（`SendInput` 打进 Nuendo 的 Key Command），DAW 侧零配置——听起来最省事。
- 如果走 MIDI，DAW 侧要为每个按钮做一次映射——听起来更麻烦。

这个决定会影响协议字段、Bridge 的 MIDI 层、DAW 侧的一次性配置，以及"这个工具能不能用在别的 DAW 上"，
所以必须记下来。

## 决策

**触发以 MIDI Note 离开 Bridge；DAW 侧用 MIDI Remote 把该 Note 分配给宏。Bridge 不注入键盘。**

### 1. 线上形式

手机 → Bridge（沿用 ADR 0003 的显式声明原则，不靠来源嗅探）：

```json
{ "kind": "trigger", "id": 3 }
```

Bridge → DAW：**Note On（按下）+ Note Off（抬起），通道 16，音符 36 + id**。

- 选 **Note** 而不是 CC：Mode A 正在发 CC1，**CC 会和推子撞车**（误触一下就动了推子）；
  而且 CC 语义是连续量，触发是离散事件。
- 选**通道 16**：把触发与推子的通道分开，DAW 侧可以用通道过滤隔离。
- `Note Off` 一起发：宏通常只关心 Note On，但成对发送零成本，且为将来"按住期间生效"留出可能。

### 2. DAW 侧

MIDI Remote（映射助手）→ 学到该 Note → 分配给宏。**Generic Remote** 为替代路径。
宏在 Nuendo 里本身就是一个 Key Command，而 MIDI Remote 能把任意 Key Command 分配给 MIDI 消息；
本决定不要求用户为宏额外分配键盘快捷键。

### 3. 编号与动作层

- 触发编号由**格子位置**决定（`id = 页号 × 8 + 序号`），在手机与 PC 编辑器上都只读显示。
- `{id → 动作}` 的动作表住在 **Bridge 侧**，v1 只有 `note` 一种动作类型。
  将来若需要按键注入等其它类型，**手机端协议不变**。

## 备选方案

### 方案 A：Bridge 注入键盘（SendInput 打 Key Command）

- 优势：DAW 侧零配置；能驱动任何程序的任何快捷键；不占用 MIDI 端口。
- 劣势：**必须保证焦点在 Nuendo**——焦点不在时按键会打进别的窗口，可能是破坏性的；
  每个宏必须先有一个键盘快捷键组合；Windows 专属，与"或者其他 DAW / 跨平台"矛盾；
  且它把工具从"MIDI 控制器"变成"HID 模拟器"，与产品定位不符。
- **否决**，但保留为动作表里的第二种动作类型（见决策第 3 条），只在某个宏确实无法 MIDI 映射时启用。

### 方案 B：触发也走 CC

- 优势：复用现有 CC 管道，Generic Remote 对 CC 更友好。
- 劣势：与 Mode A 的 CC1 撞车（同一个端口、同一类消息），误触即动推子；连续量语义不适合离散触发。
- **否决**。

### 方案 C：在 DAW 侧写脚本/虚拟设备直接执行命令

- 优势：可以读 DAW 状态（轨道名、颜色），能做 LED 回读。
- 劣势：每个 DAW 一套脚本，直接违背"或者其他 DAW"；工作量与维护成本最高。
- **否决**（回读留作未来的非目标之外的可能，需要先给 Bridge 加 MIDI 输入）。

## 影响

- **前端**：新增独立页面 `/pad.html` + `pad.js`，主页加入口链接；`?v=` 升版；exe 重打包。
- **Bridge**：`_process()` 增加 `trigger` 分支；新增动作表与布局存储（`%APPDATA%\phone-midi-bridge\pad.json`）；
  连接时与编辑后广播布局；GUI 增加编辑器窗口。
- **协议**：`kind` 取值域由 `{cc, pb}` 扩展为 `{cc, pb, trigger}`；旧客户端不受影响（新增类型）。
- **兼容**：现有 A/B/C 链路与消息格式不变。
- **解锁**：任何支持 MIDI 映射的 DAW 都能用；`id → 动作` 的分层让"一次按下做多件事"将来可以在 Bridge 侧实现
  而不动手机端协议（但复合逻辑优先写进 DAW 的宏，见 spec D10）。
- **未做**：状态回读（需要给 Bridge 增加 MIDI 输入，本次非目标）。
