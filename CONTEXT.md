# CONTEXT — Phone MIDI Controller

项目领域术语表。不含实现细节，不含架构决策。

## 领域概念

### Sensor Source（传感器源）

手机物理传感器，产生原始数据流。

| 术语 | 定义 | 输出 |
|------|------|------|
| **Accelerometer** | 加速度计。测量三轴加速度（含重力），单位 m/s² | x, y, z |
| **Gyroscope** | 陀螺仪。测量三轴旋转速率，单位 rad/s | x, y, z |
| **Rotation Vector** | 虚拟传感器。融合加速度计+陀螺仪+磁力计，输出绝对姿态四元数 | pitch, roll, yaw (°) |
| **Gravity** | 重力分量虚拟传感器。从加速度计分离出的纯重力方向 | x, y, z |
| **Linear Acceleration** | 线性加速度。加速度计减去重力分量 | x, y, z |
| **Magnetometer** | 磁力计/电子罗盘 | x, y, z (μT) |
| **Pressure (Barometer)** | 气压计。可换算绝对高度 | value (hPa) |
| **Proximity** | 接近传感器。检测物体靠近/远离屏幕 | value (cm) |

### Axis（轴）

| 术语 | 定义 |
|------|------|
| **Pitch** | 俯仰角。绕 X 轴旋转，手机上下倾斜。0°=平放，-90°~+90°。推子手感的核心轴 |
| **Roll** | 横滚角。绕 Y 轴旋转，手机左右倾斜 |
| **Yaw** | 偏航角。绕 Z 轴旋转，水平方向。容易漂移 |
| **Magnitude** | 三轴向量长度 `sqrt(x²+y²+z²)` |

### Touch Input（触屏输入，Phase 2）

| 术语 | 定义 |
|------|------|
| **XY Pad** | 手机屏幕作为二维控制面。x 轴→一个 CC，y 轴→另一个 CC |
| **Touch Pressure** | 触控压力（仅支持 3D Touch / Force Touch 设备） |

### MIDI Target

| 术语 | 定义 | 范围 |
|------|------|------|
| **CC (Control Change)** | MIDI 连续控制器消息。3 字节：`[0xB0\|ch, cc#, value]` | CC 0-127, value 0-127 |
| **Channel** | MIDI 通道 | 0-15（显示常作 1-16） |
| **Pitch Bend** | 弯音轮消息。14-bit 精度 | 0-16383 |
| **Note On/Off** | MIDI 音符开/关 | note 0-127, velocity 0-127 |
| **14-bit CC** | 高精度 CC，使用 CC# 和 CC#+32 组合传输 | 0-16383 |

### Mapping（映射）

从传感器轴到 MIDI 目标的转换规则。

| 术语 | 定义 |
|------|------|
| **Mapping Entry** | 一条映射规则。包含：源（sensor + axis）、目标（CC# + channel）、曲线、输入/输出范围 |
| **Curve** | 输入到输出的转换函数。linear（线性）、reverse（反转）、logarithmic（对数）、exponential（指数） |
| **Dead Zone** | 死区。输入值在中心附近的忽略范围，消除静止时抖动 |
| **Smoothing** | 平滑滤波。减少传感器噪声。方法：EMA（指数移动平均）、Biquad 低通 |
| **Sensitivity** | 灵敏度。输入范围到 0-127 的缩放因子 |

### Connectivity（连接）

| 术语 | 定义 |
|------|------|
| **Bridge** | PC 端程序。接收手机数据（WebSocket/UDP），转换为 MIDI 消息发送到 DAW |
| **WebSocket** | TCP 全双工协议。浏览器原生支持。MVP 用此协议通信 |
| **UDP** | 无连接传输。延迟低但不可靠。现有 Flutter 实现用此协议 |
| **Virtual MIDI Port** | 虚拟 MIDI 端口（Windows: loopMIDI, macOS: IAC, Linux: snd-virmidi）。Bridge 输出到此端口 |
| **mido** | Python MIDI 库。Bridge 使用此库发送 MIDI 消息 |

### Preset（预设）

| 术语 | 定义 |
|------|------|
| **Preset** | 一组映射条目的集合。不同歌曲/场景可切换不同预设 |
| **Mapping Config** | 存储映射配置的文件。MVP 用 JSON 格式 |

---

*最后更新: 2026-06-30*
