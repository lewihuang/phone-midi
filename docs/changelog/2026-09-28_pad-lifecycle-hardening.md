# 2026-09-28 面板生命周期收尾：断开只收回自己、兜底真的在跑、手机不再假装能发

第一轮（[2026-09-28_pad-stuck-note.md](2026-09-28_pad-stuck-note.md)）修的是"一条 Note 被永久挂起"的
根因；那一轮末尾列了 6 条**查到但没动**的遗留。这一轮把它们逐条修掉，外加两条新查出来的。

一句话：**让"谁按的、谁断的、谁该被松开"这件事有唯一答案**，并且把"手机侧那些其实发不出去的动作"
改成诚实的本地复位。

---

## 修了什么

| # | 问题（第一轮遗留） | 这一轮的做法 | 为什么要修 |
|---|--------------------|--------------|------------|
| 1 | **CLI 模式下 pad 兜底根本没跑**：`_cli_mode` 里 `asyncio.ensure_future(handler.pad_watchdog())` 是在**没有运行中的循环**时创建的，而 `web.run_app()` 会自己 `new_event_loop()`（aiohttp 源码已核对）→ 任务永远不 tick。真机日志里 51 条 `Task was destroyed but it is pending! … pad_watchdog` 全在 CLI 启动后 | 新增 `register_watchdogs(app, handler)`：两个看门狗都挂 `app.on_startup`（等真正在跑的循环起来再建任务）。GUI 路径共用 `_spawn_watchdogs(handler, loop)` | 用 `--no-gui` 起 Bridge 的人**等于完全没有兜底**：任何一次丢"松开"都是永久悬挂 |
| 2 | 同一行还嵌在 `if args.pb_idle_ms > 0:` 里：`--pb-idle-ms 0` 会把面板兜底一起关掉（注释却写着"与 PB 设置无关"） | pad 那条移出所有开关；`pb_idle_sec` 只决定 PB 那条建不建。日志也改成把两件事分开说清 | 关掉弯音兜底不该顺手关掉按键兜底——两者是两条独立的失效路径 |
| 3 | 手机端三处"断连/返回时先松开按住的格子"其实**一个字节都发不出去**（`send()` 要求 socket 还 OPEN，`onclose` 时它已经关了） | `padgrid.js` 新增 `dropHeld()`：断线时**只清本地痕迹**（清 `pressed`、清记录），不发消息；两个 `onclose` 都改用它。`returnToSetup()` 则把 `releaseAll()` **挪到 `ws.close()` 之前**（这里 socket 还活着，能真发出去） | 假动作比没有动作更糟：它让代码看起来已经处理了，实际全靠 Bridge 兜。顺带修掉一个真 bug——`returnToSetup()` 先 `ws = null`，那条 up 从来没发出去过 |
| 4 | `web/padgrid.js` 对同一格**不去重**：第二根手指会真发第二条 `down` | 每格记一个 `open` 标志：这一格已经按着时，第二根手指**只登记、不发 down**；**任意一根手指抬起**就把这一格关掉（并清掉该格所有指针的记录），保证 down/up 严格一对一 | Bridge 侧虽然已经幂等（D42），但"一格 = 一个音符"这条规矩应该两端都成立；而且"另一根还按着所以不松"正是留下悬挂的那条路 |
| 5 | `tests/pages_smoke.mjs` 的桩**掩盖**了第 3 条：手动调 `onclose()` 时没把 `readyState` 置成 CLOSED，于是"松手消息发出去了"这条断言在桩里成立、真机上不成立 | 桩的 `WebSocket.close()` 现在**立刻把 `readyState` 置 3**（和真浏览器一致），断线断言改成"一条都发不出去 + 变灰"，并新增"真的重连之后按同一格是一对干净的 down/up" | 测试守的是行为，不是源码；桩比真机宽松就等于没测 |
| 6 | 兜底窗口是"从按下时刻算 1 秒"的固定窗（按住超过 1 秒会被替你松开） | **不动**（语义上成立：DAW 侧只绑 Note On，按住时长没有意义），但在 `PAD_HOLD_GUARD_SEC` 旁写清楚这条取值的含义 | 真正的判据（"那个客户端断开/静默"）需要给 WebSocket 加心跳才能做得干净，属于另一件事，不夹带 |
| 7 | **（新查出来）任何一端断开都会松开全部触发的键**：`handle()` 的 finally 里调 `release_all_triggers()`，而真机上同时开着面板页与推子页（日志里最多 3 个客户端） | `_pad_held[编号]` 记成 `(时刻, 音符, 客户端)`；新增 `release_triggers_of(client)`，断开时**只收回它自己按着的键** | 用户看到的是"按着按着突然自己松了"：另一台设备正按着的那一格被别人的断线放掉了 |
| 8 | **（新查出来）停止 Bridge 时弯音不回中**：端口一关，弯着的通道就再也回不去（手机也不会补发） | 新增 `pb_all_centre(reason)`（16 个通道各发一次 8192），接在**启动时**（清掉上次崩溃留下的弯音，与 `pad_all_off` 同一个理由）与**停止时**（`midi.close()` 之前） | 与"启动/停止清场"同一类：Bridge 自己不知道哪个通道还弯着，只能整条扫一遍 |

