# Mode A 多轴融合标定 — 方案与步骤分解

> 状态：Phase 1–7 已实现  
> 创建：2026-07-08  
> 修订：2026-07-09（用户校准页 + Mode A 融合上线）  
> 页面：`/fusion-calibrate.html`  
> 关联：`docs/roadmap.md` Phase 2「多轴融合 → 单 CC」

---

## 1. 背景与动机

### 问题

Mode A（倾斜推子）目前只读取 `DeviceOrientation` 的 **beta（pitch）** 单轴。抬手时手机往往 **beta 与 gamma 同时变化**，单轴控制显得死板。

### 产品目标（已确认）

多轴姿态数据需 **拟合成一个标量**，再 **线性映射到 CC [0, 127]**，最终仍是 **一条 CC、一个推子**——不是 pitch/roll 各控一个 CC。

### 端点语义（已确认）

| 端点 | 姿态 | CC |
|------|------|-----|
| **MIN** | 自然垂手（握持，手臂下垂） | **0** |
| **MAX** | 抬手最高（舒适上限） | **127** |

### 策略

**先标定、后融合、再上线**：

1. 独立调试页标定 MIN/MAX 端点（二维姿态点 `(β, γ)`）
2. 调试页实时预览融合标量 `t ∈ [0, 1]` 与模拟 CC
3. 可选录制抬手轨迹，验证单调性
4. 导出融合配置 JSON
5. 主控制页 Mode A 发送融合标量；Bridge 仍用 **单条 mapping**（`in_min=0`, `in_max=1` 或等价范围）

调试页与主控制页 **零 JS 耦合**——不修改 `app.js` 直至标定完成。

---

## 2. 目标与非目标

### 目标

| # | 目标 |
|---|------|
| G1 | 标定两个端点：自然垂手 → CC 0，抬手最高 → CC 127 |
| G2 | 实时显示原始 `β/γ`、融合标量 `t`、模拟 CC 0–127（与产品行为一致） |
| G3 | 支持可调融合公式（默认：端点投影），便于在真机上对比 |
| G4 | 支持轨迹录制，检查抬手过程中 `t` 是否单调递增 |
| G5 | 导出 `phone-midi/fusion-calibrate/v1` JSON，供 Mode A 实现引用 |
| G6 | 独立 HTML/JS 页面，不连接 WebSocket、不发送 MIDI |

### 非目标（本阶段不做）

- 不做「pitch → CC11、roll → CC1」双 mapping 并行
- 不修改 Bridge 融合逻辑（融合在 phone 端完成，Bridge 只收一个 float）
- 不接入陀螺仪角速度（`rotationRate`）
- 不做跨设备自动校准
- 不做持久化存储（会话内存即可）

### 已废弃方案

~~`phone-midi/pose-debug/v1`~~：按命名姿势分别抓拍 β/γ 表格，推导分轴 `in_min/in_max`。  
现有 `web/pose-debug.html` 为该废弃方案的实现，**待重写或替换**为本文档设计。

---

## 3. 现状分析

### 3.1 主控制页

`web/app.js` Mode A 仍只发送 `event.beta` → `{ axis: 'pitch', value }`。本调试阶段 **不修改**。

### 3.2 Bridge

`bridge/config/default.json` 单条 mapping + `MappingEngine._apply_mapping` 已将 `[in_min, in_max]` 线性映射到 `[0, 127]`。  
融合标定完成后，手机发送 `t ∈ [0, 1]`，配置 `in_min: 0`, `in_max: 1` 即可，**无需新增 mapping 条目**。

### 3.3 传感器字段

| 字段 | 域名 | 抬手动作中的角色 |
|------|------|-----------------|
| `beta` | pitch | 多轴融合输入之一 |
| `gamma` | roll | 多轴融合输入之一 |
| `alpha` | yaw | 仅调试展示，不参与融合 |

导出 JSON 须记录 `screen.orientation.type`；标定与使用期间保持 **竖屏**。

---

## 4. 融合模型

### 4.1 默认：端点投影（endpoint_projection）

标定得到：

```
P_min = (β_min, γ_min)   ← 自然垂手，t = 0
P_max = (β_max, γ_max)   ← 抬手最高，t = 1

d = P_max - P_min
P = (β, γ)               ← 当前读数

t_raw = dot(P - P_min, d) / dot(d, d)
t     = clamp(t_raw, 0, 1)
CC    = round(t × 127)
```

性质：

