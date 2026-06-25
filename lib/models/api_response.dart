class ApiResponse {
  final bool isSuccess;
  final String err;
  final String msg;
  final dynamic data;

  ApiResponse({
    required this.isSuccess,
    required this.err,
    required this.msg,
    this.data,
  });

  factory ApiResponse.fromJson(Map<String, dynamic> json) {
    final err = json['err'] as String? ?? '';
    return ApiResponse(
      isSuccess: err == 'ok',
      err: err,
      msg: json['msg'] as String? ?? '',
      data: json,
    );
  }

  factory ApiResponse.success(dynamic data) {
    return ApiResponse(
      isSuccess: true,
      err: 'ok',
      msg: '',
      data: data,
    );
  }

  factory ApiResponse.failure(String err, String msg) {
    return ApiResponse(
      isSuccess: false,
      err: err,
      msg: msg,
    );
  }

  Map<String, dynamic>? get asMap {
    if (data is Map<String, dynamic>) return data as Map<String, dynamic>;
    return null;
  }

  List<dynamic>? get asList {
    if (data is List<dynamic>) return data as List<dynamic>;
    return null;
  }

  dynamic getValue(String key) {
    final map = asMap;
    if (map != null) return map[key];
    return null;
  }

  Map<String, dynamic> getMap(String key) {
    final v = getValue(key);
    if (v is Map<String, dynamic>) return v;
    return {};
  }

  List<dynamic> getList(String key) {
    final v = getValue(key);
    if (v is List<dynamic>) return v;
    return [];
  }

  String getString(String key) {
    final v = getValue(key);
    if (v is String) return v;
    return '';
  }

  int getInt(String key) {
    final v = getValue(key);
    if (v is int) return v;
    if (v is num) return v.toInt();
    return 0;
  }
}
