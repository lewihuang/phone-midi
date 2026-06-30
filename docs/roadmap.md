# Roadmap — Phone MIDI Controller

## Milestone 1: 传感器→MIDI 通路（✅ 已完成 2026-06-30）

手机浏览器采集 pitch → WebSocket → Python Bridge（ctypes winmm）→ DAW CC

### 已交付

| 功能 | 说明 |
|------|------|
| Pitch → 1 CC | CC号+Channel JSON 可配 |
| 映射引擎 | EMA 平滑、死区、linear/reverse/log/exp 曲线、可配 in/out 范围 |
| ctypes MIDI | Windows winmm.dll 直调，零编译依赖 |
| HTTPS | 自签证书，aiohttp |
| DeviceOrientation | 主传感器，devicemotion fallback（加速度计算 pitch） |
| 发送开关 | 暂停/恢复 MIDI，不中断连接 |
| 手机端范围调节 | in_min/in_max 输入框，即时生效 |
| 服务端 CC 回传 | UI 显示实际映射值，不硬编码估算 |

### 已知限制

- 单映射（一个传感器轴 → 一个 CC）
- 仅 pitch 轴
- 仅 Windows（MIDI 输出用 winmm）

---

## Phase 2: 待规划

以下功能等待优先级排序：

### 候选功能

| 功能 | 工作量 | 说明 |
|------|--------|------|
| **多轴并行** | 小 | pitch + roll 同时控制两个 CC |
| **XY Pad 触屏** | 中 | 屏幕二维控制面，x/y 各映射 CC |
| **预设保存/加载** | 中 | GUI + 手机端切换预设 |
| **Web 配置完整 UI** | 大 | 增删映射条目、选传感器/轴/曲线，不再手写 JSON |
| **曲线编辑器** | 中 | 手机端可视化调整映射曲线 |
| **14-bit CC** | 小 | 高精度 0-16383 输出 |
| **气压计推子** | 中 | 气压传感器 → 绝对高度 → CC，真推子手感 |
| **Android 原生** | 大 | 从 Web 迁移到原生 APK，BLE MIDI 可选 |
| **macOS 支持** | 中 | MIDI 后端改用 mido（macOS 有预编译 wheel） |
| **二维码连接** | 小 | GUI 显示二维码，手机扫码即开 |

### 下一步建议

1. **多轴并行** — 最小改动，最大实用价值。一个手机同时控制两个参数
2. **XY Pad** — 原计划 Phase 2，触屏二维控制
3. **预设管理** — 不同歌曲/场景快速切换映射配置

---

## Phase 3: Android 原生（暂缓）

## Phase 4: 高级功能（暂缓）

## 已记录 Issue

- 映射目标扩展：Note On/Off、Pitch Bend、Program Change、NRPN
- 条件触发映射
- 传感器融合（pitch × roll）
- BLE MIDI 直连
- OSC 输出

---

*最后更新: 2026-06-30*
*最新里程碑: docs/changelog/2026-06-30_milestone-1.md*
