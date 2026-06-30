import '../dsp/biquad.dart';

/// 三轴平滑器，每个轴独立 Biquad 低通
class SensorSmoother {
  final Biquad _x = Biquad();
  final Biquad _y = Biquad();
  final Biquad _z = Biquad();

  double _sampleRate;
  double _cutoffFreq;
  double _q;

  SensorSmoother({
    double sampleRate = 100,
    double cutoffFreq = 3,
    double q = 0.707,
  })  : _sampleRate = sampleRate,
        _cutoffFreq = cutoffFreq,
        _q = q {
    _configure();
  }

  void _configure() {
    _x.setLowPass(_sampleRate, _cutoffFreq, _q);
    _y.setLowPass(_sampleRate, _cutoffFreq, _q);
    _z.setLowPass(_sampleRate, _cutoffFreq, _q);
  }

  /// 当前截止频率（设置页用）
  double get cutoffFreq => _cutoffFreq;

  /// 更新平滑参数
  void setConfig({double? sampleRate, double? cutoffFreq, double? q}) {
    _sampleRate = sampleRate ?? _sampleRate;
    _cutoffFreq = cutoffFreq ?? _cutoffFreq;
    _q = q ?? _q;
    _configure();
  }

  /// 平滑三轴数据，返回 [x, y, z]
  List<double> smooth(double x, double y, double z) {
    return [
      _x.process(x),
      _y.process(y),
      _z.process(z),
    ];
  }

  double smoothX(double v) => _x.process(v);
  double smoothY(double v) => _y.process(v);
  double smoothZ(double v) => _z.process(v);

  void reset() {
    _x.reset();
    _y.reset();
    _z.reset();
  }
}
