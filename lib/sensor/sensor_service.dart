import 'dart:async';
import 'dart:math';
import 'package:sensors_plus/sensors_plus.dart';
import 'sensor_smoother.dart';

typedef SensorCallback = void Function(double x, double y, double z);

enum SensorMode { accelerometer, gyroscope, userAccelerometer }

/// 传感器数据服务：采集 + 平滑 + CC 映射准备
class SensorService {
  SensorService._();
  static final SensorService _instance = SensorService._();
  factory SensorService() => _instance;

  final SensorSmoother smoother = SensorSmoother();

  StreamSubscription<AccelerometerEvent>? _accelSub;
  StreamSubscription<GyroscopeEvent>? _gyroSub;
  StreamSubscription<UserAccelerometerEvent>? _userAccelSub;
  SensorMode _mode = SensorMode.accelerometer;
  bool _running = false;

  // 最新原始/平滑值
  double rawX = 0, rawY = 0, rawZ = 0;
  double smX = 0, smY = 0, smZ = 0;

  // 角度（从加速度计计算的 tilt/roll）
  double pitchRad = 0, rollRad = 0;

  // 通知
  final _controller = StreamController<SensorData>.broadcast();
  Stream<SensorData> get stream => _controller.stream;
  SensorMode get mode => _mode;
  bool get running => _running;

  /// 启动传感器
  Future<bool> start({SensorMode mode = SensorMode.accelerometer}) async {
    if (_running) stop();
    _mode = mode;
    _running = true;
    smoother.reset();

    switch (mode) {
      case SensorMode.accelerometer:
        _accelSub = accelerometerEventStream().listen(_onAccel);
        break;
      case SensorMode.gyroscope:
        _gyroSub = gyroscopeEventStream().listen(_onGyro);
        break;
      case SensorMode.userAccelerometer:
        _userAccelSub = userAccelerometerEventStream().listen(_onUserAccel);
        break;
    }
    return true;
  }

  void stop() {
    _accelSub?.cancel();
    _accelSub = null;
    _gyroSub?.cancel();
    _gyroSub = null;
    _userAccelSub?.cancel();
    _userAccelSub = null;
    _running = false;
  }

  void _onAccel(AccelerometerEvent e) {
    rawX = e.x;
    rawY = e.y;
    rawZ = e.z;
    _computeTilt(e.x, e.y, e.z);
    _smoothAndEmit(e.x, e.y, e.z);
  }

  void _onGyro(GyroscopeEvent e) {
    rawX = e.x;
    rawY = e.y;
    rawZ = e.z;
    // 陀螺仪不计算角度（需要积分）
    _smoothAndEmit(e.x, e.y, e.z);
  }

  void _onUserAccel(UserAccelerometerEvent e) {
    rawX = e.x;
    rawY = e.y;
    rawZ = e.z;
    _smoothAndEmit(e.x, e.y, e.z);
  }

  void _computeTilt(double ax, double ay, double az) {
    final norm = sqrt(ax * ax + ay * ay + az * az);
    if (norm < 0.001) return;
    final ux = ax / norm, uy = ay / norm, uz = az / norm;
    // 以手机横屏为基准：
    //   pitch: 绕 Y 轴（前后倾斜）
    //   roll: 绕 X 轴（左右倾斜）
    pitchRad = atan2(-ux, uz);
    rollRad = atan2(uy, uz);
  }

  void _smoothAndEmit(double x, double y, double z) {
    final s = smoother.smooth(x, y, z);
    smX = s[0];
    smY = s[1];
    smZ = s[2];
    _controller.add(SensorData(
      rawX: x,
      rawY: y,
      rawZ: z,
      smX: smX,
      smY: smY,
      smZ: smZ,
      pitchRad: pitchRad,
      rollRad: rollRad,
    ));
  }

  void dispose() {
    stop();
    _controller.close();
  }
}

/// 传感器数据快照
class SensorData {
  final double rawX, rawY, rawZ;
  final double smX, smY, smZ;
  final double pitchRad, rollRad;

  SensorData({
    required this.rawX,
    required this.rawY,
    required this.rawZ,
    required this.smX,
    required this.smY,
    required this.smZ,
    required this.pitchRad,
    required this.rollRad,
  });
}
