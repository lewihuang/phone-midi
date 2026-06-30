# 2026-06-30 GUI 重构

## 变更
- `bridge/server.py` — 完全重写 GUI。持久窗口，两个状态：设备选择 → 运行状态。工业暗色主题
- `bridge/dist/phone-midi-bridge.exe` — 重新打包，--noconsole（无 CLI 窗口）

## GUI 设计

**Anchor:** Industrial
- 底色 #0B0C0A 纯黑, Consolas 等宽字体
- 强调色 #00E676 绿, 无阴影, 1px 平面边框
- 无数据造假, 所有标签命名真实信息

**交互:**
- 启动 → 设备列表 + Port 输入 → START 按钮（或双击列表项）
- 运行 → 显示 URL, 连接设备名, 客户端数, 实时 CC 值, 绿色呼吸指示灯
- STOP → 返回设备选择
- QUIT → 退出

**关键修复:**
- 证书目录 mkdir(parents=True) 修复路径不存在错误
- MIDI 设备预选 loopMIDI（名称含 "loopmidi" 自动选中）
- GUI 线程轮询服务器状态 (500ms)