- beta、gamma 同时参与，输出 **一个** 标量
- 端点标定即定义「抬手轴」在姿态平面上的方向
- 垂手=0、抬最高=127，无需 reverse 曲线（除非用户显式开启「反转 CC」选项）

### 4.2 备选：加权线性（weighted_linear）

用于对比调试，非默认上线公式：

```
t = clamp(wβ · norm(β) + wγ · norm(γ), 0, 1)
```

其中 `norm` 由 MIN/MAX 端点在对应轴上的投影范围归一化。权重 `wβ + wγ = 1` 可在调试页滑动调节。

### 4.3 死区（可选，Phase 6 主控制页）

在 `t` 接近 0 或 1 时应用小死区，减少静止抖动。标定阶段先不加，以观察 raw 行为为准。

---

## 5. 调试页设计

### 5.1 访问路径

```
https://<host>:<port>/fusion-calibrate.html
```

主控制页保留纯 HTML 链接；**不共享** `app.js`。

### 5.2 UI 布局

```
/fusion-calibrate.html
┌─ 返回主控制页 ─────────────────────────────┐
│ Mode A 融合标定（不连接 Bridge）             │
│ 自然垂手 = 0　·　抬手最高 = 127              │
└────────────────────────────────────────────┘

┌─ 标定端点 ─────────────────────────────────┐
│  [标定为 MIN (0)]    [标定为 MAX (127)]     │
│  MIN: β=— γ=—  未标定                       │
│  MAX: β=— γ=—  未标定                       │
└────────────────────────────────────────────┘

┌─ 融合预览 ─────────────────────────────────┐
│  融合 t:  0.42          模拟 CC:  53        │
│  ████████████░░░░░░░░░░░░  0 ──────── 127   │
│  原始: β=45.2°  γ=-12.1°                    │
└────────────────────────────────────────────┘

┌─ 融合参数 ─────────────────────────────────┐
│  模式: [端点投影 ▼]                          │
│  （加权模式）wβ / wγ 滑条                    │
│  [ ] 反转 CC（127↔0，一般不需要）            │
└────────────────────────────────────────────┘

┌─ 轨迹录制 ─────────────────────────────────┐
│  [开始录制]  [停止]   128 点 / 3.2s          │
│  ┌ t 随时间（标记非单调回跳）────────────┐  │
│  └───────────────────────────────────────┘  │
└────────────────────────────────────────────┘

[复制融合配置 JSON]  [清空标定]
```

### 5.3 端点标定交互

| 操作 | 说明 |
|------|------|
| 标定为 MIN (0) | 用户保持 **自然垂手**，点击后 400ms 窗口内对 `(β, γ)` 取平均，写入 `anchors.min` |
| 标定为 MAX (127) | 用户保持 **抬手最高**，同上，写入 `anchors.max` |
| 重新标定 | 覆盖对应端点，融合预览立即更新 |
| 前置条件 | 两点均已标定后，才启用融合预览与轨迹录制 |

### 5.4 轨迹录制

- 用户 **缓慢** 从垂手抬至最高（或往返一次）
- 采样约 20–30 Hz，每点记录 `{ t_ms, beta, gamma, fused_t, cc_sim }`
- 停止后计算 **单调性**：`t` 下降次数、最大回跳幅度
- 若 violations 过多，提示调整握姿或尝试加权模式

### 5.5 用户校准页（`/calibrate.html`）✅

面向普通用户的三步向导，**不展示** β/γ、融合参数、轨迹、JSON。

**入口**：主控制页「启动传感器」下方 **「校准设备」** 按钮。

```
步骤 1  确认最低位置 (0)  — 自然垂手 → [确认]
步骤 2  确认最高位置 (127) — 抬手最高 → [确认]
步骤 3  试一下            — CC 推子预览 → [完成校准]
        ↑ [上一步：重新确认最高位置] → 步骤 2（可再次确认最高）
        ↑ [上一步：重新确认最低位置] → 步骤 1（可再次确认最低）
         ↓
    localStorage (phone-midi/calibration/v1)
         ↓
    自动返回主控制页，Mode A 读取并使用
```

| 页面 | 路径 | 受众 |
|------|------|------|
| 用户校准 | `/calibrate.html` | 所有用户 |
| 开发者调试 | `/fusion-calibrate.html` | 调参、导出 JSON、录轨迹 |

共享模块：`web/fusion.js`（融合算法、采样、`localStorage` 读写）。

---

## 6. 数据模型

