/// 设置页：传感器模式、CC 映射配置、目标 IP/Port

import 'package:flutter/material.dart';
import '../sensor/sensor_service.dart';
import '../sensor/sensor_to_cc_mapper.dart';
import '../transport/udp_midi_sender.dart';

class SettingsPage extends StatefulWidget {
  final SensorService sensor;
  final SensorToCcMapper mapper;
  final UdpMidiSender sender;

  const SettingsPage({
    super.key,
    required this.sensor,
    required this.mapper,
    required this.sender,
  });

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  final _hostCtrl = TextEditingController(text: '255.255.255.255');
  final _portCtrl = TextEditingController(text: '5005');

  @override
  void dispose() {
    _hostCtrl.dispose();
    _portCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final mappings = widget.mapper.mappings;

    return Scaffold(
      appBar: AppBar(title: const Text('设置')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // === 目标 ===
          const Text('DAW 目标', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(child: TextField(controller: _hostCtrl, decoration: const InputDecoration(labelText: 'IP 地址', isDense: true))),
              const SizedBox(width: 8),
              SizedBox(width: 80, child: TextField(controller: _portCtrl, decoration: const InputDecoration(labelText: '端口', isDense: true), keyboardType: TextInputType.number)),
              const SizedBox(width: 8),
              FilledButton.icon(
                icon: const Icon(Icons.link, size: 16),
                label: const Text('应用'),
                onPressed: () {
                  widget.sender.setTarget(_hostCtrl.text, int.tryParse(_portCtrl.text) ?? 5005);
                  widget.sender.connect();
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('已更新目标')));
                },
              ),
            ],
          ),
          const SizedBox(height: 24),

          // === 传感器模式 ===
          const Text('传感器模式', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
          const SizedBox(height: 8),
          ...SensorMode.values.map((m) => RadioListTile<SensorMode>(
            title: Text(_modeLabel(m)),
            subtitle: Text(_modeDesc(m)),
            value: m,
            groupValue: widget.sensor.mode,
            onChanged: (v) {
              if (v == null) return;
              widget.sensor.start(mode: v);
              setState(() {});
            },
          )),
          const SizedBox(height: 24),

          // === 平滑参数 ===
          const Text('平滑', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
          const SizedBox(height: 8),
          ListTile(
            title: const Text('截止频率 (Hz)'),
            subtitle: Slider(
              value: widget.sensor.smoother.cutoffFreq,
              min: 0.5,
              max: 20,
              divisions: 39,
              label: '${widget.sensor.smoother.cutoffFreq.toStringAsFixed(1)} Hz',
              onChanged: (v) {
                widget.sensor.smoother.setConfig(cutoffFreq: v);
                setState(() {});
              },
            ),
          ),
          const SizedBox(height: 24),

          // === CC 映射 ===
          Row(
            children: [
              const Text('CC 映射', style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              const Spacer(),
              TextButton.icon(
                icon: const Icon(Icons.add, size: 18),
                label: const Text('添加'),
                onPressed: () => _editMapping(context, null),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (mappings.isEmpty)
            const Card(child: Padding(padding: EdgeInsets.all(24), child: Text('暂无映射，点击"添加"创建', textAlign: TextAlign.center)))
          else
            ...List.generate(mappings.length, (i) => _mappingTile(context, i, mappings[i])),
        ],
      ),
    );
  }

  Widget _mappingTile(BuildContext context, int index, CcMapping m) {
    return Card(
      child: ListTile(
        leading: CircleAvatar(
          radius: 14,
          child: Text('${m.cc}', style: const TextStyle(fontSize: 11)),
        ),
        title: Text(m.label.isNotEmpty ? m.label : 'CC ${m.cc}'),
        subtitle: Text('${m.axis.name} → CC ${m.cc}  (${m.curve.name})'),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            IconButton(icon: const Icon(Icons.edit, size: 18), onPressed: () => _editMapping(context, index)),
            IconButton(icon: const Icon(Icons.delete, size: 18), onPressed: () {
              widget.mapper.removeMapping(index);
              setState(() {});
            }),
          ],
        ),
      ),
    );
  }

  void _editMapping(BuildContext context, int? index) {
    final existing = index != null ? widget.mapper.mappings[index] : null;
    final axisCtrl = TextEditingController(text: existing?.axis.name ?? 'x');
    final ccCtrl = TextEditingController(text: existing?.cc.toString() ?? '1');
    final labelCtrl = TextEditingController(text: existing?.label ?? '');

    showDialog(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: Text(index == null ? '添加映射' : '编辑映射'),
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<String>(
                  value: axisCtrl.text,
                  items: AxisId.values.map((a) => DropdownMenuItem(value: a.name, child: Text(a.name))).toList(),
                  onChanged: (v) => axisCtrl.text = v ?? 'x',
                  decoration: const InputDecoration(labelText: '轴'),
                ),
                TextField(controller: ccCtrl, decoration: const InputDecoration(labelText: 'CC 号 (0-127)'), keyboardType: TextInputType.number),
                TextField(controller: labelCtrl, decoration: const InputDecoration(labelText: '标签 (可选)')),
                const SizedBox(height: 16),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
                    FilledButton(
                      onPressed: () {
                        final axis = AxisId.values.firstWhere((a) => a.name == axisCtrl.text);
                        final cc = int.tryParse(ccCtrl.text) ?? 1;
                        final mapping = CcMapping(axis: axis, cc: cc, label: labelCtrl.text);
                        if (index == null) {
                          widget.mapper.addMapping(mapping);
                        } else {
                          widget.mapper.setMapping(index, mapping);
                        }
                        Navigator.pop(ctx);
                        setState(() {});
                      },
                      child: const Text('确定'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _modeLabel(SensorMode m) {
    switch (m) {
      case SensorMode.accelerometer: return '加速度计';
      case SensorMode.gyroscope: return '陀螺仪';
      case SensorMode.userAccelerometer: return '用户加速度（无重力）';
    }
  }

  String _modeDesc(SensorMode m) {
    switch (m) {
      case SensorMode.accelerometer: return '含重力，可计算倾斜角度 (pitch/roll)';
      case SensorMode.gyroscope: return '旋转速率，适合快速手势';
      case SensorMode.userAccelerometer: return '纯运动加速度，排除重力';
    }
  }
}

