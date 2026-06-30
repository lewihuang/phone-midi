# 2026-06-30 PyInstaller 打包为 exe

## 变更
- `bridge/server.py` — 添加 PyInstaller 路径支持（`sys._MEIPASS`）+ 证书写入 `%APPDATA%`
- `bridge/dist/phone-midi-bridge.exe` — 单文件 exe，含 config + web 资源

## 使用方法
```bash
# 启动（自动选 MIDI 设备，排除 MS GS Wavetable）
phone-midi-bridge.exe --midi-name "loopMIDI"

# 列出 MIDI 设备
phone-midi-bridge.exe --list-ports

# 指定设备 ID
phone-midi-bridge.exe --midi-device 7

# 自定义端口
phone-midi-bridge.exe --port 8080

# 禁用 HTTPS
phone-midi-bridge.exe --no-ssl
```

## 构建
```bash
cd bridge
pip install pyinstaller
pyinstaller --onefile --name phone-midi-bridge --add-data "config;config" --add-data "../web;web" server.py
```
