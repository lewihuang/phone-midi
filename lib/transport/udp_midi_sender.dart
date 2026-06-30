/// UDP MIDI 发送器
///
/// 将 MIDI CC 消息通过 UDP 发送到电脑。
///
/// 协议（3 字节 raw MIDI）：
///   [0xB0 | channel, cc, value]
///
/// 参考 MoreAudio lib/core/metronome_sync/metronome_udp_discovery.dart
/// 的 RawDatagramSocket 使用模式

import 'dart:io';
import 'dart:async';

class UdpMidiSender {
  RawDatagramSocket? _socket;
  int _port = 5005; // AppleMIDI 默认端口附近，避免冲突
  String _host = '255.255.255.255';
  bool _connected = false;

  // 连接状态流
  final _stateCtrl = StreamController<bool>.broadcast();
  Stream<bool> get connectionState => _stateCtrl.stream;
  bool get connected => _connected;

  /// 设置目标
  void setTarget(String host, int port) {
    _host = host;
    _port = port;
  }

  /// 建立 UDP socket（broadcast 模式）
  Future<bool> connect() async {
    close();
    try {
      final socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
      socket.broadcastEnabled = true;
      _socket = socket;
      _connected = true;
      _stateCtrl.add(true);
      return true;
    } catch (e) {
      _connected = false;
      _stateCtrl.add(false);
      return false;
    }
  }

  /// 发送 MIDI CC 消息
  /// [channel] 0-15, [cc] 0-127, [value] 0-127
  void sendCc({int channel = 0, required int cc, required int value}) {
    if (!_connected || _socket == null) return;
    final status = 0xB0 | (channel & 0x0F);
    final data = [status, cc.clamp(0, 127), value.clamp(0, 127)];
    _sendRaw(data);
  }

  /// 发送 Note On
  void sendNoteOn({int channel = 0, required int note, int velocity = 64}) {
    if (!_connected || _socket == null) return;
    final status = 0x90 | (channel & 0x0F);
    _sendRaw([status, note.clamp(0, 127), velocity.clamp(0, 127)]);
  }

  /// 发送 Note Off
  void sendNoteOff({int channel = 0, required int note, int velocity = 0}) {
    if (!_connected || _socket == null) return;
    final status = 0x80 | (channel & 0x0F);
    _sendRaw([status, note.clamp(0, 127), velocity.clamp(0, 127)]);
  }

  /// 发送 Pitch Bend
  void sendPitchBend({int channel = 0, required int value}) {
    if (!_connected || _socket == null) return;
    final status = 0xE0 | (channel & 0x0F);
    final v = value.clamp(0, 16383);
    _sendRaw([status, v & 0x7F, (v >> 7) & 0x7F]);
  }

  void _sendRaw(List<int> data) {
    try {
      _socket?.send(data, InternetAddress(_host), _port);
    } catch (_) {}
  }

  void close() {
    _socket?.close();
    _socket = null;
    _connected = false;
    _stateCtrl.add(false);
  }

  void dispose() {
    close();
    _stateCtrl.close();
  }
}
