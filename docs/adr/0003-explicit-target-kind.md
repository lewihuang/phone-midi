# ADR 0003: 输出类型由协议显式声明，废弃来源坐标嗅探

## 日期

2026-09-17

## 状态

已采纳并实现（2026-09-17）。协议端到端验证 10/10 通过，
见 [changelog 2026-09-17](../changelog/2026-09-17_mode-c-pitch-bend.md)。

## 背景

[ADR 0002](0002-json-mapping-config.md) 定义了 mapping 的 `source`（传感器 + 轴）与 `target`（CC 编号 + 通道），
但**没有定义"目标是 CC 还是 Pitch Bend"**。实现里这一信息是靠**来源坐标嗅探**补上的：

```python
# bridge/server.py
pb_mode = (sensor == "accelerometer" and axis == "x")
```

这带来三个具体问题：

1. **来源与目标被错误耦合**：`accelerometer` 的 `x` 轴**永远**只能发 Pitch Bend，
   无法映射为 CC；反之其它来源永远发不了弯音。
2. **同一功能的两半互不兼容**：`docs/spec/mode-c-shake.md` 与真机样本
   （`docs/json.json` 的 `recommended_mapping.axis`）都规定手机端上送 `axis:"fused_shake"`，
   而嗅探只认 `x`。**一旦按 spec 接线，Bridge 会走 `send_cc()` 发出 CC1 Ch1 的 0–127**；更糟的是
   `web/app.js` 对 `pb:true` 的模式从不发送 `set_target`，该 CC 编号完全不受控 ——
   这是"看起来能用、实际串到别的参数上"的静默错误。
3. **无法表达多路控制的意图**：将来"一部手机同时控制多个参数"时，同一来源可能需要
   面向不同目标类型，嗅探式规则无法表达。

此外还有一个未被表达的概念：A/B 上送的 `t∈[0,1]` 是 **0=起点、1=终点**（推子语义），
C 上送的 `t∈[0,1]` 是 **0.5=中心**（弯音语义）。两者线格式相同、中点含义相反，
目前只能靠 `pb_mode` 这个布尔量隐式区分，语义藏在嗅探规则里。

## 决策

**输出类型与数值语义都由消息显式声明；配置可提供缺省值；嗅探规则进入废弃流程。**

### 1. 运行时消息（手机 → Bridge）

```json
{ "sensor": "accelerometer", "axis": "fused_shake", "value": 0.62,
  "kind": "pb", "value_kind": "bipolar" }
```

| 字段 | 取值 | 含义 |
|------|------|------|
| `kind` | `"cc"` \| `"pb"` | **输出类型**。取代来源坐标嗅探。缺省 `"cc"` |
| `value_kind` | `"unipolar"` \| `"bipolar"` | **数值语义**。`unipolar`：0=起点、1=终点（A/B 推子）；`bipolar`：0.5=中心（C 弯音）。缺省 `"unipolar"` |

`value_kind` 让 mapping 引擎能正确整形：`unipolar` 用端点夹持，`bipolar` 用中心死区与双向对称钳制。

### 2. 配置文件（`bridge/config/*.json`）

mapping 的 `target` 增加 `type` 字段：

```json
"target": { "type": "pb", "cc": 1, "channel": 0 }
```

- 缺省 `"cc"`，与现有配置文件完全兼容。
- 供 Bridge 侧预设声明目标类型；`type:"pb"` 时忽略 `cc`。
- 运行时消息的 `kind` **优先于**配置的 `target.type`（允许同一 mapping 被不同模式以不同方式使用）。

### 3. 兼容与废弃

- `kind` 缺失时回退旧嗅探规则（`sensor=="accelerometer" and axis=="x"` → `pb`），
  并记一条 deprecation 日志。
- **移除条件**：`web/index.html` 的脚本版本号升至 v13 后的下一个版本可移除嗅探
  （届时旧缓存页面已不可能存在）。

### 4. 附带修正

`MappingEngine.process()` 中"跳过 Bridge 端平滑"的轴集合 `fused_phone` 目前是
`("fused_lift", "fused_flip")`。规则应改为：**凡以融合标量 `t` 上送的轴一律不过 Bridge 平滑**
（平滑属于手机端职责，因为只有那里能看到真实采样率），因此 `fused_shake` 必须纳入该集合。
否则 Bridge 会对已经是 `t` 的量再做一次 EMA，与手机端的 One Euro 叠加成双重延迟。

## 备选方案

### 方案 A：保持现状（来源坐标嗅探）

- 优势：零改动
- 劣势：背景中的三个问题都成立；其中问题 2 是**静默数据错误**（发到错误的 CC 上），
  排查成本极高。否决。

### 方案 B：用 axis 命名约定表达类型（如 `fused_shake` 恒为弯音）

- 优势：改动最小，只需把嗅探的字符串换掉
- 劣势：把输出类型编码进**来源名称**，与问题 1 同类错误；无法表达"同一轴不同目标"；
  且 `fused_lift`/`fused_flip` 是推子、`fused_shake` 是弯音，这种差异是**目标**属性而非**来源**属性，
  命名约定会在多路控制时立刻失效。否决。

### 方案 C：只改配置，运行时消息不带 `kind`

- 优势：协议不变，向后兼容压力最小
- 劣势：mapping 匹配以 `sensor + axis` 为键，配置只能让"某轴"固定为一种目标类型；
  而模式是运行时切换的（A/B/C 复用同一 Bridge），届时必须改配置文件才能切换目标。
  保留配置作为**缺省值**（决策第 2 条），但不足以单独承担运行时语义。部分采纳。

## 影响

- **前端**：`web/app.js` 需在发送时带上 `kind` 与 `value_kind`；`web/index.html` 脚本版本号升版。
- **兼容**：旧客户端（无新字段）仍可用，走回退嗅探路径 + deprecation 日志。
- **解锁**：多路同时控制（一机多 CC / CC + 弯音并存）的前置条件；
  协议里不再需要"某个来源 = 某种目标"的隐式约定。
- **文档**：修订 ADR 0002 中 `target` 的字段说明（增加 `type`）；
  [Mode C 方案](../spec/mode-c-shake.md) 第 3 节由"建议"变为"已定"。
