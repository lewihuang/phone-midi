# 2026-09-17 手感延迟诊断与优化

## 背景

用户反馈：手机在手中使用时**刷新率偏低、延迟明显**，不确定是技术瓶颈还是代码限制。

本轮把「手上感觉到的延迟」拆成四段并逐段实测，结论：**大头是代码问题，已修复**；剩下的
是传感器采样与系统姿态融合的物理下限。

## 诊断方式

新增 `/latency.html`（`web/latency.html` + `web/latency.js`），在真机上测量：

| 段 | 测量内容 |
|----|----------|
| ① 传感器采样 | `deviceorientation` / `devicemotion` 事件率、间隔 p50/p95 |
| ② 主线程 | 事件排队延迟（`performance.now() - event.timeStamp`）、帧率、长帧、掉帧数、localStorage 开销 |
| ③ 网络 | 到 Bridge 的 `fetch('/status')` 往返 ×40 |
| ④ 滤波链 | **用生产代码同一条链路**（`feedFlipMotion`）比较未滤波投影值与实际发送值跨过 t=0.5 的时刻差 |

另用 Node 脚本对 Bridge 做了端到端协议验证（真实 WebSocket，127 级扫频 + Pitch Bend 端点）。

## 实测结论

| 环节 | 实测 | 判定 |
|------|------|------|
| Bridge 往返（本机） | p50 **0.5 ms**（min 0.2 / p95 2.4） | 不是瓶颈 |
| TCP_NODELAY | aiohttp 在连接建立时已设置（`base_protocol.py:108`） | 无 Nagle 延迟 |
| Mode A CC 映射 | 128 点扫频，单调、128 个唯一值 | 正确 |
| **Mode B 滤波链** | 阶跃响应 **t63 133 ms / t90 333 ms** | ❌ **代码问题** |
| **Pitch Bend 中心** | `acc.x=0` → PB **8256**（应为 8192，偏 +64） | ❌ **代码问题** |
| **Pitch Bend 分辨率** | 全程仅 **127 个不同值**（间隔中位 153），名义 14-bit | ❌ **代码问题** |

### Mode B 滤波链：量纲错误

`FLIP_STABILIZER.oneEuro.beta = 0.008` 是**像素/角度量级输入**的参数，而滤波器实际作用于
归一化标量 `t ∈ [0,1]`：`cutoff = mincutoff + beta·|dt/dt|`，快速翻转时 `|dt/dt|` 最多约 10，
于是自适应项贡献仅 `0.008 × 10 = 0.08 Hz` —— **截止频率被永久钉在 mincutoff = 1 Hz**，
时间常数 159 ms。这就是手上感觉到的滞后。

| 参数 | t63 | t90 | 静止时间常数 |
|------|-----|-----|--------------|
| 旧：mincutoff 1.0 / beta 0.008 / avg 50 ms | 133 ms | 333 ms | 159 ms |
| 新：mincutoff 3.0 / beta 1.5 / avg 20 ms | 17 ms | 33 ms | 53 ms |

## 改动

### `web/fusion.js`

- `FLIP_STABILIZER` 默认值修正为 `gravityAvgMs 20 / mincutoff 3.0 / beta 1.5`（含量纲说明注释）。
- 新增运行时调参 API，并持久化到 `phone-midi/tuning/flip/v1`：
  `getFlipTuning` / `setFlipTuning` / `resetFlipTuning` / `loadFlipTuning` /
  `flipCutoffForSpeed` / `flipTimeConstantMs`。修改就地作用于 `FLIP_STABILIZER`，
  生产路径（`feedFlipMotion` → `oneEuroFilterT`）无需改动即生效。

### `web/app.js`

- **校准数据缓存**：`handleFusedOrientation` / `handleFusedGravity` 原先**每个传感器事件**
  都调 `F.loadCalibration()` + `F.hasCalibration()`，即 60 Hz × 2 次同步 `localStorage.getItem`
  + `JSON.parse`（`hasCalibration` 内部还会再读一次）。改为 `ensureCalibration()` 每模式读一次，
  模式切换 / 启动 / 页面回前台时失效重读。
- **去掉 16 ms 前缘丢弃闸门**：原 `SEND_INTERVAL` 闸门直接 `return` 丢弃事件，从不补发最新值，
  把更新率封顶在 ~60 Hz 并在传感器间隔之上再加最多 16 ms。改为 `MIN_SEND_INTERVAL_MS = 4`
  仅作高频保护，实际节流交给"值变化 ≥1 CC 步"判断（`emitValue()`）。
- **UI 更新改由 rAF 批量刷新**：每个事件原先是 3~4 次 DOM 写入（数值、CC、进度条宽度、
  以及 `showError('')` 的空写），现在合并为每帧一次；`showError` 增加空值短路。

### `bridge/server.py`

- `MappingEngine._apply_mapping()` 现在同时返回归一化值 `norm`，`process()` 返回四元组
  `(cc, ch, cc_value, norm)`。
- Pitch Bend 改为直接用 `norm` 计算，不再绕道 7-bit CC：
  `pb_val = clamp(8192 + round((norm*2-1) * 8192), 0, 16383)`。
  修复中心偏移 +64，并使回显值与实际发送值一致。
- `process()` 新增 `resolution` 参数：变化检测按**实际传输精度**进行。此前 PB 被 7-bit CC
  门控，名义 14-bit 实际只有 127 级；现在按 16383 判定。

### `web/latency.html` / `web/latency.js`（新增）

