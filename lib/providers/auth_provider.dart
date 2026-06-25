import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../services/api_service.dart';

class UserInfo {
  final bool isLogin;
  final bool isAdmin;
  final bool isActive;
  final String nickname;
  final String username;
  final String email;
  final String avatar;
  final String createTime;
  final Map<String, dynamic> extra;

  UserInfo({
    this.isLogin = false,
    this.isAdmin = false,
    this.isActive = false,
    this.nickname = '',
    this.username = '',
    this.email = '',
    this.avatar = '',
    this.createTime = '',
    this.extra = const {},
  });

  factory UserInfo.fromJson(Map<String, dynamic> json) {
    return UserInfo(
      isLogin: json['is_login'] == true,
      isAdmin: json['is_admin'] == true,
      isActive: json['is_active'] == true,
      nickname: json['nickname'] as String? ?? '',
      username: json['username'] as String? ?? '',
      email: json['email'] as String? ?? '',
      avatar: json['avatar'] as String? ?? '',
      createTime: json['create_time'] as String? ?? '',
      extra: json['extra'] as Map<String, dynamic>? ?? {},
    );
  }

  factory UserInfo.guest() => UserInfo();
}

enum AuthStatus { initial, loggedOut, loggedIn }

class AuthProvider with ChangeNotifier {
  ApiService? _api;
  AuthStatus _status = AuthStatus.initial;
  UserInfo _user = UserInfo.guest();
  Map<String, dynamic> _sysInfo = {};
  String _serverUrl = '';
  List<String> _serverHistory = [];
  String? _errorMessage;
  bool _isLoading = false;
  bool _needsInvite = false;

  ApiService? get api => _api;
  AuthStatus get status => _status;
  UserInfo get user => _user;
  Map<String, dynamic> get sysInfo => _sysInfo;
  String get serverUrl => _serverUrl;
  List<String> get serverHistory => _serverHistory;
  String? get errorMessage => _errorMessage;
  bool get isLoading => _isLoading;
  bool get needsInvite => _needsInvite;
  bool get needsServerConfig => _serverUrl.isEmpty || _status == AuthStatus.initial;

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _serverHistory = prefs.getStringList('server_history') ?? [];
    _serverUrl = prefs.getString('server_url') ?? '';
    if (_serverUrl.isNotEmpty) {
      _api = ApiService(baseUrl: _serverUrl);
      await _checkAuth();
    }
    notifyListeners();
  }

  Future<void> _saveServerUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('server_url', url);
    if (!_serverHistory.contains(url)) {
      _serverHistory.insert(0, url);
      if (_serverHistory.length > 10) {
        _serverHistory = _serverHistory.sublist(0, 10);
      }
      await prefs.setStringList('server_history', _serverHistory);
    }
  }

  void setServerUrl(String url) {
    _serverUrl = url;
    _api = ApiService(baseUrl: _serverUrl);
    _status = AuthStatus.initial;
    _user = UserInfo.guest();
    _sysInfo = {};
    _needsInvite = false;
    notifyListeners();
  }

  Future<bool> connectServer() async {
    if (_api == null) return false;
    _isLoading = true;
    _errorMessage = null;
    _needsInvite = false;
    notifyListeners();

    final response = await _api!.get('/api/user/info');
    _isLoading = false;

    if (response.isSuccess) {
      await _saveServerUrl(_serverUrl);
      _user = UserInfo.fromJson(response.getMap('user'));
      _sysInfo = response.getMap('sys');
      _status = _user.isLogin ? AuthStatus.loggedIn : AuthStatus.loggedOut;
      notifyListeners();
      return true;
    }

    if (response.err == 'not_invited') {
      await _saveServerUrl(_serverUrl);
      _sysInfo = {'title': 'Moke'};
      _status = AuthStatus.loggedOut;
      _needsInvite = true;
      notifyListeners();
      return true;
    }

    _errorMessage = response.msg.isNotEmpty ? response.msg : '无法连接到服务器';
    notifyListeners();
    return false;
  }

  Future<bool> login(String username, String password) async {
    if (_api == null) return false;
    _isLoading = true;
    _errorMessage = null;
    notifyListeners();

    final response = await _api!.postForm('/api/user/sign_in', data: {
      'username': username,
      'password': password,
    });
    _isLoading = false;

    if (response.isSuccess) {
      return await _checkAuth();
    }

    _errorMessage = response.msg.isNotEmpty ? response.msg : '登录失败';
    notifyListeners();
    return false;
  }

  Future<bool> register({
    required String username,
    required String password,
    required String email,
    required String nickname,
  }) async {
    if (_api == null) return false;
    _isLoading = true;
    _errorMessage = null;
    notifyListeners();

    final response = await _api!.postForm('/api/user/sign_up', data: {
      'username': username,
      'password': password,
      'email': email,
      'nickname': nickname,
    });
    _isLoading = false;

    if (response.isSuccess) {
      notifyListeners();
      return true;
    }

    _errorMessage = response.msg.isNotEmpty ? response.msg : '注册失败';
    notifyListeners();
    return false;
  }

  Future<void> logout() async {
    if (_api == null) return;
    await _api!.get('/api/user/sign_out');
    await _api!.clearCookies();
    _status = AuthStatus.loggedOut;
    _user = UserInfo.guest();
    notifyListeners();
  }

  Future<bool> _checkAuth() async {
    if (_api == null) return false;

    final response = await _api!.get('/api/user/info');
    if (!response.isSuccess) {
      _status = AuthStatus.loggedOut;
      notifyListeners();
      return false;
    }

    _user = UserInfo.fromJson(response.getMap('user'));
    _sysInfo = response.getMap('sys');
    if (_user.isLogin) {
      _status = AuthStatus.loggedIn;
    } else {
      _status = AuthStatus.loggedOut;
      if (response.err == 'not_installed') {
        _errorMessage = '服务器尚未完成初始化安装';
      }
    }
    notifyListeners();
    return _user.isLogin;
  }
}
