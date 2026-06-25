import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../providers/auth_provider.dart';

class WelcomePage extends StatefulWidget {
  const WelcomePage({super.key});

  @override
  State<WelcomePage> createState() => _WelcomePageState();
}

class _WelcomePageState extends State<WelcomePage> {
  final _codeController = TextEditingController();
  bool _isSubmitting = false;

  @override
  void dispose() {
    _codeController.dispose();
    super.dispose();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _checkWelcome());
  }

  Future<void> _checkWelcome() async {
    final api = context.read<AuthProvider>().api;
    if (api == null) return;

    final response = await api.get('/api/welcome');
    if (!mounted) return;
    if (response.isSuccess && response.getValue('passed') == true) {
      context.read<AuthProvider>().connectServer();
    }
  }

  Future<void> _submit() async {
    final code = _codeController.text.trim();
    if (code.isEmpty) return;

    setState(() => _isSubmitting = true);

    final api = context.read<AuthProvider>().api;
    if (api == null) return;

    final response = await api.postForm('/api/welcome', data: {'invite_code': code});
    _isSubmitting = false;
    if (!mounted) return;

    if (response.isSuccess) {
      await context.read<AuthProvider>().connectServer();
      if (!mounted) return;
      if (context.canPop()) {
        context.go('/login');
      }
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(response.msg.isNotEmpty ? response.msg : '访问码无效')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final authProvider = context.watch<AuthProvider>();

    return Scaffold(
      appBar: AppBar(
        title: const Text('私人图书馆'),
        centerTitle: true,
      ),
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(
                  Icons.shield_outlined,
                  size: 64,
                  color: Color(0xFF5B8CFF),
                ),
                const SizedBox(height: 24),
                Text(
                  authProvider.sysInfo['title'] as String? ?? 'Talebook',
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w700,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 12),
                const Text(
                  '本站为私人图书馆，需输入访问码才可进行访问',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 14,
                    color: Color(0xFFB0B0B0),
                    height: 1.5,
                  ),
                ),
                const SizedBox(height: 36),
                TextField(
                  controller: _codeController,
                  decoration: const InputDecoration(
                    labelText: '访问码',
                    hintText: '请输入访问码',
                    prefixIcon: Icon(Icons.vpn_key_outlined, size: 20),
                  ),
                  textInputAction: TextInputAction.done,
                  enabled: !_isSubmitting,
                  onSubmitted: (_) => _submit(),
                ),
                const SizedBox(height: 28),
                SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: ElevatedButton(
                    onPressed: _isSubmitting ? null : _submit,
                    child: _isSubmitting
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Text('验证访问码', style: TextStyle(fontSize: 16)),
                  ),
                ),
                const SizedBox(height: 20),
                TextButton(
                  onPressed: () => context.read<AuthProvider>().setServerUrl(''),
                  child: const Text(
                    '切换服务器',
                    style: TextStyle(fontSize: 12, color: Color(0xFF808080)),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
