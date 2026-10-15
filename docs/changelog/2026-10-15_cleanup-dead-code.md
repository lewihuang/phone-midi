# 2026-10-15 清理无效代码与文档（保守范围）

用户要求"清理无效代码和文档"。经勘察后按**保守范围**执行：删死代码与垃圾文件、修过时表述，
**保留 Flutter 脚手架**（`docs/roadmap.md` 里 Android 原生只是「暂缓」，不是取消，故不删）。

---

## 1. 删除的死代码（`bridge/server.py`）

删前逐个确认**全仓 0 调用点**（含 `getattr` 字符串动态调用，已排查）：

| 符号 | 证据 |
|------|------|
| `_pad_edit_note()` | 自带「**已废弃**」注释；用户 2026-09-26 已删除"音符自由输入"功能 |
| `pad_cell_in_layout()` | 0 调用点（在用的是 `pad_note_in_layout`） |
| `_default_spec()` | 0 调用点（生产走 `_clamp_pos`） |
| `_legacy_pb_sniff_warned` + legacy sniff 分支 | ADR 0003 写明移除条件「bundle 升到 v13 后的下一个版本」，当前 `app.js?v=27`、`vibrato-lab.js?v=20`，条件早已满足 |

**保留** `_fit()` 与 `taskbar_presence()`：生产代码不用，但**被 `tests/bridge_ui_check.py` 覆盖**，
属于测试支撑的 API，删了会连带删掉回归断言。

## 2. 删除的垃圾文件

| 项 | 体积 | 说明 |
|---|---|---|
| `nul` | 46 B | 一次失败的重定向意外产生的（内容是报错文本） |
| `新建文件夹/` | 0 | 空目录 |
| `bridge/build/midi-deck/`、`bridge/build/手机推子/` | 46M | 旧产品名下的陈旧构建目录 |
| `bridge/midi-deck.spec` | 792 B | 旧 spec（现行 `MIDI Deck.spec`） |
| `bridge/build_backup/` | 34M | 前两轮改任务栏时建的 exe 备份 |
| `docs/changelog/.2026-10-13_….artifact.json` | 22 B | 残留标记（内容仅 `{"type":"artifact"}`） |
| `*/__pycache__/` | ~190K | 字节码缓存 |

合计约 **80M**。

## 3. 修正的过时文档

| 文档 | 改动 |
|------|------|
| `CONTEXT.md` | 「UDP …**现有 Flutter 实现**用此协议」→ 标注该实现**已废弃**（现走 WebSocket） |
| `docs/roadmap.md` | ① 标题 `Phone MIDI Controller` → `MIDI Deck`；② Mode C 从「🔄 待实现（揉弦）」改为 **✅ 已定型（摇晃 → 弯音值）**并说明揉弦方案已回退搁置；③ 页脚日期 2026-09-27 → 2026-10-15 |
| `docs/adr/0003-explicit-target-kind.md` | §3「兼容与废弃」补记：嗅探代码**已于 2026-10-15 移除**，`kind` 缺失时直接交给 `target.type` 决定 |

> Mode C 的准确状态（用户本轮确认 + 代码实证 + `changelog 2026-09-19 追加 4`）：
> **最终采用「摇晃 → 改变 bend 值」**——`accelerometer.x` 去重力线性加速度直接映射到弯音范围
> （±40 m/s²，无滤波 / 无门限 / 无校准，静止即精确居中，因为"去重力加速度静止即 0"是**传感器
> 给的保证**）。揉弦方案（`web/vibrato.js` + `/vibrato-lab.html`）保留为实验件，**不挂在任何模式上**，
> 但其 64 项 DSP 检查仍在跑。

## 4. 明确**未**清理的项（附理由）

| 项 | 理由 |
|---|---|
| `lib/ android/ ios/ linux/ macos/ windows/ test/ pubspec.*` 等 131 个跟踪文件 | Flutter 脚手架。roadmap 里 Android 原生标为**「暂缓」**而非取消，属发布/路线决策，不是清理 |
| `build/`(2.8G)、`.dart_tool/`(83M) | 同上，Flutter 构建产物/缓存 |
| `release/MIDI-Deck-新用户包/` + `.zip`(42M) | 分发产物；其中 exe 是 9-27 旧版，重打包属发布动作 |
| `web/` 里 16 处 `Phone MIDI CC` 字样 | 旧品牌残留（改名 CHANGELOG 要求页面标题只留模块名）。但涉及 14 个页面，**改动面大于清理本身**，且**无测试覆盖**它们，留待单独处理 |
| `tools/receiver.py`、`tools/test_monitor.py` | UDP 时代的旧工具（0–1 处引用）。保留作为历史参考 |
| `docs/changelog/*.md` 里的旧产品名 | **历史记录不应改写** |
| `.agents/`、`.dsh/`、`.specify/` | agent 工具配置，非项目代码 |

## 5. 验证

全套测试通过（清理前后一致，未破坏任何断言）：

| 测试 | 结果 |
|------|------|
| `bridge_protocol_check.py` | 21/21 |
| `bridge_boot_check.py` | 9/9 |
| `bridge_ui_check.py` | 51/51 |
| `bridge_pad_check.py` | 74/74 |
| `bridge_port_check.py` | 12/12 |
| `bridge_xy_check.py` | 21/21 |
| `vibrato.test.mjs` | 64/64 |
| `pages_smoke.mjs` | 120/120 |
| `mode_b_latency.test.mjs` | 26/26 |

另做 API 存活检查：`pad_note_in_layout` / `pad_duplicate_notes` / `pb_from_norm` / `port_in_use_msg`
均在位；`pad_cell_in_layout` / `_legacy_pb_sniff_warned` 已确认移除。`bridge/dist/MIDI Deck.exe` 未受影响。