真机延迟诊断 + Mode B 调参页，含三段实时读数、滤波跨中点延迟实测、三条滑杆
（mincutoff / beta / gravityAvgMs）与「恢复默认 / 最跟手」预设。不连 WebSocket、不发 MIDI。
入口：主页底部「延迟诊断 · 跟手调参」，以及各调试页导航。

## 验证

- 三个前端脚本在 DOM 桩中以 `node:vm` 实际加载通过；`fusion.js` 调参 API 冒烟通过。
- Bridge 无头启动，`/`、`/latency.html`、`/latency.js`、`/fusion.js`、`/app.js`、`/status` 均 200。
- 端到端 WebSocket：Mode A 127 级扫频单调、128 个唯一值；Mode C 中心 8192、上下限 0 / 16383、
  正负行程 8191 / 8192。
- Pitch Bend 分辨率：同一扫频下不同 PB 值由 **127 → 603** 个（间隔中位 153 → 10）。

## HTTPS 证书修复

诊断中发现三个叠加缺陷，任何一个都会让手机端在某天突然「传感器没反应」：

| 缺陷 | 实测证据 | 后果 |
|------|----------|------|
| 证书**无 `subjectAltName`** | 新旧两份证书都只有 `commonName` | Chrome/Safari 自 2017 起要求 SAN，报 `ERR_CERT_COMMON_NAME_INVALID`，每次连接都要"高级 → 继续" |
| `_ensure_cert` **不检查有效期** | 原实现只有 `if not cp.exists()` | 2027-06-30 到期后继续沿用过期证书 → `ERR_CERT_DATE_INVALID` → 非安全上下文 → 手机传感器完全不可用，且无任何提示 |
| **不感知本机 IP 变化** | 无 SAN 可判断 | 换网络后证书与访问地址不匹配 |
| `cryptography` **未安装** | `pip show` 无此包；老 exe 18.4MB 含它、新 exe 13.3MB 不含 | 打包 exe 无法再生成证书；一旦证书丢失或过期就永久退回 HTTP |

### 改动（`bridge/server.py`）

- **新增 SAN**：`SubjectAlternativeName` 含 `localhost`、`127.0.0.1` 及所有本机 IPv4
  （`_local_ips()`：先用 UDP 探测出口 IP，再并入主机名解析结果并按 192.168/10./172.16-31 排序）。
  另加 `KeyUsage`、`ExtendedKeyUsage=serverAuth`，并把 `not_valid_before` 回拨 1 天以容忍手机时钟偏移。
- **自动续期**：`_cert_renew_reason()` 在「文件缺失 / 剩余有效期 < 30 天 / 缺 SAN / 当前 IP 未被 SAN 覆盖」
  时重签；证书无法解析时**保守沿用**而不删除。
- **安全兜底**：重新生成失败（如缺 `cryptography`）但已有证书文件时，**沿用旧证书**而不是退回 HTTP——
  没有 TLS 的手机端等于完全不可用，这是更坏的结局。仅在完全没有证书时才向上抛错，由调用方降级并打印告警。
- **显式告警**：`_HTTP_SENSOR_WARNING` 在无 HTTPS 时写入日志，GUI 运行页同时显示
  「⚠ 无 HTTPS：手机传感器将无法启动」。
- 删除被取代的旧 `_local_ip` 实现（逻辑并入 `_local_ips`）。

### 依赖与打包

- `pip install cryptography` → **50.0.1**（`requirements.txt` 本就声明，此前只是没装）。
- exe 重新打包：**13.3 MB → 17.0 MB**，归档内含 `cryptography\hazmat\bindings\_rust.pyd`
  与运行时钩子 `pyi_rth_cryptography_openssl`。

### 验证

- 单元级 8 项：缺失检测 / 生成 / stdlib 解码 / 无需重签判定 / 旧证书识别 / 生成失败沿用旧证书 /
  完全无证书时抛错 / 真实 `bridge/.certs` 自动重签。
- 冻结级：打包 exe 启动后自动重签 `%APPDATA%\phone-midi-bridge\certs`，
  SAN 实测为 `DNS:localhost, IP:127.0.0.1, IP:192.168.x.x`；TLS 握手成功；
  严格校验错误码为 `DEPTH_ZERO_SELF_SIGNED_CERT`（仅"CA 未知"），**不再是主机名不匹配**；
  HTTPS 下 `/`、`/latency.html`、`/status` 均 200。

## 未做（下一步候选）

- Mode C 的峰值标定闭环：`captureShakePeaksBoth` / `computeShakeMotion` 与调试页均已就绪，
  但仍缺 `/calibrate-shake.html`，`app.js` Mode C 继续使用硬编码 ±40 m/s²（真机样本峰值已达 59.8）。
- 多路同时控制（协议里 `update_range/update_target/update_source` 仍硬编码 `i=0`）。
- `/ws` 无鉴权；`web/` 与 `bridge/` 无自动化测试。

## 注意

`bridge/dist/手机推子.exe` 是把 `server.py` 与 `web/` **快照**打包的（见 `.spec` 的 `datas`）。
本轮已重新打包（2026-09-17 22:39，17.0 MB），归档内 `web/*` 与源码**逐字节一致**、`cryptography` 已内含。
但改前端后仍须重新打包才会在 exe 里生效；源码模式（`python bridge/server.py`）则实时读盘。

首次用新版本时，证书会被自动重签一次（旧证书缺 SAN）。手机端会再出现一次自签名警告，
之后 SAN 已覆盖当前局域网 IP，警告类型恢复为正常自签名提示。

*最后更新: 2026-09-17*
