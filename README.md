# Phone MIDI Controller

手机传感器 → MIDI 控制器。用手机姿态（抬手 / 翻腕 / 摇晃）向 DAW 输出连续控制信号。

## 架构

```
手机浏览器 ──WebSocket JSON──→ Python Bridge ──ctypes/winmm──→ 虚拟 MIDI 端口 ──→ DAW
  (传感器采集 +                         (MappingEngine:             (loopMIDI)
   融合/校准 → 单一标量 t)              曲线/死区/范围 → CC / Pitch Bend)
```

Bridge 同时充当手机页面的静态服务器，因此手机端零安装。

## 快速开始

### 1. 安装 Python 依赖

```bash
cd bridge
pip install -r requirements.txt
```

### 2. 创建虚拟 MIDI 端口

- **Windows**: 安装 [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html), 创建端口
- （当前 Bridge 的 MIDI 输出走 `ctypes` + `winmm.dll`，仅支持 Windows）

### 3. 启动 Bridge

```bash
python bridge/server.py
```

或直接双击 `bridge/dist/MIDI Deck.exe`（注意：exe 把 `server.py` 与 `web/` 快照打包，
改了前端需重新打包才生效；源码模式则实时读盘）。重新打包：

```powershell
python tools/make_icon.py        # 只在改图标时需要；生成 bridge/midi-deck.ico
cd bridge
pyinstaller --noconfirm --onefile --noconsole --name "MIDI Deck" --icon midi-deck.ico `
  --add-data "config;config" --add-data "../web;web" server.py
```

### 4. 手机连接

手机和电脑在同一局域网。启动后 Bridge 会显示形如 `https://192.168.x.x:8765` 的网址，
手机浏览器打开它，从功能模块列表里选一个（Digital Fader / Shortcut Pad / X/Y Pad）。

- **平板会自己进平板页**：同一个网址，视口短边 ≥ 640 px 时自动跳 `/tablet.html`
  （手机的六页**左右并排**成 48 格一屏 + X/Y 两个视图，**没有 Digital Fader**）。判定用屏幕短边而不是 UA
  （iPad 的 UA 自称 Mac）；iPad 分屏等被误判成手机时可加 `?device=tablet`，想反过来看手机版用
  `?device=phone`，`?device=auto` 清掉记忆。详见 [docs/spec/tablet-page.md](docs/spec/tablet-page.md)。
- **必须是 `https://`**：浏览器只在安全上下文中提供 DeviceOrientation/DeviceMotion，
  `http://` 下传感器接口不存在，手机端会启动失败。Bridge 会自动生成自签名证书（含 SAN），
  首次访问需在浏览器里接受一次证书警告；证书到期前 30 天或本机 IP 变化时会自动重签。
- 若日志出现「无 HTTPS」告警，说明证书生成失败（多为缺少 `cryptography`），
  此时手机传感器不可用，请先 `pip install -r bridge/requirements.txt`。
- 端口默认 8765，可在 GUI 里改；**改过之后会被记住**（下次启动直接用你填的那个）。
  注意 8765/8766 被绿联 NAS 客户端固定占用，若提示端口被占用，换一个即可（例如 38765）。

### 5. 跟手调参 / 延迟诊断

手机打开 `/latency.html`：实时显示传感器采样率、主线程排队与掉帧、到 Bridge 的网络往返、
以及 Mode B 滤波链的实测跨中点延迟，并可现场调整平滑参数（改完回主页即生效）。

## 自定义映射

编辑 `bridge/config/default.json`。详见 `docs/adr/0002-json-mapping-config.md`。

## 文档

> **要迁移到另一台电脑、或想知道"手机上每个按钮到底做了什么"** → 看
> **[docs/guide/README.md](docs/guide/README.md)（使用与迁移手册·单文件版）**：
> 依赖链、功能清单（六页按钮 ↔ Note ↔ DAW 命令/宏）、六个搭建阶段、分层排查表、
> 以及"哪三项做不到无损迁移"。整篇不依赖脚本，版本差异由读者按自己机器核对。

- `CONTEXT.md` — 领域术语表
- `docs/adr/0001-web-first-architecture.md` — 架构决策
- `docs/adr/0002-json-mapping-config.md` — 映射配置格式
- `docs/spec/shortcut-pad.md` — Shortcut Pad（含 CC 廊条）
- `docs/spec/xy-pad.md` — X/Y Pad 二维控制面
- `docs/spec/tablet-page.md` — 平板专用页（设备分流 / 48 格铺一页 / X/Y 自适应）
- `docs/spec/mode-a-pose-debug.md` — Mode A 抬手融合标定
- `docs/spec/mode-b-palm-flip.md` — Mode B 翻腕（重力向量融合 + 滤波量纲说明）
- `docs/spec/mode-c-shake.md` — Mode C 摇晃弯音（峰值标定，主控待接）
- `docs/roadmap.md` — 分期路线图
- `docs/changelog/` — 变更记录（含 `2026-09-17_latency-tuning.md`：延迟诊断结论与 HTTPS 证书修复）

## 参考项目

- [Phone-MIDI-Controller](https://github.com/amstlkqp114514/Phone-MIDI-Controller) — Android+Python，固定映射
