import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../models/book.dart';
import '../providers/auth_provider.dart';
import '../theme/app_theme.dart';
import '../widgets/app_shell.dart';
import '../widgets/book_card.dart';
import '../widgets/loading_indicator.dart';

class HomePage extends StatefulWidget {
  const HomePage({super.key});

  @override
  State<HomePage> createState() => _HomePageState();
}

class _HomePageState extends State<HomePage> {
  List<Book> _hotBooks = [];
  List<Book> _recentBooks = [];
  Map<String, dynamic> _sysInfo = {};
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });

    final api = context.read<AuthProvider>().api;
    if (api == null) return;

    final results = await Future.wait([
      api.get('/api/hot', queryParameters: {'size': '12'}),
      api.get('/api/recent', queryParameters: {'size': '12'}),
      api.get('/api/user/info'),
    ]);

    if (!mounted) return;

    final hotRes = results[0];
    final recentRes = results[1];
    final infoRes = results[2];

    if (hotRes.isSuccess) {
      _hotBooks = hotRes.getList('books').map((e) => Book.fromJson(e as Map<String, dynamic>)).toList();
    }
    if (recentRes.isSuccess) {
      _recentBooks = recentRes.getList('books').map((e) => Book.fromJson(e as Map<String, dynamic>)).toList();
    }
    if (infoRes.isSuccess) {
      _sysInfo = infoRes.getMap('sys');
    }

    setState(() {
      _isLoading = false;
      _error = (!hotRes.isSuccess && !recentRes.isSuccess) ? '加载失败' : null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return AppShell(
      currentRoute: '/',
      child: _buildContent(),
    );
  }

  Widget _buildContent() {
    if (_isLoading) {
      return const LoadingIndicator(message: '加载中...');
    }
    if (_error != null) {
      return _buildError();
    }
    return _buildBody();
  }

  Widget _buildError() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(_error!, style: const TextStyle(color: AppColors.textTertiary)),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: _loadData, child: const Text('重试')),
        ],
      ),
    );
  }

  Widget _buildBody() {
    return LayoutBuilder(
      builder: (context, constraints) {
        final contentWidth = constraints.maxWidth;
        final maxCardWidth = 160.0;
        final spacing = 12.0;
        final totalCols = ((contentWidth + spacing) / (maxCardWidth + spacing)).floor().clamp(2, 8);
        final w = (contentWidth - (totalCols - 1) * spacing) / totalCols;

        return RefreshIndicator(
          onRefresh: _loadData,
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              if (_hotBooks.isNotEmpty) ...[
                _buildSectionTitle('推荐', () => context.push('/hot')),
                const SizedBox(height: 12),
                _buildHorizontalScroll(_hotBooks),
              ],
              if (_recentBooks.isNotEmpty) ...[
                const SizedBox(height: 32),
                _buildSectionTitle('新书', () => context.push('/recent')),
                const SizedBox(height: 12),
                _buildGrid(_recentBooks, w, spacing),
              ],
              const SizedBox(height: 32),
              _buildSectionTitle('分类浏览', null),
              const SizedBox(height: 12),
              _buildCategoryGrid(_sysInfo, contentWidth),
              const SizedBox(height: 24),
            ],
          ),
        );
      },
    );
  }

  Widget _buildSectionTitle(String title, VoidCallback? onMore) {
    return Row(
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 17,
            fontWeight: FontWeight.w600,
            color: AppColors.textPrimary,
          ),
        ),
        const Spacer(),
        if (onMore != null)
          GestureDetector(
            onTap: onMore,
            child: const Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('更多', style: TextStyle(fontSize: 12, color: AppColors.textTertiary)),
                SizedBox(width: 2),
                Icon(Icons.chevron_right, size: 16, color: AppColors.textTertiary),
              ],
            ),
          ),
      ],
    );
  }

  Widget _buildHorizontalScroll(List<Book> books) {
    return SizedBox(
      height: 162,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: books.length,
        separatorBuilder: (c, i) => const SizedBox(width: 12),
        itemBuilder: (_, index) {
          final book = books[index];
          return BookCard(
            book: book,
            coverWidth: 88,
            onTap: () => context.push('/book/${book.id}'),
          );
        },
      ),
    );
  }

  Widget _buildGrid(List<Book> books, double cardWidth, double spacing) {
    if (books.isEmpty) return const SizedBox.shrink();
    return Wrap(
      spacing: spacing,
      runSpacing: spacing,
      children: books.map((book) {
        return SizedBox(
          width: cardWidth,
          child: BookCard(
            book: book,
            coverWidth: cardWidth,
            onTap: () => context.push('/book/${book.id}'),
          ),
        );
      }).toList(),
    );
  }

  Widget _buildCategoryGrid(Map<String, dynamic> sys, double contentWidth) {
    final categories = [
      _CategoryEntry(
        icon: Icons.book,
        label: '书库',
        subtitle: '${sys['books'] ?? 0}本',
        route: '/library',
        bgColor: AppColors.brandPrimaryMuted,
        iconColor: AppColors.brandPrimary,
      ),
      _CategoryEntry(
        icon: Icons.person,
        label: '作者',
        subtitle: '${sys['authors'] ?? 0}位',
        route: '/author',
        bgColor: AppColors.accentGreenMuted,
        iconColor: AppColors.accentGreen,
      ),
      _CategoryEntry(
        icon: Icons.business,
        label: '出版社',
        subtitle: '${sys['publishers'] ?? 0}家',
        route: '/publisher',
        bgColor: AppColors.accentOrangeMuted,
        iconColor: AppColors.accentOrange,
      ),
      _CategoryEntry(
        icon: Icons.label,
        label: '标签',
        subtitle: '${sys['tags'] ?? 0}个',
        route: '/tag',
        bgColor: AppColors.accentRedMuted,
        iconColor: AppColors.accentRed,
      ),
      _CategoryEntry(
        icon: Icons.description,
        label: '格式',
        subtitle: '${sys['formats'] ?? 0}种',
        route: '/format',
        bgColor: const Color(0x26FFD666),
        iconColor: AppColors.accentYellow,
      ),
      _CategoryEntry(
        icon: Icons.update,
        label: '最近更新',
        subtitle: sys['mtime'] as String? ?? '',
        route: '/recent',
        bgColor: AppColors.brandPrimaryMuted,
        iconColor: AppColors.brandPrimary,
      ),
    ];

    final cols = contentWidth > 600 ? 3 : 2;

    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: categories.map((cat) {
        return SizedBox(
          width: (contentWidth - 8 * (cols - 1)) / cols,
          child: _buildCategoryCard(cat),
        );
      }).toList(),
    );
  }

  Widget _buildCategoryCard(_CategoryEntry cat) {
    return Material(
      color: AppColors.surfaceCard,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: () => context.push(cat.route),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: AppColors.borderLight),
          ),
          child: Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: cat.bgColor,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(cat.icon, size: 18, color: cat.iconColor),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      cat.label,
                      style: const TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                        color: AppColors.textPrimary,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      cat.subtitle,
                      style: const TextStyle(fontSize: 11, color: AppColors.textTertiary),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right, size: 16, color: AppColors.textTertiary),
            ],
          ),
        ),
      ),
    );
  }
}

class _CategoryEntry {
  final IconData icon;
  final String label;
  final String subtitle;
  final String route;
  final Color bgColor;
  final Color iconColor;

  const _CategoryEntry({
    required this.icon,
    required this.label,
    required this.subtitle,
    required this.route,
    required this.bgColor,
    required this.iconColor,
  });
}
