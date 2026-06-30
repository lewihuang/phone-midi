/// 主页面：实时传感器数据显示 + CC 值预览 + 连接控制

import 'dart:async';
import 'dart:math';
import 'package:flutter/material.dart';
import '../sensor/sensor_service.dart';
import '../sensor/sensor_to_cc_mapper.dart';
import '../transport/udp_midi_sender.dart';
import 'settings_page.dart';

class MainPage extends StatefulWidget {
  final SensorService sensor;
  final UdpMidiSender sender;
  final SensorToCcMapper mapper;

  const MainPage({
    super.key,
    required this.sensor,
    required this.sender,
    required this.mapper,
  });

  @override
  State<MainPage> createState() => _MainPageState();
}

class _MainPageState extends State<MainPage> {
  StreamSubscription<SensorData>? _sub;
  SensorData? _latest;
  List<CcOutput> _ccOutputs = [];
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _sub = widget.sensor.stream.listen(_onData);
    widget.sender.connectionState.listen((c) {
      if (mounted) setState(() {});
    });
  }

  void _onData(SensorData d) {
    _latest = d;
    final outputs = widget.mapper.map(d.smX, d.smY, d.smZ, pitch: d.pitchRad, roll: d.rollRad);

    // 发送
    if (_sending) {
      for (final o in outputs) {
        widget.sender.sendCc(cc: o.cc, value: o.value);
      }
    }

    if (mounted) {
      setState(() => _ccOutputs = outputs);
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final d = _latest;
    final connected = widget.sender.connected;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Phone MIDI CC'),
        actions: [
          // 连接指示器
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(connected ? Icons.wifi : Icons.wifi_off, size: 18, color: connected ? Colors.green : Colors.red),
                const SizedBox(width: 4),
                Text(connected ? '已连接' : '未连接', style: const TextStyle(fontSize: 12)),
              ],
            ),
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // 发送开关
            _buildSendToggle(),
            const SizedBox(height: 16),

            // 传感器实时值
            if (d != null) ...[
              _buildSensorPanel('原始值', d.rawX, d.rawY, d.rawZ, Colors.grey),
              const SizedBox(height: 8),
              _buildSensorPanel('平滑值', d.smX, d.smY, d.smZ, Colors.blue),
              const SizedBox(height: 8),
              _buildSensorPanel('Pitch / Roll', d.pitchRad, d.rollRad, 0, Colors.teal, isAngle: true),
            ],
            const SizedBox(height: 16),

            // CC 输出列表
            const Text('MIDI CC 输出', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            if (_ccOutputs.isEmpty)
              const Card(child: Padding(padding: EdgeInsets.all(24), child: Text('未配置映射，请前往设置添加', textAlign: TextAlign.center)))
            else
              ...List.generate(_ccOutputs.length, (i) => _buildCcCard(_ccOutputs[i])),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton(
        child: const Icon(Icons.settings),
        onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => SettingsPage(
          sensor: widget.sensor,
          mapper: widget.mapper,
          sender: widget.sender,
        ))),
      ),
    );
  }

  Widget _buildSendToggle() {
    return Card(
      color: _sending ? Colors.green.shade50 : null,
      child: SwitchListTile(
        title: Text(_sending ? '发送中...' : '暂停发送'),
        subtitle: Text(_sending ? '实时发送 CC 到 ${widget.sender.connected ? "DAW" : "（未连接）"}' : ''),
        secondary: Icon(_sending ? Icons.sensors : Icons.sensors_off),
        value: _sending,
        onChanged: (v) {
          setState(() => _sending = v);
          if (v && !widget.sender.connected) {
            widget.sender.connect();
          }
        },
      ),
    );
  }

  Widget _buildSensorPanel(String label, double x, double y, double z, Color color, {bool isAngle = false}) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: TextStyle(fontWeight: FontWeight.bold, color: color)),
            const SizedBox(height: 4),
            _axisRow('X', x, color, isAngle),
            _axisRow('Y', y, color, isAngle),
            if (!isAngle) _axisRow('Z', z, color, isAngle),
          ],
        ),
      ),
    );
  }

  Widget _axisRow(String axis, double v, Color color, bool isAngle) {
    final display = isAngle ? '${(v * 180 / pi).toStringAsFixed(1)}°' : v.toStringAsFixed(3);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: Row(
        children: [
          SizedBox(width: 20, child: Text(axis, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 12))),
          SizedBox(width: 80, child: Text(display, style: const TextStyle(fontFamily: 'monospace', fontSize: 12))),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(2),
              child: LinearProgressIndicator(
                value: (v + 1) / 2,
                minHeight: 6,
                backgroundColor: color.withValues(alpha: 0.15),
                valueColor: AlwaysStoppedAnimation(color),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildCcCard(CcOutput o) {
    final pct = o.value / 127;
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: [
            SizedBox(
              width: 80,
              child: Text('CC ${o.cc}', style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold)),
            ),
            SizedBox(
              width: 120,
              child: Text(o.label, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12)),
            ),
            SizedBox(width: 32, child: Text('${o.value}', style: const TextStyle(fontFamily: 'monospace'))),
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(3),
                child: LinearProgressIndicator(value: pct, minHeight: 12, backgroundColor: Colors.grey.shade200),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
