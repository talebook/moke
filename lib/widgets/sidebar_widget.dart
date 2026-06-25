import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../providers/auth_provider.dart';
import '../theme/app_theme.dart';

class SidebarWidget extends StatelessWidget {
  final String? currentRoute;

  const SidebarWidget({super.key, this.currentRoute});

  @override
  Widget build(BuildContext context) {
    final authProvider = context.watch<AuthProvider>();
    final user = authProvider.user;
    final sys = authProvider.sysInfo;

    return Container(
      width: 240,
      color: AppColors.surfaceSidebar,
      child: Column(
        children: [
          const SizedBox(height: 8),
          _buildUserProfile(user),
          const SizedBox(height: 12),
          const Divider(color: AppColors.borderLight, height: 1),
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: [
                const SizedBox(height: 8),
                _buildMainNav(context),
                const SizedBox(height: 12),
                if (user.isAdmin) ...[
                  _buildSectionTitle('管理后台'),
                  _buildNavItem(context, icon: Icons.admin_panel_settings, label: '系统设置', route: '/admin/settings'),
                  _buildNavItem(context, icon: Icons.people_outline, label: '用户管理', route: '/admin/users'),
                  _buildNavItem(context, icon: Icons.menu_book, label: '书籍管理', route: '/admin/books'),
                  _buildNavItem(context, icon: Icons.drive_folder_upload, label: '导入管理', route: '/admin/imports'),
                  const SizedBox(height: 12),
                ],
                _buildSectionTitle('分类浏览'),
                _buildCategoryItems(context, sys),
                const SizedBox(height: 12),
                _buildSectionTitle('更多'),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: GridView.count(
                    crossAxisCount: 2,
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    mainAxisSpacing: 4,
                    crossAxisSpacing: 4,
                    childAspectRatio: 3.0,
                    children: [
                      _buildMiniBtn(context, '丛书', '/series', Icons.collections_bookmark),
                      _buildMiniBtn(context, '评分', '/rating', Icons.star),
                      _buildMiniBtn(context, '热门', '/hot', Icons.local_fire_department),
                      _buildMiniBtn(context, '最近', '/recent', Icons.update),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                const Divider(color: AppColors.borderLight, height: 1),
                const SizedBox(height: 8),
                _buildNavItem(context, icon: Icons.rss_feed, label: 'OPDS', route: '/opds'),
              ],
            ),
          ),
          const Divider(color: AppColors.borderLight, height: 1),
          _buildLogoutItem(context, authProvider),
          const SizedBox(height: 8),
        ],
      ),
    );
  }

  Widget _buildUserProfile(dynamic user) {
    final initial = user.nickname.isNotEmpty
        ? user.nickname[0].toUpperCase()
        : user.username.isNotEmpty
            ? user.username[0].toUpperCase()
            : '?';
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(
              color: AppColors.brandPrimaryMuted,
              borderRadius: BorderRadius.circular(18),
            ),
            alignment: Alignment.center,
            child: Text(
              initial,
              style: const TextStyle(color: AppColors.brandPrimary, fontSize: 15, fontWeight: FontWeight.w600),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              user.nickname.isNotEmpty ? user.nickname : user.username,
              style: const TextStyle(color: AppColors.textPrimary, fontSize: 14, fontWeight: FontWeight.w500),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSectionTitle(String title) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      child: Text(
        title,
        style: const TextStyle(color: AppColors.textTertiary, fontSize: 11, fontWeight: FontWeight.w600, letterSpacing: 1.2),
      ),
    );
  }

  Widget _buildMainNav(BuildContext context) {
    return Column(
      children: [
        _buildNavItem(context, icon: Icons.home, label: '首页', route: '/', active: true),
        _buildNavItem(context, icon: Icons.library_books, label: '本地书库', route: '/library'),
        _buildNavItem(context, icon: Icons.language, label: '网络书库', route: '/network'),
      ],
    );
  }

  Widget _buildNavItem(
    BuildContext context, {
    required IconData icon,
    required String label,
    required String route,
    bool active = false,
  }) {
    final isActive = active || currentRoute == route;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Material(
        color: isActive ? AppColors.brandPrimaryMuted : Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () {
            if (route == '/') {
              context.go('/');
            } else {
              context.push(route);
            }
          },
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                Icon(icon, size: 20, color: isActive ? AppColors.brandPrimary : AppColors.textTertiary),
                const SizedBox(width: 10),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 14,
                    color: isActive ? AppColors.brandPrimary : AppColors.textSecondary,
                    fontWeight: isActive ? FontWeight.w500 : FontWeight.w400,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildCategoryItems(BuildContext context, Map<String, dynamic> sys) {
    final items = [
      {'icon': Icons.book, 'label': '书库', 'count': '${sys['books'] ?? 0}', 'route': '/library'},
      {'icon': Icons.person, 'label': '作者', 'count': '${sys['authors'] ?? 0}', 'route': '/author'},
      {'icon': Icons.business, 'label': '出版社', 'count': '${sys['publishers'] ?? 0}', 'route': '/publisher'},
      {'icon': Icons.label, 'label': '标签', 'count': '${sys['tags'] ?? 0}', 'route': '/tag'},
      {'icon': Icons.description, 'label': '格式', 'count': '${sys['formats'] ?? 0}', 'route': '/format'},
    ];

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8),
      child: Column(
        children: items.map((item) {
          return Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(8),
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: () => context.push(item['route'] as String),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                child: Row(
                  children: [
                    Icon(item['icon'] as IconData, size: 18, color: AppColors.textTertiary),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(item['label'] as String, style: const TextStyle(fontSize: 14, color: AppColors.textSecondary)),
                    ),
                    Text(item['count'] as String, style: const TextStyle(fontSize: 13, color: AppColors.textTertiary)),
                  ],
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }

  Widget _buildMiniBtn(BuildContext context, String label, String route, IconData icon) {
    return Material(
      color: AppColors.surfaceInput,
      borderRadius: BorderRadius.circular(6),
      child: InkWell(
        borderRadius: BorderRadius.circular(6),
        onTap: () => context.push(route),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 14, color: AppColors.brandPrimary),
              const SizedBox(width: 4),
              Text(label, style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildLogoutItem(BuildContext context, AuthProvider authProvider) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(8),
        child: InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () => authProvider.logout(),
          child: const Padding(
            padding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                Icon(Icons.logout, size: 20, color: AppColors.accentRed),
                SizedBox(width: 10),
                Text('登出', style: TextStyle(fontSize: 14, color: AppColors.accentRed)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
