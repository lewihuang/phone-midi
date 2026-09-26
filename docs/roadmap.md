# Roadmap — Phone MIDI Controller

## Milestone 1: 传感器→MIDI 通路（✅ 已完成 2026-06-30）

手机浏览器采集 pitch → WebSocket → Python Bridge（ctypes winmm）→ DAW CC

---

## Phase 2.5: Mode B 翻转 + 模式中心 UI（🔄 2026-07-09）

→ [mode-b-palm-flip.md](spec/mode-b-palm-flip.md) · [ui-mode-centric.md](spec/ui-mode-centric.md)

| 交付 | 说明 |
|------|------|
| `fusion.js` PROFILES | lift / flip 独立 storage |
| 主页模式卡片 | A/B/C 各自状态与校准入口 |
| `/calibrate-lift.html` | Mode A 校准 |
| `/calibrate-flip.html` | Mode B 校准 |
| Mode B | `fused_flip` ∈ [0,1] |
| Mode B 延迟（2026-09-18） | 融合源改为**姿态推导的重力向量**，与 Mode A 同构、无滤波 → [changelog](changelog/2026-09-18_mode-b-latency.md) |
| Mode C | 原摇晃弯音（原 Mode B）→ [mode-c-shake.md](spec/mode-c-shake.md) 峰值标定 |

---

## Phase 2: Mode A 多轴融合（✅ 已完成 2026-07-09）

手机 `(β, γ)` 融合为单标量 → CC 0–127。每人通过校准页自定端点。

→ 方案文档：[docs/spec/mode-a-pose-debug.md](spec/mode-a-pose-debug.md)

| 交付 | 说明 |
|------|------|
| `web/fusion.js` | 端点投影融合 + localStorage |
| `/calibrate-lift.html` | 用户三步校准（垂手=0，抬最高=127） |
| `/fusion-calibrate.html` | 开发者调试（轨迹、JSON 导出） |
| 主页模式卡片 | 各 Mode 校准状态与入口 |
| Mode A | 发送 `fused_lift` ∈ [0,1] |
| Bridge | `default.json` axis=`fused_lift`, range 0–1 |

真机样本：`docs/json.json`

### 候选功能

| 功能 | 工作量 | 说明 |
|------|--------|------|
| **快捷键面板** | 中 | ✅ 已实现（2026-09-18）：手机/平板当宏命令按钮阵列（4×2 = 8 格/页，可多页），PC 端镜像编辑并即时同步；按下发 Note 36+编号 → Nuendo MIDI Remote 映射到宏 → [spec](spec/shortcut-pad.md) · [ADR 0004](adr/0004-midi-note-triggers.md) · [设置指南](guide/nuendo-shortcut-pad.md) |
| **XY Pad 触屏** | 中 | 屏幕二维控制面 |
| **预设保存/加载** | 中 | 多套校准 / 映射预设 |
| **Web 配置完整 UI** | 大 | 可视化编辑 mapping |
| **多路同时控制** | 中 | 协议 `i=0` 硬编码待解，一部手机多 CC |
| **Mode C 揉弦** | 中 | 🔄 目标重定义为模拟小提琴揉弦：[spec/mode-c-vibrato.md](spec/mode-c-vibrato.md)（设计已确认，待实现）。旧"摇晃弯音"实现见 [spec/mode-c-shake.md](spec/mode-c-shake.md) + [ADR 0003](adr/0003-explicit-target-kind.md) |
| **14-bit CC** | 小 | 高精度输出（Pitch Bend 已于 2026-09-17 改为真 14-bit） |
| **Android 原生** | 大 | 原生 APK |
| **macOS 支持** | 中 | 换掉 ctypes winmm 后端 |

> 延迟基线（2026-09-18）：Bridge 往返 p50 0.5 ms；**Mode A / Mode B 链路均无滤波**
> （姿态 → 投影 → 发送阈值），Mode B 逐采样点等于投影值；剩余为采样与系统姿态融合的
> 平台下限（约 20–50 ms）。诊断页：`/latency.html`。
> 历史：2026-09-17 曾把 Mode B 的 One Euro 量纲修对（t90 333 → 33 ms），2026-09-18 改为
> 姿态源后整条滤波链删除（见 [changelog](changelog/2026-09-18_mode-b-latency.md)）。

### 下一步建议

1. **XY Pad** — 触屏二维控制
2. **多套校准预设** — 坐/站不同 anchors
3. **预设管理** — Bridge + 手机端切换

---

## Phase 3: Android 原生（暂缓）

## Phase 4: 高级功能（暂缓）

---

*最后更新: 2026-07-09*
