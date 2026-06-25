import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../providers/auth_provider.dart';

class ServerConfigPage extends StatefulWidget {
  const ServerConfigPage({super.key});

  @override
  State<ServerConfigPage> createState() => _ServerConfigPageState();
}

class _ServerConfigPageState extends State<ServerConfigPage> {
  String _protocol = 'https';
  final _hostController = TextEditingController();
  bool _isConnecting = false;
  bool _showHistory = false;

  @override
  void dispose() {
    _hostController.dispose();
    super.dispose();
  }

  String _buildUrl() {
    final host = _hostController.text.trim();
    return '$_protocol://$host';
  }

  Future<void> _connect() async {
    final host = _hostController.text.trim();
    if (host.isEmpty) return;

    setState(() => _isConnecting = true);

    final authProvider = context.read<AuthProvider>();
    authProvider.setServerUrl(_buildUrl());

    final success = await authProvider.connectServer();
    if (!mounted) return;

    setState(() => _isConnecting = false);

    if (success) {
      if (authProvider.status == AuthStatus.loggedIn) {
        if (mounted) context.go('/');
      } else if (authProvider.needsInvite) {
        if (mounted) context.go('/welcome');
      } else {
        if (mounted) context.go('/login');
      }
      return;
    }

    final msg = authProvider.errorMessage ?? '无法连接到服务器';
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg)),
    );
  }

  void _selectHistory(String url) {
    try {
      final uri = Uri.parse(url);
      setState(() {
        _protocol = uri.hasScheme ? uri.scheme : 'https';
        _hostController.text = '${uri.host}${uri.hasPort ? ':${uri.port}' : ''}';
        _showHistory = false;
      });
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final authProvider = context.watch<AuthProvider>();
    final history = authProvider.serverHistory;
    final errorMessage = authProvider.errorMessage;

    return Scaffold(
      appBar: AppBar(
        title: const Text('连接服务器'),
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
                  Icons.cloud_outlined,
                  size: 64,
                  color: Color(0xFF5B8CFF),
                ),
                const SizedBox(height: 16),
                const Text(
                  'Moke',
                  style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w700,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(height: 8),
                const Text(
                  '请输入 Talebook 服务器地址',
                  style: TextStyle(
                    fontSize: 14,
                    color: Color(0xFFB0B0B0),
                  ),
                ),
                const SizedBox(height: 40),

                // URL Builder
                Row(
                  children: [
                    // Protocol toggle
                    GestureDetector(
                      onTap: () => setState(() => _protocol = _protocol == 'https' ? 'http' : 'https'),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 14),
                        decoration: BoxDecoration(
                          color: const Color(0xFF2D2D2D),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(
                          _protocol == 'https' ? 'https' : 'http',
                          style: const TextStyle(color: Color(0xFF5B8CFF), fontSize: 13),
                        ),
                      ),
                    ),
                    const SizedBox(width: 4),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 2),
                      child: Text('://', style: TextStyle(color: Color(0xFF808080), fontSize: 13)),
                    ),
                    // Host input
                    Expanded(
                      child: TextField(
                        controller: _hostController,
                        decoration: const InputDecoration(
                          hintText: 'ip:port',
                          contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 14),
                        ),
                        style: const TextStyle(color: Colors.white, fontSize: 14),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    _buildUrl(),
                    style: const TextStyle(
                      color: Color(0xFF5B8CFF),
                      fontSize: 12,
                    ),
                  ),
                ),

                if (errorMessage != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: const Color(0x1AFF4D4F),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: const Color(0x33FF4D4F)),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.error_outline, color: Color(0xFFFF4D4F), size: 20),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            errorMessage,
                            style: const TextStyle(color: Color(0xFFFF4D4F), fontSize: 13),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],

                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: ElevatedButton(
                    onPressed: _isConnecting ? null : _connect,
                    child: _isConnecting
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : const Text('连接服务器', style: TextStyle(fontSize: 16)),
                  ),
                ),

                // Server history
                if (history.isNotEmpty) ...[
                  const SizedBox(height: 32),
                  GestureDetector(
                    onTap: () => setState(() => _showHistory = !_showHistory),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        const Icon(Icons.history, size: 16, color: Color(0xFF808080)),
                        const SizedBox(width: 6),
                        const Text(
                          '历史记录',
                          style: TextStyle(color: Color(0xFF808080), fontSize: 13),
                        ),
                        const SizedBox(width: 4),
                        Icon(
                          _showHistory ? Icons.expand_less : Icons.expand_more,
                          size: 16,
                          color: const Color(0xFF808080),
                        ),
                      ],
                    ),
                  ),
                  if (_showHistory) ...[
                    const SizedBox(height: 8),
                    ...history.map((url) => ListTile(
                          dense: true,
                          leading: const Icon(Icons.link, size: 18, color: Color(0xFF808080)),
                          title: Text(
                            url,
                            style: const TextStyle(fontSize: 13, color: Color(0xFFB0B0B0)),
                          ),
                          onTap: () => _selectHistory(url),
                          shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(8),
                          ),
                        )),
                  ],
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
