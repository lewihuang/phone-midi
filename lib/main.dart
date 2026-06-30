import 'package:flutter/material.dart';
import 'sensor/sensor_service.dart';
import 'sensor/sensor_to_cc_mapper.dart';
import 'transport/udp_midi_sender.dart';
import 'ui/main_page.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const PhoneMidiApp());
}

class PhoneMidiApp extends StatefulWidget {
  const PhoneMidiApp({super.key});

  @override
  State<PhoneMidiApp> createState() => _PhoneMidiAppState();
}

class _PhoneMidiAppState extends State<PhoneMidiApp> {
  final _sensor = SensorService();
  final _sender = UdpMidiSender();
  final _mapper = SensorToCcMapper();

  @override
  void initState() {
    super.initState();
    // 默认映射：Pitch (前后倾) → CC11 (Expression), Roll (左右倾) → CC1 (Modulation)
    _mapper.addMapping(const CcMapping(axis: AxisId.pitch, cc: 11, label: 'Expression (Pitch)'));
    _mapper.addMapping(const CcMapping(axis: AxisId.roll, cc: 1, label: 'Modulation (Roll)'));
    _sensor.start();
  }

  @override
  void dispose() {
    _sensor.dispose();
    _sender.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Phone MIDI CC',
      theme: ThemeData(
        colorSchemeSeed: Colors.indigo,
        useMaterial3: true,
        brightness: Brightness.light,
      ),
      home: MainPage(sensor: _sensor, sender: _sender, mapper: _mapper),
    );
  }
}
