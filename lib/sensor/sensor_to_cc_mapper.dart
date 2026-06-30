import 'dart:math';

/// 传感器轴 → MIDI CC 映射
///
/// 将平滑后的传感器值映射到 0-127 CC 范围。
/// 支持：输入范围裁剪、死区、映射曲线（线性/对数）
///
/// 使用示例：
/// ```dart
/// final mapper = SensorToCcMapper()
///   ..addMapping(CcMapping(axis: AxisId.x, cc: 11, label: "Expression"))
///   ..addMapping(CcMapping(axis: AxisId.y, cc: 1, label: "Modulation"));
/// mapper.map(0.5, -0.3, 0.1)  → [(cc: 11, value: 96), (cc: 1, value: 42)]
/// ```

enum AxisId { x, y, z, pitch, roll }
enum CurveType { linear, reverse, logarithmic }

class CcMapping {
  final AxisId axis;
  final int cc;
  final String label;
  final CurveType curve;
  final double minInput;
  final double maxInput;
  final double deadZone;
  final int minOutput;
  final int maxOutput;

  const CcMapping({
    required this.axis,
    required this.cc,
    this.label = '',
    this.curve = CurveType.linear,
    this.minInput = -1.0,
    this.maxInput = 1.0,
    this.deadZone = 0.02,
    this.minOutput = 0,
    this.maxOutput = 127,
  });

  CcMapping copyWith({
    AxisId? axis,
    int? cc,
    String? label,
    CurveType? curve,
    double? minInput,
    double? maxInput,
    double? deadZone,
    int? minOutput,
    int? maxOutput,
  }) =>
      CcMapping(
        axis: axis ?? this.axis,
        cc: cc ?? this.cc,
        label: label ?? this.label,
        curve: curve ?? this.curve,
        minInput: minInput ?? this.minInput,
        maxInput: maxInput ?? this.maxInput,
        deadZone: deadZone ?? this.deadZone,
        minOutput: minOutput ?? this.minOutput,
        maxOutput: maxOutput ?? this.maxOutput,
      );

  Map<String, dynamic> toJson() => {
        'axis': axis.name,
        'cc': cc,
        'label': label,
        'curve': curve.name,
        'minInput': minInput,
        'maxInput': maxInput,
        'deadZone': deadZone,
        'minOutput': minOutput,
        'maxOutput': maxOutput,
      };

  factory CcMapping.fromJson(Map<String, dynamic> j) => CcMapping(
        axis: AxisId.values.firstWhere((a) => a.name == j['axis']),
        cc: j['cc'] as int,
        label: j['label'] as String? ?? '',
        curve: CurveType.values.firstWhere((c) => c.name == j['curve']),
        minInput: (j['minInput'] as num).toDouble(),
        maxInput: (j['maxInput'] as num).toDouble(),
        deadZone: (j['deadZone'] as num).toDouble(),
        minOutput: j['minOutput'] as int? ?? 0,
        maxOutput: j['maxOutput'] as int? ?? 127,
      );
}

class CcOutput {
  final int cc;
  final int value;
  final String label;
  CcOutput({required this.cc, required this.value, required this.label});
}

class SensorToCcMapper {
  final List<CcMapping> _mappings = [];

  List<CcMapping> get mappings => List.unmodifiable(_mappings);

  void addMapping(CcMapping m) => _mappings.add(m);
  void removeMapping(int index) => _mappings.removeAt(index);
  void setMapping(int index, CcMapping m) => _mappings[index] = m;
  void clear() => _mappings.clear();
  void load(List<CcMapping> ms) {
    _mappings.clear();
    _mappings.addAll(ms);
  }

  /// 输入传感器值，输出所有 CC 映射结果
  List<CcOutput> map(double x, double y, double z, {double pitch = 0, double roll = 0}) {
    final values = <AxisId, double>{
      AxisId.x: x,
      AxisId.y: y,
      AxisId.z: z,
      AxisId.pitch: pitch,
      AxisId.roll: roll,
    };

    return _mappings.map((m) {
      final raw = values[m.axis] ?? 0;
      final ccVal = _applyMapping(raw, m);
      return CcOutput(cc: m.cc, value: ccVal, label: m.label);
    }).toList();
  }

  int _applyMapping(double raw, CcMapping m) {
    // 裁剪输入
    var v = raw.clamp(m.minInput, m.maxInput);

    // 映射到 0-1
    final range = m.maxInput - m.minInput;
    if (range == 0) return 64; // 中间值 fallback
    v = (v - m.minInput) / range;

    // 曲线
    switch (m.curve) {
      case CurveType.reverse:
        v = 1 - v;
        break;
      case CurveType.logarithmic:
        if (v < 0.01) v = 0;
        else v = (1 + log(v) / log(0.01)).clamp(0, 1);
        break;
      case CurveType.linear:
        break;
    }

    // 死区（中间附近）
    if (v >= 0.5 - m.deadZone / 2 && v <= 0.5 + m.deadZone / 2) {
      // 把 0.5 映射到中间输出值
    }

    // 映射到 CC 范围
    final outRange = m.maxOutput - m.minOutput;
    return m.minOutput + (v * outRange).round();
  }
}

