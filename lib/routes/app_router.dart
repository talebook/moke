import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../pages/book_detail_page.dart';
import '../pages/category_page.dart';
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
              builder: (context, state) =>
                  PlaceholderPage(title: '编辑书籍 #${state.pathParameters['id']}'),
            ),
          ],
        ),
        GoRoute(
          path: '/author',
          builder: (context, state) =>
              const CategoryPage(type: 'author'),
          routes: [
            GoRoute(
              path: ':name',
              builder: (context, state) =>
                  CategoryPage(type: 'author', initialValue: state.pathParameters['name']!),
            ),
          ],
        ),
        GoRoute(
          path: '/publisher',
          builder: (context, state) =>
              const CategoryPage(type: 'publisher'),
          routes: [
            GoRoute(
              path: ':name',
              builder: (context, state) =>
                  CategoryPage(type: 'publisher', initialValue: state.pathParameters['name']!),
            ),
          ],
        ),
        GoRoute(
          path: '/tag',
          builder: (context, state) =>
              const CategoryPage(type: 'tag'),
          routes: [
            GoRoute(
              path: ':name',
              builder: (context, state) =>
                  CategoryPage(type: 'tag', initialValue: state.pathParameters['name']!),
            ),
          ],
        ),
        GoRoute(
          path: '/format',
          builder: (context, state) =>
              const CategoryPage(type: 'format'),
          routes: [
            GoRoute(
              path: ':name',
              builder: (context, state) =>
                  CategoryPage(type: 'format', initialValue: state.pathParameters['name']!),
            ),
          ],
        ),
        GoRoute(
          path: '/series',
          builder: (context, state) =>
              const CategoryPage(type: 'series'),
          routes: [
            GoRoute(
              path: ':name',
              builder: (context, state) =>
                  CategoryPage(type: 'series', initialValue: state.pathParameters['name']!),
            ),
          ],
        ),
        GoRoute(
          path: '/rating',
          builder: (context, state) =>
              const CategoryPage(type: 'rating'),
          routes: [
            GoRoute(
              path: ':name',
              builder: (context, state) =>
                  CategoryPage(type: 'rating', initialValue: state.pathParameters['name']!),
            ),
          ],
        ),
        GoRoute(
          path: '/hot',
          builder: (context, state) => const CategoryPage(type: 'hot'),
        ),
        GoRoute(
          path: '/recent',
          builder: (context, state) => const CategoryPage(type: 'recent'),
        ),
        GoRoute(
          path: '/opds',
          builder: (context, state) => const PlaceholderPage(title: 'OPDS'),
        ),
        GoRoute(
          path: '/network',
          builder: (context, state) => const PlaceholderPage(title: '网络书库'),
        ),
        GoRoute(
          path: '/scopedbooks',
          builder: (context, state) => const PlaceholderPage(title: '限权书籍'),
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
