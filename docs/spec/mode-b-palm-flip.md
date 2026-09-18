# Mode B 翻转手掌 — 方案与步骤分解

> 状态：Phase 1–8 已实现；**融合源已改为姿态推导的重力向量**（2026-09-18）
> 创建：2026-07-09
> 关联：[ui-mode-centric.md](ui-mode-centric.md)、[mode-a-pose-debug.md](mode-a-pose-debug.md)

---

## 1. 定位

| 维度 | Mode A 抬手 | Mode B 翻转 |
|------|-------------|-------------|
| 动作 | 抬/降手臂 | **固定肘部，腕部翻转手掌** |
| MIN (0) | 自然垂手 | 自然握姿（掌心朝自己） |
| MAX (127) | 抬手最高 | 翻转极限 |
| 融合输入 | `deviceorientation` (β, γ) | `deviceorientation` (β, γ) → 重力向量 |
| 运行时链路 | 投影，无状态 | 投影，无状态（与 A 相同） |
| Bridge axis | `fused_lift` | `fused_flip` |
| 校准 storage | `phone-midi/calibration/lift/v1` | `phone-midi/calibration/flip/v1` |
| 用户校准页 | `/calibrate-lift.html` | `/calibrate-flip.html` |

**硬性约束 G0**：Mode A 与 Mode B 校准数据 **一一绑定、禁止跨 Mode 读取**。

---

## 2. 融合模型（姿态 → 重力向量）

### 2.1 为何不是 β/γ 直接投影，也不是加速度计

- **不用 β/γ 端点投影**：翻转动作常经过 **γ ≈ ±90°** 欧拉奇异区，把 (β, γ) 当二维点做投影会出现 **fused_t 阶跃**（真机样本 `docs/json.json` 已复现）。
- **不用加速度计估重力**：`accelerationIncludingGravity` 里混着手部线加速度。按刚体绕腕旋转建模，300 ms 快速翻转的线加速度峰值约 **33 m/s²（3.4 g）**，会把「重力方向」拧偏几十度（实测模型下 76–84 CC 步 RMS 误差），而且与手势**同频段**，滤波无法分离——只能换来 20–35 ms 的群延迟（静止时间常数 53 ms）。

### 2.2 算法

姿态 → 设备坐标系中的重力方向 → 对校准锚点做 endpoint projection。**链路上没有任何平滑/平均/迟滞**，与 Mode A 完全同构。

由 W3C `deviceorientation` 的 Z-X'-Y'' 旋转矩阵 `R = Rz(α)Rx(β)Ry(γ)`，设备坐标系下的重力方向是 `R^T·ẑ`，即 R 的第三行：

```
u = (−cosβ·sinγ,  sinβ,  cosβ·cosγ)
```

- **与 α 无关**（偏航不影响重力方向）；
- 在 **β = ±90° 处连续**：此处 cosβ = 0，病态的 γ 自动消失——旧方案的奇异区问题对向量形式不存在；
- 水平放置时 u = (0,0,1)，与加速度计的「向上」约定一致。

```
(β, γ) → u → 投影到 [min, max] → t → CC
```

**迟滞与阈值只在发送侧**：`app.js` 的 `emitValue()` 以「变化 ≥ 1 CC 步（0.008）」为唯一条件（另加 4 ms 高频保护），用于压掉静止噪声，不引入延迟。

> 历史：2026-09-17 曾把 `FLIP_STABILIZER` 的 One Euro 量纲修对（t63 133 → 17 ms）；
> 2026-09-18 进一步确认滤波无法解决根本问题，遂整体删除。详见
> [changelog 2026-09-18](../changelog/2026-09-18_mode-b-latency.md)。

---

## 3. 使用约束（文案）

- 竖屏握持，与 Mode A 相同 orientation
- 校准时 **肘部高度尽量固定**，只动腕部
- **只需授权 DeviceOrientation**（与 Mode A 相同；不再需要 DeviceMotion）
- 旧版由**加速度计**采集的 flip 校准建议重做一次：若平台 `accelerationIncludingGravity`
  的符号与 `R^T·ẑ` 相反（iOS/Android 历史上不一致），旧锚点会让数值反向。
  校准向导第 3 步的实时预览可立即判断：跟着手腕单调走即正确。

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
结构未变，只是 `x/y/z` 现在由姿态推导（`gravityFromOrientation`）而非加速度计采样获得。

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
| 6 | 重力融合（替代 β/γ） | ✅ |
| 7 | 真机样本 + γ 跳变区单调性验收 | ✅（向量形式天然无奇异区） |
| 8 | **姿态融合**（替代加速度计 + 滤波链），与 Mode A 同构 | ✅ |

---

## 7. 验收

1. flip 校准后仅 Mode B 显示已校准
2. Mode A 校准不影响 Mode B 状态
3. 仅翻腕时 CC 0→127 单调（**含 γ≈±90° 路径**）
4. Bridge 收到 `axis: fused_flip`
5. 调试导出 JSON 含 `input: "gravity"` 与 `gx/gy/gz` 轨迹样本
6. 运行时链路逐采样点等于投影值（无滤波、无状态）——`tests/mode_b_latency.test.mjs`
7. Mode B 不申请 DeviceMotion 权限，`devicemotion` 无法影响其数值——同上