### 6.1 端点

```typescript
interface AnchorPoint {
  beta: number;
  gamma: number;
  capturedAt: string;   // ISO 8601
  sampleCount: number;
}
```

### 6.2 导出 JSON（`phone-midi/fusion-calibrate/v1`）

```json
{
  "schema": "phone-midi/fusion-calibrate/v1",
  "device": {
    "userAgent": "Mozilla/5.0 ...",
    "platform": "iPhone"
  },
  "session": {
    "orientation": "portrait-primary",
    "startedAt": "2026-07-08T14:00:00.000Z"
  },
  "endpoint_semantics": {
    "min_pose": "自然垂手",
    "min_cc": 0,
    "max_pose": "抬手最高",
    "max_cc": 127
  },
  "anchors": {
    "min": { "beta": 78.5, "gamma": -12.0, "capturedAt": "...", "sampleCount": 26 },
    "max": { "beta": 10.0, "gamma": -15.0, "capturedAt": "...", "sampleCount": 24 }
  },
  "fusion": {
    "mode": "endpoint_projection",
    "reverse": false,
    "weights": { "beta": 1.0, "gamma": 0.0 }
  },
  "trajectory": {
    "duration_ms": 3200,
    "sample_count": 96,
    "monotonicity": {
      "violations": 1,
      "max_regression": 0.04
    },
    "samples": [
      { "t_ms": 0, "beta": 78.1, "gamma": -11.8, "fused_t": 0.02, "cc_sim": 3 }
    ]
  },
  "recommended_mapping": {
    "sensor": "rotation_vector",
    "axis": "fused_lift",
    "value_range": [0.0, 1.0],
    "notes": "Phone computes fused t; Bridge in_min=0, in_max=1 → CC 0-127"
  }
}
```

### 6.3 用户校准存储（`phone-midi/calibration/v1`）

```json
{
  "schema": "phone-midi/calibration/v1",
  "anchors": {
    "min": { "beta": 25.5, "gamma": 55.7, "capturedAt": "...", "sampleCount": 19 },
    "max": { "beta": 60.9, "gamma": 24.0, "capturedAt": "...", "sampleCount": 17 }
  },
  "fusion": { "mode": "endpoint_projection", "reverse": false, "weights": { "beta": 0.7, "gamma": 0.3 } },
  "orientation": "portrait-primary",
  "calibratedAt": "2026-07-09T..."
}
```

开发者导出格式仍为 `phone-midi/fusion-calibrate/v1`（见 6.2），可含轨迹等扩展字段。

### 6.4 从标定到 Mode A 上线

| 步骤 | 输入 | 输出 |
|------|------|------|
| 标定 | 真机 MIN/MAX | `anchors.min`, `anchors.max` |
| 选公式 | 轨迹单调性对比 | `fusion.mode` + 可选 `weights` |
| 上线 | 导出 JSON | `app.js` 内嵌/引用 anchors + fusion 函数，发送 `fused_t` |
| Bridge | 不变或仅改 `in_min/in_max` 为 0/1 | 单 mapping，单 CC |

---

## 7. 实现步骤分解

### Phase 0 — 方案文档 ✅

- [x] 确认端点语义：自然垂手=0，抬手最高=127
- [x] 重写本文档（融合标定方案）
- [x] 更新 `docs/roadmap.md`

### Phase 1 — 调试页 UI（`web/fusion-calibrate.html`）✅

| 步骤 | 内容 | 状态 |
|------|------|------|
| 1.1 | 端点标定区、融合预览条、参数区、轨迹区、导出区 | ✅ |
| 1.2 | 暗色主题，body 可滚动 | ✅ |
| 1.3 | 主控制页链接；`pose-debug.html` 标记废弃 | ✅ |

### Phase 2 — 端点标定与融合预览（`web/fusion-calibrate.js`）✅

| 步骤 | 内容 | 状态 |
|------|------|------|
| 2.1 | `deviceorientation` 实时 β/γ | ✅ |
| 2.2 | MIN/MAX 标定（400ms 平均采样） | ✅ |
| 2.3 | 端点投影算 `t` 与 `cc_sim`，更新预览条 | ✅ |
| 2.4 | 融合模式切换 + 加权滑条 + 反转 CC | ✅ |

### Phase 3 — 轨迹录制与单调性分析 ✅

