# ADR 0001: Web-First MVP → Native Android 渐进架构

## 日期

2026-06-30

## 状态

已采纳

## 背景

目标：用手机传感器（陀螺仪/加速度计等）向 DAW 输出 MIDI CC 信号。需要灵活可配置的映射系统。

现有代码为 Flutter 跨平台 app，使用 `sensors_plus` + UDP raw MIDI。但在 Flutter Web 中 `sensors_plus` 和 `dart:io` 不可用，无法直接复用。

## 决策

**MVP 选用纯 Web 技术栈（HTML/JS），通过 Python Bridge 中转 MIDI。迁移 Android 原生时只重写手机端。**

```
Phase 1 (Web MVP):    浏览器(JS)  ──WebSocket JSON──→  Python Bridge  ──mido──→  DAW
Phase 3 (Android):    Android(Kt) ──WebSocket JSON──→  同一 Python Bridge  ──mido──→  DAW
```

### 协议：WebSocket + JSON

- 手机端只负责传感器采集 + 原始数据发送
- 所有映射逻辑、曲线计算、MIDI 输出在 Bridge 完成
- 数据格式：`{"ts": timestamp, "axis": "pitch", "value": 45.3}`
- WebSocket 选择理由：浏览器原生 `WebSocket` API，Python `aiohttp` 成熟，Android OkHttp/ktor 原生支持，TCP 可靠传输

### Bridge 技术栈：Python + mido + aiohttp

- `mido` 已由参考项目验证，稳定跨平台
- `aiohttp` 异步 WebSocket 服务端成熟
- 打包：PyInstaller → 单 exe（Phase 2）

## 备选方案

### 方案 B：纯 Flutter Native（放弃 Web）
- 优势：现有代码可复用
- 劣势：失去 Web MVP 快速验证优势；安装 APK 门槛高于开浏览器

### 方案 C：Flutter Web + Web MIDI API（无 Bridge）
- 优势：无需 PC 程序
- 劣势：Web MIDI API 仅 Chromium 系支持，Android Chrome 不可用；手机浏览器无法直接输出 MIDI

### 方案 D：BLE MIDI 直连
- 优势：无需 PC
- 劣势：Android BLE MIDI 实现复杂度高，调试困难，不适合 MVP

## 影响

- 现有 Flutter 代码暂不删除，Phase 3 时可参考其传感器处理逻辑和 UI 设计
- Bridge 程序需单独维护
- 映射引擎设计需支持 JSON 序列化，便于后续 Web 管理界面

## 迁移路径

Phase 1 Web MVP → Phase 3 Android Native：

- **复用**：Python Bridge 100% 复用，映射配置 JSON 100% 复用，WebSocket 协议 100% 复用
- **重写**：手机端。DeviceOrientation API → Android SensorManager (~200行)，touchstart/touchmove → onTouchEvent (~300行)，WebSocket(JS) → OkHttp WebSocket (~50行)
- **总重写量**：~600 行
