# Roadmap — MIDI Deck

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
| **快捷键面板** | 中 | ✅ 已实现并在真机验证通过（2026-09-18）：手机/平板当宏命令按钮阵列（4×2 = 8 格/页，可多页），PC 端镜像编辑并即时同步；按下发 Note 36+编号 → Nuendo MIDI Remote 映射到宏 → [spec](spec/shortcut-pad.md) · [ADR 0004](adr/0004-midi-note-triggers.md) · [设置指南](guide/nuendo-shortcut-pad.md) |
| **快捷键面板 v1.1–v1.3** | 中 | ✅ 已实现（2026-09-26）：T1 布局改 2 列 × 4 行；T2 音符编号可编辑且与位置解绑；T2b 拖动交换；固定 6 页 = 48 个按钮；手机端去掉音符角标；颜色开放为任意合法 hex（D15–D20） → [spec §9](spec/shortcut-pad.md) |
| **CC 廊条（推子页底部）** | 小 | ✅ 已实现（2026-09-27）：Digital Fader 的 **A/B 运行界面**底部镜像 Shortcut Pad **第 4 页**那八格（编号 24–31），只占 225px 一小块；内容仍走既有的布局下发、按下仍是同一条 Note；格子逻辑抽到 `web/padgrid.js` 供两处共用 → [spec §10](spec/shortcut-pad.md) |
| **手机端 GUI 现代化** | 中 | ✅ 已实现（2026-09-26，T3）：照搬 Apple / iOS 设计语言，覆盖手机端所有页面（`web/ios.css` 一套令牌 + 原有类名覆盖）；只有浅色一套、不跟随系统深色；按下缩放+变深+白色内圈（D21–D24） |
| **PC 端 GUI** | 中 | 🔄 部分已做（2026-09-26）：字体换成等线 / Times New Roman、两个窗口都记尺寸与位置、记住上次的 MIDI 输出与面板端口。"整体美术重做"仍未做（用户："pc 端丑一点问题不大"）；真要做需先取舍（ttk 主题 + 自绘 vs 换浏览器/WebView）→ 建议先走一次需求拷问 |
| **X/Y Pad** | 中 | ✅ 已实现（2026-09-26）：手机屏幕当二维控制面，一个触点同时驱动两个 CC（绝对语义 + 松手保持、Landing 补间、冻结/回中）；不走映射引擎 → [spec](spec/xy-pad.md) |
| **预设保存/加载** | 中 | 多套校准 / 映射预设 |
| **Web 配置完整 UI** | 大 | 可视化编辑 mapping |
| **多路同时控制** | 中 | 协议 `i=0` 硬编码待解，一部手机多 CC |
| **Mode C 摇晃弯音** | — | ✅ 已定型（2026-09-19）：`accelerometer.x` 去重力线性加速度 → 弯音值（±40 m/s²，无滤波/无门限/无校准，静止即精确居中）。**曾经的"揉弦"方案已回退并搁置**（保留为实验件，不挂在任何模式上）→ [mode-c-shake.md](spec/mode-c-shake.md) · [mode-c-vibrato.md](spec/mode-c-vibrato.md) · [changelog](changelog/2026-09-19_mode-c-vibrato.md) |
| **14-bit CC** | 小 | 高精度输出（Pitch Bend 已于 2026-09-17 改为真 14-bit） |
| **Android 原生** | 大 | 原生 APK |
| **macOS 支持** | 中 | 换掉 ctypes winmm 后端 |

> 延迟基线（2026-09-18）：Bridge 往返 p50 0.5 ms；**Mode A / Mode B 链路均无滤波**
> （姿态 → 投影 → 发送阈值），Mode B 逐采样点等于投影值；剩余为采样与系统姿态融合的
> 平台下限（约 20–50 ms）。诊断页：`/latency.html`。
> 历史：2026-09-17 曾把 Mode B 的 One Euro 量纲修对（t90 333 → 33 ms），2026-09-18 改为
> 姿态源后整条滤波链删除（见 [changelog](changelog/2026-09-18_mode-b-latency.md)）。

### 下一步建议

1. ~~**XY Pad** — 触屏二维控制~~ ✅ 已实现（2026-09-26，见 [spec/xy-pad.md](spec/xy-pad.md)）
2. **多套校准预设** — 坐/站不同 anchors
3. **预设管理** — Bridge + 手机端切换

---

## Phase 3: Android 原生（暂缓）

## Phase 4: 高级功能（暂缓）

---

*最后更新: 2026-10-15*