| 步骤 | 内容 | 状态 |
|------|------|------|
| 3.1 | 开始/停止录制，~25Hz 采样 | ✅ |
| 3.2 | Canvas t–time 折线，红点标记回跳 | ✅ |
| 3.3 | violations / max_regression | ✅ |

### Phase 4 — 导出 ✅

| 步骤 | 内容 | 状态 |
|------|------|------|
| 4.1 | `buildExportJson()` → schema v1 | ✅ |
| 4.2 | clipboard + textarea fallback | ✅ |
| 4.3 | 清空标定 confirm | ✅ |

### Phase 5 — 真机标定 ✅

样本见 `docs/json.json`（Android 竖屏，端点间距 47.4°，轨迹 0 回跳）。

### Phase 6 — Mode A 融合上线 ✅

| 步骤 | 内容 | 状态 |
|------|------|------|
| 6.1 | `web/fusion.js` 共享模块 | ✅ |
| 6.2 | `app.js` Mode A 发送 `fused_lift` + `t∈[0,1]` | ✅ |
| 6.3 | Bridge `default.json`：`in_min=0`, `in_max=1` | ✅ |
| 6.4 | 主界面显示 CC；主页「校准设备」入口 | ✅ |
| 6.5 | `calibrate.html` 用户三步向导 | ✅ |

### Phase 7 — 用户校准流程 ✅

| 步骤 | 内容 | 状态 |
|------|------|------|
| 7.1 | `calibrate.html` + `calibrate.js` 三步向导 | ✅ |
| 7.2 | `localStorage` 持久化 | ✅ |
| 7.3 | 主页按钮 + 校准状态徽章 | ✅ |

---

## 8. 文件清单

| 文件 | 状态 | 说明 |
|------|------|------|
| `docs/spec/mode-a-pose-debug.md` | 本文档 | 融合标定 spec（文件名保留，内容已切换） |
| `web/fusion-calibrate.html` | ✅ | 融合标定页 UI |
| `web/fusion-calibrate.js` | ✅ | 标定 + 融合 + 轨迹 + 导出 |
| `web/fusion.js` | ✅ | 融合算法 + localStorage |
| `web/calibrate.html` | ✅ | 用户三步校准向导 |
| `web/calibrate.js` | ✅ | 向导逻辑 |
| `web/app.js` | ✅ | Mode A 融合发送 |
| `web/index.html` | ✅ | 校准设备按钮 + 状态徽章 |
| `bridge/config/default.json` | ✅ | fused_lift, 0–1 |
| `web/pose-debug.html` | **废弃** | 旧姿势抓拍页 |
| `docs/roadmap.md` | 已更新 | Phase 2 改为融合路线 |

---

## 9. 风险与注意事项

| 风险 | 缓解 |
|------|------|
| MIN/MAX 标定姿势不一致 | UI 提示保持同一握姿与竖屏；可重新标定 |
| 端点过近导致放大噪声 | 导出 JSON 中记录 `\|d\|`；过小则警告用户重标 |
| gamma 跳变 | 轨迹录制暴露问题；可试加权模式 |
| 与旧 pose-debug 混淆 | 删除旧页或重定向；文档明确废弃 |
| iOS 权限 / clipboard | 沿用现有 requestPermission + textarea fallback |

---

## 10. 测试清单

```
[ ] /fusion-calibrate.html 与主控制页独立，无 WebSocket
[ ] 未标定 MIN/MAX 时，融合预览不可用或显示提示
[ ] 标定 MIN 后：垂手姿势 fused_t 接近 0
[ ] 标定 MAX 后：抬最高姿势 fused_t 接近 1
[ ] 模拟 CC 与 t×127 一致
[ ] 轨迹录制：慢速抬手 t 大致单调
[ ] 导出 JSON：schema 为 fusion-calibrate/v1，endpoint_semantics 正确
[ ] 主控制页 / 在 Phase 6 之前无回归
```

---

## 11. 完成定义

**调试页（Phase 1–4）完成：**

1. 可标定 MIN（垂手=0）与 MAX（抬最高=127）
2. 实时预览融合 `t` 与模拟 CC 0–127
3. 可录制轨迹并查看单调性
4. 可导出 `fusion-calibrate/v1` JSON

**标定完成（Phase 5）：**

5. 至少一份真机 JSON 样本（可存 `docs/samples/fusion-calibrate-example.json`）

**产品上线（Phase 6）：**

6. Mode A 发送融合标量，单 CC 映射，抬手手感符合预期

---

*维护者：实现各 Phase 时更新上表状态。*