## 实测

- **看门狗真的挂在运行中的循环上**（`bridge_pad_check.py` §3g，真的触发了 `app.on_startup`）：
  - `pb_idle_sec=0.5` → 运行中的任务：`['pad_watchdog', 'pb_watchdog']`
  - `pb_idle_sec=0` → 运行中的任务：`['pad_watchdog']`（**pad 不再跟着关掉**）
- **断开只收回自己那一份**（§3f）：A 按 2、B 按 3 → `release_triggers_of(B)` 只发一条 `Note 39 Off`，
  A 那一格仍然按着；`release_triggers_of(A)` 才发 `Note 38 Off`。
- **手机侧**（`pages_smoke.mjs`）：同一格两根手指 → 只发一条 `down`；抬起任意一根 → 恰好一条 `up`；
  另一根再抬不再重复。断线（`readyState=3`）→ 一条消息都不发、格子变灰；**重连后**按同一格是一对干净的
  `down,up`（说明 `onclose` 时确实清了残留记录）。推子页退回设置界面 → **先发 `up` 再关 socket**
  （`readyState` 已经是 3，顺序反了这条断言就会失败）。
- 整套离线验证：`tests/run.ps1` **all suites passed**（`bridge_pad_check.py` 72/72、`pages_smoke.mjs`
  114/114，其余不变）。

## 本轮不修（明确记下来）

1. **给 WebSocket 加心跳**（`web.WebSocketResponse(heartbeat=…)`）：现在"手机悄悄消失但 TCP 没断"
   只能靠 1 秒兜底，加心跳后可以把判据换成"这个客户端真的不在了"，兜底窗口也就不必短。
   收益明确但动的是连接层，单独排期。
2. **`pagehide`/`visibilitychange` 时主动补一次释放**：手机端还可以在页面被切走/关闭的瞬间
   抢在 socket 关闭前发那条 up（现在是等 Bridge 断连清扫）。属于加固，不是缺陷。
3. 第一轮那三条**代际问题**（旧版 exe 留下的悬挂）已经由"启动清场 + 无记录的 up 也补 Off"覆盖，
   不需要再做别的。

## 文档与产物

- `docs/spec/shortcut-pad.md`：补 **D44（所有权与断开回收）、D45（看门狗注册与清场范围）、
  D46（手机端：一格一条 down / 断线只清本地痕迹 / 先发 up 再关 socket）**，§10.3 补验收 26–28。
- `docs/changelog/2026-09-28_pad-stuck-note.md`：在第一轮那份的遗留清单后面加一行指向本篇。
- **手机端缓存击穿升版**（`web/*` 改了就必须做，否则手机还在跑旧 JS，真机测试等于白测）：
  `padgrid.js?v=1→2`、`pad.js?v=30→31`、`app.js?v=26→27`（`pad.html` 与 `fader.html` 两处引用）。
- `bridge/dist/MIDI Deck.exe` 重打包（`server.py` 与 `web/` 都改了；已用 `--no-gui` 起过一次，
  日志里能看到 `面板清场（启动）`、`弯音清场（启动）`、`弯音守护开启` 三行新代码的输出）。
