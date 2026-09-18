# Mode B 翻转手掌 — 方案与步骤分解

> 状态：Phase 1–5 已实现；**融合源已改为重力向量**（2026-07-09）  
> 创建：2026-07-09  
> 关联：[ui-mode-centric.md](ui-mode-centric.md)、[mode-a-pose-debug.md](mode-a-pose-debug.md)

---

## 1. 定位

| 维度 | Mode A 抬手 | Mode B 翻转 |
|------|-------------|-------------|
| 动作 | 抬/降手臂 | **固定肘部，腕部翻转手掌** |
| MIN (0) | 自然垂手 | 自然握姿（掌心朝自己） |
| MAX (127) | 抬手最高 | 翻转极限 |
| 融合输入 | `deviceorientation` (β, γ) | **`devicemotion` 重力向量** |
| Bridge axis | `fused_lift` | `fused_flip` |
| 校准 storage | `phone-midi/calibration/lift/v1` | `phone-midi/calibration/flip/v1` |
| 用户校准页 | `/calibrate-lift.html` | `/calibrate-flip.html` |

**硬性约束 G0**：Mode A 与 Mode B 校准数据 **一一绑定、禁止跨 Mode 读取**。

---

## 2. 融合模型（重力向量）

### 2.1 为何不用 β/γ

翻转动作常经过 **γ ≈ ±90°** 欧拉奇异区，β/γ 端点投影会出现 **fused_t 阶跃**（真机样本 `docs/json.json` 已复现）。用户习惯操作无法稳定避开该区间。

### 2.2 算法

默认 **endpoint_projection**。Mode B 运行时内置信号稳定（滑动平均 + 自适应平滑 + 发送迟滞），用户无感，参数见 `fusion.js` 内部 `FLIP_STABILIZER`。

> ⚠️ **量纲注意（2026-09-17 修复）**：One Euro 的 `beta` 作用于归一化标量 `t ∈ [0,1]`，
> 其量纲是「t 单位/秒」，快速翻转时最多约 10。历史上沿用像素量级输入的 `beta = 0.008`，
> 使自适应项失效、截止频率被钉在 `mincutoff = 1 Hz`（时间常数 159 ms，t63 133 ms / t90 333 ms），
> 是手感延迟的主因。现默认 `gravityAvgMs 20 / mincutoff 3.0 / beta 1.5`（t63 17 ms / t90 33 ms）。
> 真机可在 `/latency.html` 实时调参并测量跨中点延迟。详见
> [changelog 2026-09-17](../changelog/2026-09-17_latency-tuning.md)。

```
ĝ → t_raw → t（稳定后）→ CC
```

β/γ 仅调试页参考，不参与融合。

---

## 3. 使用约束（文案）

- 竖屏握持，与 Mode A 相同 orientation
- 校准时 **肘部高度尽量固定**，只动腕部
- iOS 需同时授权 **DeviceOrientation + DeviceMotion**
- 旧版仅含 `beta/gamma` 的 flip 校准 **无效**，需重新校准

---

## 4. 存储 JSON

```json
{
  "schema": "phone-midi/calibration/flip/v1",
  "profile": "flip",
  "input": "gravity",
  "anchors": {
    "min": { "x": 0.12, "y": -0.85, "z": 0.51 },
    "max": { "x": -0.31, "y": 0.72, "z": 0.62 }
  },
  "fusion": { "mode": "endpoint_projection", "reverse": false },
  "orientation": "portrait-primary",
  "calibratedAt": "2026-07-09T..."
}
```

`anchors.min/max` 可选字段 `raw`（采样期未归一化均值）、`sampleCount`、`capturedAt`。

旧版 `phone-midi/calibration/v1` 仅迁移至 **lift**；旧 flip β/γ 数据因缺少 `x,y,z` 会被 `loadCalibration('flip')` 拒绝。

---

## 5. Web 发送

Phone 端已算好融合标量 `t ∈ [0,1]`，Bridge 仍按 fused 通道映射：

```json
{ "sensor": "rotation_vector", "axis": "fused_flip", "value": 0.42 }
```

（`value` 为融合 t，非原始传感器值。导出 JSON 中 `recommended_mapping.sensor` 标为 `accelerometer` 以说明物理来源。）

Bridge `in_min=0`, `in_max=1`，与 Mode A 相同 mapping 引擎。

---

## 6. 实施阶段

| Phase | 内容 | 状态 |
|-------|------|------|
| 1 | 本文档 + UI spec | ✅ |
| 2 | `fusion.js` profile lift/flip | ✅ |
| 3 | `/calibrate-flip.html` 用户向导 | ✅ |
| 4 | 主页 Mode B + 模式卡片 UI | ✅ |
| 5 | `/fusion-calibrate-flip.html` 开发者调试 | ✅ |
| 6 | **重力融合**（替代 β/γ） | ✅ |
| 7 | 真机样本 + γ 跳变区单调性验收 | 待定 |

---

## 7. 验收

1. flip 校准后仅 Mode B 显示已校准
2. Mode A 校准不影响 Mode B 状态
3. 仅翻腕时 CC 0→127 单调（**含 γ≈±90° 路径**）
4. Bridge 收到 `axis: fused_flip`
5. 调试导出 JSON 含 `input: "gravity"` 与 `gx/gy/gz` 轨迹样本
