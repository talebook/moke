import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../theme/app_theme.dart';
import 'sidebar_widget.dart';

class AppShell extends StatelessWidget {
  final Widget child;
  final String? currentRoute;
  final String? title;
  final List<Widget>? actions;

  const AppShell({
    super.key,
    required this.child,
    this.currentRoute,
    this.title,
    this.actions,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Row(
        children: [
          SidebarWidget(currentRoute: currentRoute),
          Container(width: 1, color: AppColors.borderLight),
          Expanded(
            child: Column(
              children: [
                if (title != null || actions != null) _buildHeader(context),
                Expanded(child: child),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
    final router = GoRouter.of(context);
    final canGoBack = router.canPop();

    return Container(
      height: 44,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: const BoxDecoration(
        color: AppColors.surfaceCard,
        border: Border(bottom: BorderSide(color: AppColors.borderLight)),
      ),
      child: Row(
        children: [
          if (canGoBack)
            IconButton(
              icon: const Icon(Icons.arrow_back, size: 20),
              color: AppColors.textSecondary,
              visualDensity: VisualDensity.compact,
              onPressed: () => router.pop(),
            ),
          if (title != null) ...[
            const SizedBox(width: 4),
            Text(
              title!,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: AppColors.textPrimary),
            ),
          ],
          const Spacer(),
          ...?actions,
        ],
      ),
    );
  }
}
