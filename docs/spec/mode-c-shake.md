# Mode C 摇晃弯音 — 峰值标定与调试

> 状态：调试页已实现（2026-07-09）；主控与用户校准页待接  
> 关联：[ui-mode-centric.md](ui-mode-centric.md)

---

## 1. 定位

| 维度 | Mode C 摇晃弯音 |
|------|-----------------|
| 动作 | 手持 **摇晃** → Pitch Bend |
| 零偏 | **绝对静止**（线性加速度 ≈ 0），不单独采基线 |
| 负向满弯 | 标定窗内 running **min** |
| 正向满弯 | 标定窗内 running **max** |
| 融合输入 | `devicemotion` 线性加速度（优先） |
| Bridge axis | `fused_shake`（待主控接入） |
| 校准 storage | `phone-midi/calibration/shake/v1` |
| 开发者调试 | `/fusion-calibrate-shake.html` |
| 用户校准 | `/calibrate-shake.html`（待建） |

**设计原则**：用户演示「±100% 满弯音」晃动力度；一步标定，无需理解 m/s²。

---

## 2. 标定流程（一步）

1. 点击 **「开始标定 ±100% 晃动力度」**（默认 **5 秒**）
2. 向两侧各晃到主观满弯音
3. 同时记录 `peakMin`、`peakMax`

校验：`peakMax - peakMin >= 3 m/s²`（`MIN_SHAKE_SEP`）。

---

## 3. 运行时映射

```
raw = acceleration（优先）或 includingGravity
t = (raw − peakMin) / (peakMax − peakMin)   // 中心死区默认 2% 跨度
signed = 2t − 1           // −1 … +1  → UI ±100%
PB = 8192 + signed × 8192
```

**不**减去 `rest`；不晃时 raw≈0（线性加速度路径）。

Web 发送（主控接入后）：

```json
{ "sensor": "accelerometer", "axis": "fused_shake", "value": 0.62 }
```

---

## 4. 存储 JSON

```json
{
  "schema": "phone-midi/calibration/shake/v1",
  "profile": "shake",
  "input": "motion",
  "zero_reference": "absolute_still",
  "anchors": {
    "min": { "peak": -8.4, "capturedAt": "…", "sampleCount": 142 },
    "max": { "peak": 11.2, "capturedAt": "…", "sampleCount": 142 },
    "primaryAxis": "x"
  },
  "calibratedAt": "…"
}
```

旧版含 `anchors.rest` 的校准仍可读（忽略 `rest`），但新标定不再写入。

---

## 5. 调试页功能

| 功能 | 说明 |
|------|------|
| 一步峰值标定 | 5s 内双向 min/max，实时显示跨度 |
| 弯音预览 | ±100%、模拟 PB、双向条 |
| 参数 | 投影轴 auto/x/y、中心死区 |
| 轨迹 / JSON | 导出分析 |

**不连接 WebSocket、不发送 MIDI。**

---

## 6. 文件

| 文件 | 说明 |
|------|------|
| `web/fusion.js` | `captureShakePeaksBoth`、`computeShakeMotion` |
| `web/fusion-calibrate-shake.html` | 调试 UI |
| `web/fusion-calibrate-shake.js` | 调试逻辑 |

---

## 7. 待办（主控）

- [ ] `/calibrate-shake.html` + 一步标定向导
- [ ] `app.js` Mode C + `fused_shake`
- [ ] `bridge/server.py` → Pitch Bend
