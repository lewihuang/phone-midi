# 2026-09-18 快捷键面板（Shortcut Pad）实现

## 背景

需求与 13 条决策见 [spec/shortcut-pad.md](../spec/shortcut-pad.md)，触发为什么走 MIDI Note 见
[ADR 0004](../adr/0004-midi-note-triggers.md)。本页记录**实现**：改了什么、测到什么。

一句话：手机/平板变成一块 **8 格（4×2）的宏命令按钮面板**，PC 端把这块面板镜像出来并可编辑，
改完即时同步到手机；按下时 Bridge 发一条 MIDI Note，Nuendo 侧用 MIDI Remote 把那条件映射到宏。

---

## 改动

### 手机端（新页面）

| 文件 | 内容 |
|------|------|
| `web/pad.html` | 独立页面：大标题 + 4×2 网格 + 底部页签；`100dvh` 单屏不滚动、禁缩放/长按菜单/选中 |
| `web/pad.js` | 渲染 Bridge 下发的布局；`pointerdown` 发 `{kind:'trigger',id,phase:'down'}`、`pointerup` 发 `up`；未连接时格子不可点；断连时先松开所有按住的键**再**断开；忽略不认识的服务器消息（为将来的状态回读留路）；申请 screen wake lock |
| `web/index.html` | 主页加入口「快捷键面板 · 宏命令按钮」 |

按下的判定用 `pointerdown` 而不是 `click`：`click` 在移动端有延迟，而这个功能的全部意义就是"按下即发生"。

### Bridge（`bridge/server.py`）

| 内容 | 说明 |
|------|------|
| `WinMidi.send_note(note, channel, velocity)` | 力度 > 0 发 Note On、= 0 发 Note Off；与 `send_cc` 同一个 `midiOutShortMsg` 位布局 |
| `trigger` 消息分支 | `{"kind":"trigger","id":N,"phase":"down"\|"up"}`，**不进映射引擎**（无范围、无曲线、无平滑），直接变成 Note 36+N / 通道 16 |
| 编号校验 | 越界或非整数编号只记日志，不发消息 |
| `pad_watchdog()` | 手机丢了"松开"（页面被关、WiFi 断、标签页被杀）时 1 秒内补 Note Off——与弯音的 dead-man 定时器同一类兜底；断开连接时也会清扫所有按住的触发 |
| 布局存储 | `%APPDATA%\phone-midi-bridge\pad.json`（与 `window.json` 同一约定；**不能**放 `config/`，那是 exe 的快照目录）。读取时清洗：坏 JSON / 缺格 / 超长文字 / 调色板外的颜色 / 超页数，一律退化或修正，绝不输出不可用的布局 |
| 布局下发 | 连上就发 `{"type":"pad_layout"}`；`broadcast_pad_layout()` 给所有客户端广播（沿用连接时已有的 `{"type":"config"}` 推送机制，没有新链路） |

### PC 端编辑器（Tk）

Bridge 展开态新增「快捷键面板…」按钮 → 独立 Toplevel：页签、页标题输入框、**与手机严格同构的 4×2 格子**、
选中格子的文字输入框 + 8 色固定调色板、每格右下角只读显示 `N36…`。

- 用独立 Toplevel 而不是在主窗里做模式：主窗的几何契约（标准窗固定 480×420 且不记忆位置、
  精简窗记忆尺寸与位置）**一点都没被碰**，这是那八轮真机反馈换来的底线。
- 文字/标题输入做 300 ms 防抖后落盘 + 广播；颜色点击立刻生效。
- 删页要点两次（两次点击确认，而不是可能被 DAW 挡住的模态弹窗）。

### 缓存版本与打包

- 所有页面 `?v=` 统一升到 **23**（含新页面 `pad.js?v=23`）。
- exe 重新打包（**17.87 MB**），归档内 `web/*` 29 个文件与源码**逐字节一致**。

---

## 验证

全套 `powershell -File tests\run.ps1` → **all suites passed（216 项）**：

| 套件 | 数量 | 覆盖 |
|------|------|------|
| `vibrato.test.mjs` | 64 | 揉弦 DSP（未改动） |
| `bridge_protocol_check.py` | 21 | 协议与映射引擎 |
| `bridge_boot_check.py` | 8 | 真启动、静态文件、双实例、stop/start 重绑 |
| `bridge_ui_check.py` | 33 | 精简/展开窗口契约 |
| **`bridge_pad_check.py`** | **27** | 编号公式；布局清洗与落盘；触发→Note（按下/松开/无 phase/越界）；丢了松开时兜底；**真 aiohttp + 真 WebSocket**：连上即收到布局、触发变成 Note、改布局后手机立刻收到、断开时松开；真 Tk 编辑器：8 格 N 编号、改文字/颜色三处一致、页标题、加页/删页两次确认 |
| `pages_smoke.mjs` | 32 | 全部 9 个页面按各自 markup 真实加载；**派发真 pointer 事件**驱动面板页：离线不发送、连接后按下恰好一条消息、松开配对、切页重新编号（第 2 页从 N44 起）、不认识的服务器消息不致命、断连时松开并置灰 |
| `mode_b_latency.test.mjs` | 26 | Mode B 无滤波 |
| `exe_web_check.py` | 5 | exe 内嵌 `web/` 快照与源码逐字节一致（缓存版本号改为从源码取，避免硬编码） |

### 测试抓到的两个真 bug

1. **`web/pad.js` 断连时丢掉"松开"**：`ws.onclose` 里先 `ws = null` 再 `releaseAll()`，而 `send()` 在
   没有打开的 socket 时直接返回，于是 up 事件发不出去（服务端 1 秒兜底与断连清扫能救，但手机端的行为是错的）。
   由 `pages_smoke.mjs` 新增的 pointer 事件驱动测试抓到，已修：先松开、再置空。
2. **`BridgeApp._pad_page` 属性与方法同名**：`self._pad_page = 0` 把 `_pad_page()` 方法遮住，
   打开编辑器即 `TypeError: 'int' object is not callable`。由 `bridge_pad_check.py` 的窗口测试抓到，
   方法改名为 `_pad_page_data()`。

---

## 未做（与 spec 的非目标一致）

- **状态回读**（DAW 把"这个宏现在开没开"发回手机）：已确认将来需要（会有开关型宏），但 v1 不做。
  前向兼容的两条硬要求已满足：`pad.js` 忽略不认识的服务器消息类型；编号与格子位置的绑定已稳定。
- 图标、图片、一个按钮多个动作、嵌套文件夹、从 DAW 导入命令名、在手机上编辑按钮、误触保护。

---

## 真机验证清单（1 轮）

1. **PC 本机 30 秒**：`python tools\send_note.py` → 宏执行。
2. **手机**：`/pad.html` → 按第 1 格 → 宏执行。
3. **手机**：PC 端改一格文字/颜色 → 手机上无需刷新即变。

第 1 步失败就不必往下走——那说明 Nuendo 侧映射还没通，与手机无关。

*最后更新: 2026-09-18*
