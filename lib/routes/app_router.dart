import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../pages/book_detail_page.dart';
import '../pages/home_page.dart';
import '../pages/library_page.dart';
import '../pages/login_page.dart';
import '../pages/placeholder_page.dart';
import '../pages/server_config_page.dart';
import '../pages/signup_page.dart';
import '../pages/welcome_page.dart';
import '../providers/auth_provider.dart';

class AppRouter {
  final AuthProvider authProvider;

  AppRouter({required this.authProvider});

  late final GoRouter router = GoRouter(
    refreshListenable: authProvider,
    initialLocation: '/',
    redirect: _redirect,
    routes: _routes,
  );

  String? _redirect(BuildContext context, GoRouterState state) {
    final isInitial = authProvider.status == AuthStatus.initial;
    final isLoggedIn = authProvider.status == AuthStatus.loggedIn;
    final location = state.uri.toString();
    final isAdmin = authProvider.user.isAdmin;

    if (isInitial) {
      if (location != '/server-config') {
        return '/server-config';
      }
      return null;
    }

    final publicPaths = ['/server-config', '/login', '/signup', '/welcome'];
    if (!isLoggedIn && !publicPaths.contains(location)) {
      if (authProvider.needsInvite) {
        return '/welcome';
      }
      return '/login';
    }

    if (isLoggedIn && publicPaths.contains(location) && location != '/welcome') {
      return '/';
    }

    final adminPaths = ['/admin', '/admin/'];
    final isAdminPath = adminPaths.any((p) => location.startsWith(p));
    if (isAdminPath && !isAdmin) {
      return '/';
    }

    return null;
  }

  List<RouteBase> get _routes => [
        GoRoute(
          path: '/server-config',
          builder: (context, state) => const ServerConfigPage(),
        ),
        GoRoute(
          path: '/login',
          builder: (context, state) => const LoginPage(),
        ),
        GoRoute(
          path: '/signup',
          builder: (context, state) => const SignupPage(),
        ),
        GoRoute(
          path: '/welcome',
          builder: (context, state) => const WelcomePage(),
        ),
        GoRoute(
          path: '/',
          builder: (context, state) => const HomePage(),
        ),
        GoRoute(
          path: '/library',
          builder: (context, state) => const LibraryPage(),
        ),
        GoRoute(
          path: '/search',
          builder: (context, state) => const LibraryPage(),
        ),
        GoRoute(
          path: '/book/:id',
          builder: (context, state) =>
              BookDetailPage(bookId: state.pathParameters['id']!),
          routes: [
            GoRoute(
              path: 'edit',
              builder: (context, state) => PlaceholderPage(
                  title: '编辑书籍 #${state.pathParameters['id']}'),
            ),
          ],
        ),
        GoRoute(
          path: '/author/:name',
          builder: (context, state) => PlaceholderPage(
              title: '作者: ${state.pathParameters['name']}'),
        ),
        GoRoute(
          path: '/publisher/:name',
          builder: (context, state) => PlaceholderPage(
              title: '出版社: ${state.pathParameters['name']}'),
        ),
        GoRoute(
          path: '/series/:name',
          builder: (context, state) => PlaceholderPage(
              title: '系列: ${state.pathParameters['name']}'),
        ),
        GoRoute(
          path: '/tag/:name',
          builder: (context, state) =>
              PlaceholderPage(title: '标签: ${state.pathParameters['name']}'),
        ),
        GoRoute(
          path: '/format/:name',
          builder: (context, state) =>
              PlaceholderPage(title: '格式: ${state.pathParameters['name']}'),
        ),
        GoRoute(
          path: '/rating/:name',
          builder: (context, state) =>
              PlaceholderPage(title: '评分: ${state.pathParameters['name']}'),
        ),
        GoRoute(
          path: '/network',
          builder: (context, state) => const PlaceholderPage(title: '网络书库'),
          routes: [
            GoRoute(
              path: 'book',
              builder: (context, state) =>
                  const PlaceholderPage(title: '网络书库 - 搜索'),
            ),
            GoRoute(
              path: 'read',
              builder: (context, state) =>
                  const PlaceholderPage(title: '网络书库 - 阅读'),
            ),
          ],
        ),
        GoRoute(
          path: '/hot',
          builder: (context, state) => const PlaceholderPage(title: '热门书籍'),
        ),
        GoRoute(
          path: '/recent',
          builder: (context, state) => const PlaceholderPage(title: '最近更新'),
        ),
        GoRoute(
          path: '/scopedbooks',
          builder: (context, state) => const PlaceholderPage(title: '限权书籍'),
        ),
        GoRoute(
          path: '/meta/:name',
          builder: (context, state) =>
              PlaceholderPage(title: '元数据: ${state.pathParameters['name']}'),
        ),
        GoRoute(
          path: '/user',
          builder: (context, state) => const PlaceholderPage(title: '用户中心'),
          routes: [
            GoRoute(
              path: 'history',
              builder: (context, state) =>
                  const PlaceholderPage(title: '阅读历史'),
            ),
          ],
        ),
        GoRoute(
          path: '/admin',
          builder: (context, state) => const PlaceholderPage(title: '管理面板'),
          routes: [
            GoRoute(
              path: 'books',
              builder: (context, state) =>
                  const PlaceholderPage(title: '管理 - 书籍'),
            ),
            GoRoute(
              path: 'users',
              builder: (context, state) =>
                  const PlaceholderPage(title: '管理 - 用户'),
            ),
            GoRoute(
              path: 'settings',
              builder: (context, state) =>
                  const PlaceholderPage(title: '管理 - 设置'),
            ),
            GoRoute(
              path: 'booksources',
              builder: (context, state) =>
                  const PlaceholderPage(title: '管理 - 书源'),
            ),
            GoRoute(
              path: 'imports',
              builder: (context, state) =>
                  const PlaceholderPage(title: '管理 - 导入'),
            ),
            GoRoute(
              path: 'logs',
              builder: (context, state) =>
                  const PlaceholderPage(title: '管理 - 日志'),
            ),
          ],
        ),
      ];
}
