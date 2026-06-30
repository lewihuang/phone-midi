# Phone MIDI Controller

手机传感器 → MIDI CC 控制器。用手机倾斜姿态向 DAW 输出连续控制信号。

## 架构

```
手机浏览器 ──WebSocket JSON──→ Python Bridge ──mido──→ DAW (loopMIDI / IAC)
```

## 快速开始

### 1. 安装 Python 依赖

```bash
cd bridge
pip install -r requirements.txt
```

### 2. 创建虚拟 MIDI 端口

- **Windows**: 安装 [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html), 创建端口
- **macOS**: IAC Driver 内置 (音频 MIDI 设置 → 显示 MIDI 工作室 → IAC 驱动程序)

### 3. 启动 Bridge

```bash
python bridge/server.py
```

### 4. 手机连接

手机和电脑在同一局域网。手机浏览器打开 `http://<电脑IP>:8765`，点击"启动传感器"，倾斜手机。

## 自定义映射

编辑 `bridge/config/default.json`。详见 `docs/adr/0002-json-mapping-config.md`。

## 文档

- `CONTEXT.md` — 领域术语表
- `docs/adr/0001-web-first-architecture.md` — 架构决策
- `docs/adr/0002-json-mapping-config.md` — 映射配置格式
- `docs/roadmap.md` — 分期路线图

## 参考项目

- [Phone-MIDI-Controller](https://github.com/amstlkqp114514/Phone-MIDI-Controller) — Android+Python，固定映射
