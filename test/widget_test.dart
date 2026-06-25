import 'package:flutter_test/flutter_test.dart';

import 'package:Moke/main.dart';
import 'package:Moke/providers/auth_provider.dart';

void main() {
  testWidgets('App renders correctly', (WidgetTester tester) async {
    final authProvider = AuthProvider();
    await tester.pumpWidget(MokeApp(authProvider: authProvider));

    expect(find.text('连接服务器'), findsWidgets);
  });
}
