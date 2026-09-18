# 2026-09-18 Mode B 延迟根治：与 Mode A 合并为同一条架构

## 背景

用户反馈：**Mode B 依然有明显延迟**，而 Mode A 已经没有这个问题；「原来的版本里 Mode B 和 Mode A 应当是同样的技术架构」。

这个判断是对的，但只对了一半：两者的**发送侧架构**一直相同（投影 t → CC），差别在于**输入与链路**——

| | Mode A 抬手 | 旧 Mode B 翻转 |
|---|---|---|
| 输入 | `deviceorientation` (β, γ)：**系统姿态** | `devicemotion` 的 `accelerationIncludingGravity`：**含手部线加速度** |
| 链路 | 直接投影，**无状态** | 重力滑动平均窗 → One Euro 低通 → CC 迟滞门 → 发送 |
| 静止时间常数 | 0 ms | 53 ms（滤波），另加窗口均值的一半 |

所以 Mode A「跟手」的真正原因不是某个参数调得好，而是**它根本没有滤波**：姿态是系统用陀螺仪+加速度计融合出来的方向，已经足够干净。Mode B 从原始加速度计自己估重力，就只能靠滤波压制污染——而污染的来源（手部线加速度）与手势本身**在同一频段**，滤波必然在「更抖」和「更慢」之间二选一。

## 诊断（数值，非真机）

用生产代码同一条链路，对一次「肘部固定、腕部翻转」的物理建模做对比。手部线加速度按刚体绕腕旋转计算（`a = r·(−ω²·r̂ + α·(ω̂×r̂))`），手势用最小 jerk 曲线：

- 300 ms 快速翻转：手部线加速度峰值 **33 m/s²（≈3.4 g）**
- 1200 ms 从容翻转：7.8–10.6 m/s²

| 链路 | 翻转时长 | 跨中点延迟 | 发送值延迟 | 与真实手势的 RMS 误差 | 最大误差 | 松手后 CC 漂移 |
|------|---------|-----------|-----------|---------------------|---------|---------------|
| 旧链路（均值窗 20 ms + One Euro 3.0/1.5） | 1200 ms | 30 ms | **35 ms** | 9.2 CC 步 | 16.4 | — |
| 加速度计 + 去掉滤波 | 1200 ms | 14 ms | 18 ms | 7.7 CC 步 | 15.5 | — |
| **姿态（本次方案）** | 1200 ms | **0 ms** | **1 ms** | **0** | 0 | — |
| 旧链路 | 300 ms | −118 ms | −117 ms | **76 CC 步** | **112** | 9 CC 步 / 4 条消息 |
| 加速度计 + 去掉滤波 | 300 ms | −125 ms | −117 ms | 84 CC 步 | 126 | — |
| **姿态（本次方案）** | 300 ms | **0 ms** | **0 ms** | **0** | 0 | — |

两个结论：

1. **滤波不是延迟的唯一来源，而且它压不住真正的污染。** 快速翻转时加速度计的「重力方向」会被手部线加速度拧偏几十度，误差在 76–84 CC 步量级，落在与手势同一频段——One Euro 几乎无能为力（76 → 85 反而更差）。负延迟说明它甚至**提前**跑到了真实手势前面：数值不是「慢」，而是「乱」。
2. **慢速精细动作反而最吃亏。** 1200 ms 那行是手感最需要准的场景，旧链路仍有 35 ms；而静止时间常数 53 ms 意味着手停下后数值还在爬（旧链路松手后还发 4 条消息、漂 9 个 CC 步）。

因此本次不再调参数，而是**把 Mode B 换成 Mode A 的架构**：输入改成姿态。

## 改动

### `web/fusion.js`

- 新增 `gravityFromOrientation(beta, gamma)`：由 W3C `deviceorientation` 的 Z-X'-Y'' 旋转矩阵推导设备坐标系下的重力方向
  `u = (−cosβ·sinγ, sinβ, cosβ·cosγ)`，即 `R = Rz(α)Rx(β)Ry(γ)` 的第三行（`R^T·ẑ`）。
  它与 **α（偏航）无关**，并且在 β = ±90° 处连续（cosβ = 0 使病态的 γ 自动消失）——旧文档里 β/γ 在 γ≈±90° 的跳变问题对**向量**不存在。
- 新增 `feedFlipOrientation(beta, gamma, anchors, fusion)`：姿态 → 重力向量 → **原有的重力锚点投影**（`computeGravityFusedT` 不变）。**无状态、无滤波**，返回 `{t, t_raw, g}` 且 `t === t_raw`。
- **删除** Mode B 的全部滤波与调参设施：`FLIP_STABILIZER`（滑动平均窗 + One Euro）、`oneEuroFilterT`、`pushFlipGravityRaw`、`averagedGravityFromBuffer`、`processFlipGravityMotion`、`flipShouldSendValue`（CC 迟滞门）、`feedFlipMotion`/`resetFlipMotion`、`createFlipStabilizerSession`，以及 `getFlipTuning`/`setFlipTuning`/`loadFlipTuning` 一族与启动时的 `loadFlipTuning()` 调用。
  - 顺带修掉一个隐患：调参页的滑杆会写 `phone-midi/tuning/flip/v1`，而 `fusion.js` 启动时无条件读取——**只要真机上点过一次滑杆，主控页就会永久使用那组值**，且界面上毫无提示。现在 Mode B 没有任何可持久化的状态。
- `captureGravityAnchorSamples()` 改为从**同一个姿态源**采样（存盘 JSON 结构不变，仍是 x/y/z 单位向量）。采集与运行时同源，两者不可能对不上。
- `requestProfilePermissions('flip')` 不再申请运动传感器：Mode B 现在只要方向传感器，**与 Mode A 完全一致**。
- 保留 `lowPassAlpha`（Mode C 的 One Euro 仍在用），并把注释移到 Mode C 段落。

