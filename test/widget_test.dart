import 'package:flutter_test/flutter_test.dart';
import 'package:phone_midi/main.dart';

void main() {
  testWidgets('App launches and shows title', (WidgetTester tester) async {
    await tester.pumpWidget(const PhoneMidiApp());
    expect(find.text('Phone MIDI CC'), findsOneWidget);
  });
}
