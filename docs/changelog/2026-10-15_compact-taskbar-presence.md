# 2026-10-15 精简模式不再"从任务栏消失"：`overrideredirect` 带来的 `WS_EX_TOOLWINDOW`

用户报（附两张任务栏对比图）：**一切到精简模式，任务栏上 MIDI Deck 的"正在运行"指示就没了**。
两张图唯一差异就是 MIDI Deck 图标下方那条运行指示——图 1（展开态）有，图 2（精简态）没有。
进程还活着、手机也连着，只是系统不再提示"它在跑"。

---

## 1. 根因：`overrideredirect(True)` 在 Windows 上是"变成工具窗口"

精简模式为去掉标题栏调了 `self.root.overrideredirect(True)`（`bridge/server.py`，Running View
的精简分支）。**在 Windows 上这一步不只是"去掉标题栏"**：Tk 会把顶层窗口的扩展样式加上
`WS_EX_TOOLWINDOW`，而**工具窗口按系统设计既不进任务栏、也不进 Alt+Tab**。

实测（同一次进程内连续读窗口扩展样式）：

| 状态 | `overrideredirect` | exstyle | TOOLWINDOW | APPWINDOW | 任务栏 |
|------|--------------------|---------|-----------|-----------|--------|
| 正常窗口（有标题栏） | False | `0x00000100` | ✗ | ✗ | 有按钮 |
| 精简窗（改前） | True | `0x00000088` | **✓** | ✗ | **没有** |
| 精简窗（改后） | True | `0x00040008` | ✗ | **✓** | 有按钮 |

> 任务栏的判定口径：`WS_EX_APPWINDOW` 一定算；`WS_EX_TOOLWINDOW` 一定不算；两者都没有时，
> 无属主的顶层窗口也算（展开态就是这一种，所以它有按钮）。

所以这与"进程还在不在"无关，是纯样式位的事。用户"任务管理器里也找不到"的困惑，也源于
这句话本身就不成立：**任务管理器里本来就不该有它**（窗口程序只要不崩就一直在，用户真正想看的
是任务栏那条指示）。

## 2. 修法：把样式改回"应用窗口"

新增三个模块级函数（`bridge/server.py`，紧挨 `apply_window_icon`，同一类"窗口观感"问题）：

| 函数 | 作用 |
|------|------|
| `_win_style_api()` | 取 user32 句柄与 `Get/SetWindowLongPtrW`；非 Windows 或取不到返回 None。**64 位下必须显式设 `restype` 为 `c_ssize_t`**，否则 HWND 被默认的 `c_int` 截断 |
| `taskbar_presence(window)` | 按任务栏口径判定"有没有按钮"：True / False / None（没法判定） |
| `set_taskbar_presence(window, present)` | 改扩展样式位并 `SetWindowPos(..., SWP_FRAMECHANGED)` 让框架判定立即重跑 |

三个调用点：

| 位置 | 调用 | 理由 |
|------|------|------|
| Running View · 精简分支 | `set_taskbar_presence(self.root, True)` | 去掉标题栏之后立刻补回任务栏存在感 |
| Running View · 精简分支末尾（`update_idletasks` 后） | 同上，再确认一次 | 拖动/拉伸可能让 Tk 重建窗口，幂等且只花一次 API 调用 |
| `_build_running` 展开分支 / `_build_setup` | `set_taskbar_presence(self.root, False)` | 标题栏回来后本就占任务栏；这一下是**摘干净**精简态的痕迹 |

**两个关键实现细节**（都踩过）：

1. **必须 `GetAncestor(GA_ROOT)`**：`winfo_id()` 给的是 Tk 自己的内部窗口，扩展样式挂在**顶层
   窗口**上——拿子窗口去读，样式永远是 `0x0`，看起来就像"没生效"。
2. **只改样式位不够，必须 `SWP_FRAMECHANGED`**：否则系统还按旧判定走，改动要等到下一次
   窗口框架事件才生效。

顺带验证过两件容易出问题的事：

- **加任务栏按钮后，点按钮能正常还原**：无边框窗最小化再还原，实测 `iconic=False`、
  位置尺寸 `(130,100,420x108)` 与还原前一致、`-topmost` 保持 True。
- **样式在真实事件循环里稳定**：改样式的时机（映射前/映射后）都成立，跑 3 秒事件循环后仍是
  `0x40004`（TOOLWINDOW 不回来）。

## 3. 附带影响（已如实告知用户）

**Alt+Tab**：任务栏按钮与 Alt+Tab 列表是同一套判定决定的，两者没法只取其一。精简窗占任务栏后，
按 Alt+Tab 也会在列表里出现一项。用户知情并同意先做一版，不对就回滚。

## 4. 验证

新增 2 条回归断言（`tests/bridge_ui_check.py`，不弹窗）：

- **精简态仍在任务栏（看得出在运行）**：断言 `server.taskbar_presence(app.root) is True`
- **返回展开态后任务栏样式摘干净**：断言 `exstyle & (APPWINDOW|TOOLWINDOW) == 0`

另加辅助 `_ex_bits()` 直接读顶层 HWND 的扩展样式位（读不到返回 0，让断言失败而不是崩）。

全套通过：

| 测试 | 结果 |
|------|------|
| `bridge_ui_check.py` | **39/39**（原 37 + 新 2） |
| `bridge_protocol_check.py` | 21/21 |
| `bridge_boot_check.py` | 9/9 |
| `bridge_pad_check.py` | 74/74 |
| `bridge_port_check.py` | 12/12 |
| `bridge_xy_check.py` | 21/21 |
| `vibrato.test.mjs` | 64/64 |
| `pages_smoke.mjs` | 120/120 |
| `mode_b_latency.test.mjs` | 26/26 |

**端到端（打包后的 exe）**：`bridge/dist/MIDI Deck.exe` 重新打包后启动，主窗口扩展样式
`0x00000100`（正常应用窗口，占任务栏），进程存活正常。

## 5. 回滚

改动前的 exe 备份在 `bridge/build_backup/MIDI Deck.exe.20261015-before-taskbar-fix`。
代码侧改动集中在 `bridge/server.py` 的三个函数与三处调用点，`git diff` 可整体回退。
