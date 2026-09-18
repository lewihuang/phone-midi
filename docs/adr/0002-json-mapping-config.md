# ADR 0002: JSON 映射配置文件格式

## 日期

2026-06-30

## 状态

已采纳

## 背景

需要存储"传感器轴 → CC 目标"的映射配置。配置需：
- 人类可编辑（MVP 手写）
- Web 和 Python 两端解析
- 扩展性强（后续加 XY pad、多 CC、条件触发）
- 支持预设切换

## 决策

**使用 JSON 格式。一个 JSON 文件 = 一个预设。**

### Schema

```json
{
  "preset_name": "default",
  "mappings": [
    {
      "source": {
        "type": "sensor",
        "sensor": "rotation_vector",
        "axis": "pitch"
      },
      "target": {
        "type": "cc",
        "cc": 11,
        "channel": 0
      },
      "curve": {
        "type": "linear",
        "params": {}
      },
      "range": {
        "in_min": -90.0,
        "in_max": 90.0,
        "out_min": 0,
        "out_max": 127,
        "dead_zone": 0.02
      },
      "smoothing": {
        "type": "ema",
        "alpha": 0.1
      }
    }
  ]
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `source.type` | `"sensor"` \| `"touch"` | 源类型。Phase 1 仅 `sensor`，Phase 2 加 `touch` |
| `source.sensor` | string | 传感器类型。MVP 用 `rotation_vector` |
| `source.axis` | string | 轴名。`pitch` \| `roll` \| `yaw` \| `x` \| `y` \| `z` \| `magnitude` \| `value` |
| `target.type` | `"cc"` \| `"pb"` | 目标类型。缺省 `"cc"`。`"pb"` 时输出 14-bit 弯音（`cc` 被忽略）。由 [ADR 0003](0003-explicit-target-kind.md) 增补；运行时消息的 `kind` 字段优先于此配置 |
| `target.cc` | 0-127 | CC 编号 |
| `target.channel` | 0-15 | MIDI 通道 |
| `curve.type` | `"linear"` \| `"reverse"` \| `"logarithmic"` \| `"exponential"` | 映射曲线 |
| `range.in_min/max` | float | 输入值范围 |
| `range.out_min/max` | 0-127 | 输出 CC 范围 |
| `range.dead_zone` | 0.0-1.0 | 死区比例（输入范围百分比） |
| `smoothing.type` | `"ema"` \| `"biquad"` \| `"none"` | 平滑算法 |
| `smoothing.alpha` | 0.0-1.0 | EMA 平滑因子（仅 ema） |

## 备选方案

### YAML
- 优势：人类可读性更好，支持注释
- 劣势：Web 端需额外 JS 库（js-yaml ~30KB），Flutter/Dart 解析库成熟度不如 JSON

### INI（参考项目做法）
- 优势：Python `configparser` 标准库
- 劣势：无层次结构，嵌套配置（如多映射、曲线参数）表达困难

### SQLite / 数据库
- 过度工程。MVP 不需要

## 影响

- PyInstaller 打包时需包含 JSON 文件
- `source.type` 枚举便于后续扩展 XY pad、手势识别等新源类型
- `curve.params` 预留对象，后续支持自定义贝塞尔曲线参数