### `web/app.js`

- Mode B 改由 `onOrientationRoute` 驱动（新增 `handleFusedFlip`），代码形状与 Mode A 的 `handleFusedOrientation` 逐行对应：姿态 → 投影 → `emitValue(t)`。
- 去掉 `flipShouldSendValue` 迟滞门与随之而来的 `lastSentCc` 状态。**唯一的条件化就是 `emitValue` 的「≥1 CC 步」变化阈值**，与 Mode A 相同。
- `start()` 只为 Mode C 申请运动权限。

### 校准向导与调试页

- `calibrate-wizard.js`：翻转步骤的实时预览改由 `deviceorientation` 计算（原来挂在 `devicemotion` 上）；不再注册运动监听。
- `fusion-calibrate-flip.html` / `fusion-calibrate.js`：调试页同样改到姿态源，删除「平均窗」滑杆与 `stabilizer` 导出字段（导出 JSON 不再声称存在滤波参数）。

### `/latency.html` + `latency.js`

- ④ 段重写：链路已无滤波，测的不再是「滤波延迟」，而是
  (a) **发送侧门限**造成的跨中点延迟（复刻 `emitValue` 的阈值 + 4 ms 下限），
  (b) **加速度计与姿态的偏差**（中位 / 最大，CC 步）——正是旧链路压不住的那个污染源，现在真机上一眼可见。
- ⑤ 段的三个滑杆与「恢复默认 / 最跟手」按钮删除，替换为说明：Mode B 无可调参数；本页只测量、不写存储。

### 缓存版本

所有页面的 `?v=` 统一到 **22**。此前 `index.html` 是 `fusion.js?v=21`、各校准页是 `fusion.js?v=16`——同一个浏览器里可能缓存着**两份不同的 `fusion.js`**，主控页与校准页行为不一致。以后改前端只需统一改这一处编号。

### 测试

- 新增 `tests/mode_b_latency.test.mjs`（26 项），断言的都是**性质**而非「上次的结果」：
  - 公式正确性：水平 → (0,0,1)（与加速度计约定一致）、β=30° → (0, ½, √3/2)、γ>0 时上方向偏 −x；
  - 整个 β/γ 网格上单位长度、β=±90° 处与 γ 无关、360° 周期、非法输入返回 null；
  - **采集与运行时同源**：用假姿态流驱动 `captureAnchorSamplesForProfile('flip')`，再把结果喂回运行时，端点必须正好是 t=0 / t=1；
  - **无滤波**：阶跃响应在**到达的那一个采样点**就是终值（旧链路要 5 个采样点）、同输入同输出、顺序无关、静止 60 个采样点零漂移、快慢动作无速度相关延迟；
  - **端到端**：加载真实 `index.html` 的脚本与 DOM 桩，`?mode=B` 启动后派发 `deviceorientation`，断言发出的 WebSocket 消息 `axis=fused_flip`、`value` **等于同一采样点的投影值**、亚阈值抖动不发、`devicemotion` 再怎么动也发不出消息、Mode B 不申请运动权限；并用 `?mode=A` 做一次对照（同一条路径）。
- `tests/pages_smoke.mjs` 从「只加载主页/揉弦页」扩展到**全部 8 个页面**（主页、揉弦实验页、延迟页、3 个校准页、2 个调试页），每页都用自己的 HTML 做 DOM 桩真实加载：`getElementById` 拿到不在该页 markup 里的 id 会直接抛错，因此「删了元素但 JS 还在用」这类问题在测试里就会暴露，而不是等真机白屏。同时断言延迟页已无三个调参滑杆、且新的偏差读数存在。
- 新增 `tests/exe_web_check.py`：exe 内嵌的是 `web/` **快照**，改了前端不重打包就会「看起来正常」——本检查逐字节比对归档与工作区（27 个文件），并断言打包进去的 `fusion.js` 是姿态链路、`index.html` 的 `?v=` 与源码一致。exe 不存在时自动跳过。
- `tests/run.ps1` 加入两个新套件。全套 **174 项通过**（vibrato 64 / 协议 21 / 启动 8 / 窗口 33 / 页面 17 / Mode B 26 / exe 快照 5）。

## 验证

- `powershell -File tests\run.ps1` → `all suites passed`（174/174）。
- 前端脚本 `node --check` 全部通过；`fusion.js` 净减 279 行。
- exe 重新打包（17.86 MB，2026-09-18 22:02）：归档内 `web/*` 与源码**逐字节一致**，且内含新的 `gravityFromOrientation` / `feedFlipOrientation`；启动后进程正常驻留。

## 注意

1. **Mode B 需要重新校准一次。** 锚点仍然是一对单位重力向量、存盘格式不变，但旧锚点来自加速度计、新运行值来自姿态。若该平台 `accelerationIncludingGravity` 的符号与 `R^T·ẑ` 相反（iOS 与 Android 在此处历史上不一致），旧锚点会让数值**反向**（投影对锚点整体变号并不免疫）。校准向导第 3 步有实时预览：**预览跟着手腕单调走就对了；若反着走或卡在一端，重新采集 MIN/MAX 即可**。若平台约定本来就一致，旧校准照常可用，不校准也没有副作用。
2. Mode B 不再使用陀螺仪/加速度计原始数据，因此**不申请运动权限**；但 `devicemotion` 监听仍保留（Mode C 在用）。
3. 手机端第一次打开要重新拉取前端（`?v=22`）；exe 内嵌的是 `web/` 快照，改前端必须**重新打包**才在 exe 里生效。

*最后更新: 2026-09-18*
