import 'dart:math';

/// 标准双二阶（Biquad）滤波器
///
/// 使用 Direct Form I 实现
class Biquad {
  Biquad();

  // ========== 滤波器系数 ==========

  double b0 = 1.0, b1 = 0.0, b2 = 0.0;
  double a0 = 1.0, a1 = 0.0, a2 = 0.0;

  // ========== Direct Form I 状态变量 ==========

  double _x1 = 0.0, _x2 = 0.0;
  double _y1 = 0.0, _y2 = 0.0;

  // ========== 核心处理方法 ==========

  double process(double x) {
    final y = b0 * x + b1 * _x1 + b2 * _x2 - a1 * _y1 - a2 * _y2;
    _x2 = _x1;
    _x1 = x;
    _y2 = _y1;
    _y1 = y;
    return y;
  }

  void reset() {
    _x1 = _x2 = _y1 = _y2 = 0.0;
  }

  // ========== 系数计算方法 ==========

  void setPeaking(double sampleRate, double freq, double q, double gainDb) {
    final A = pow(10.0, gainDb / 40.0);
    final w0 = 2 * pi * (freq / sampleRate);
    final alpha = sin(w0) / (2 * q);
    b0 = 1 + alpha * A;
    b1 = -2 * cos(w0);
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos(w0);
    a2 = 1 - alpha / A;
    _normalize();
  }

  void setLowPass(double sampleRate, double freq, double q) {
    final w0 = 2 * pi * (freq / sampleRate);
    final alpha = sin(w0) / (2 * q);
    final cosw = cos(w0);
    b0 = (1 - cosw) / 2;
    b1 = 1 - cosw;
    b2 = (1 - cosw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosw;
    a2 = 1 - alpha;
    _normalize();
  }

  void setHighPass(double sampleRate, double freq, double q) {
    final w0 = 2 * pi * (freq / sampleRate);
    final alpha = sin(w0) / (2 * q);
    final cosw = cos(w0);
    b0 = (1 + cosw) / 2;
    b1 = -(1 + cosw);
    b2 = (1 + cosw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosw;
    a2 = 1 - alpha;
    _normalize();
  }

  void _normalize() {
    if (a0 != 0.0 && a0 != 1.0) {
      b0 /= a0;
      b1 /= a0;
      b2 /= a0;
      a1 /= a0;
      a2 /= a0;
      a0 = 1.0;
    }
  }
}
