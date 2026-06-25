import 'dart:convert';

import 'package:cookie_jar/cookie_jar.dart';
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';

import '../models/api_response.dart';

class ApiService {
  late final Dio _dio;
  final CookieJar _cookieJar;

  String _baseUrl;

  ApiService({required String baseUrl})
      : _baseUrl = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl,
        _cookieJar = CookieJar() {
    _dio = Dio(BaseOptions(
      baseUrl: _baseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 30),
      responseType: ResponseType.json,
      headers: {
        'Content-Type': 'application/json',
      },
    ));
    _dio.interceptors.add(CookieManager(_cookieJar));
  }

  String get baseUrl => _baseUrl;

  void updateBaseUrl(String newUrl) {
    _baseUrl = newUrl.endsWith('/') ? newUrl.substring(0, newUrl.length - 1) : newUrl;
    _dio.options.baseUrl = _baseUrl;
  }

  Future<ApiResponse> get(String path, {Map<String, dynamic>? queryParameters}) async {
    try {
      final response = await _dio.get(path, queryParameters: queryParameters);
      return _handleResponse(response);
    } on DioException catch (e) {
      return _handleError(e);
    }
  }

  Future<ApiResponse> post(String path, {dynamic data}) async {
    try {
      final response = await _dio.post(path, data: data);
      return _handleResponse(response);
    } on DioException catch (e) {
      return _handleError(e);
    }
  }

  Future<ApiResponse> postForm(String path, {required Map<String, dynamic> data}) async {
    try {
      final response = await _dio.post(
        path,
        data: data,
        options: Options(
          contentType: Headers.formUrlEncodedContentType,
        ),
      );
      return _handleResponse(response);
    } on DioException catch (e) {
      return _handleError(e);
    }
  }

  Future<ApiResponse> put(String path, {dynamic data}) async {
    try {
      final response = await _dio.put(path, data: data);
      return _handleResponse(response);
    } on DioException catch (e) {
      return _handleError(e);
    }
  }

  Future<ApiResponse> delete(String path) async {
    try {
      final response = await _dio.delete(path);
      return _handleResponse(response);
    } on DioException catch (e) {
      return _handleError(e);
    }
  }

  Future<void> clearCookies() async {
    final uri = Uri.parse(_baseUrl);
    await _cookieJar.delete(uri);
  }

  dynamic _parseData(dynamic data) {
    if (data is String) {
      try {
        return jsonDecode(data);
      } catch (_) {
        return data;
      }
    }
    return data;
  }

  ApiResponse _handleResponse(Response response) {
    final data = _parseData(response.data);
    if (data is Map<String, dynamic>) {
      return ApiResponse.fromJson(data);
    }
    if (data is List) {
      return ApiResponse.success(data);
    }
    return ApiResponse.failure('parse.error', '响应数据格式异常');
  }

  ApiResponse _handleError(DioException e) {
    if (e.response != null) {
      final data = _parseData(e.response!.data);
      if (data is Map<String, dynamic>) {
        return ApiResponse.fromJson(data);
      }
    }
    switch (e.type) {
      case DioExceptionType.connectionTimeout:
        return ApiResponse.failure('network.timeout', '连接超时，请检查网络');
      case DioExceptionType.receiveTimeout:
        return ApiResponse.failure('network.timeout', '响应超时，请稍后重试');
      case DioExceptionType.connectionError:
        return ApiResponse.failure('network.error', '无法连接服务器，请检查地址和网络');
      default:
        return ApiResponse.failure('network.error', '网络错误: ${e.message}');
    }
  }
}
