import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../models/book.dart';
import '../providers/auth_provider.dart';
import '../theme/app_theme.dart';
import '../widgets/app_shell.dart';
import '../widgets/book_card.dart';
import '../widgets/loading_indicator.dart';

class CategoryPage extends StatefulWidget {
  final String type;
  final String? initialValue;

  const CategoryPage({super.key, required this.type, this.initialValue});

  @override
  State<CategoryPage> createState() => _CategoryPageState();

  static const _labels = {
    'author': '作者',
    'publisher': '出版社',
    'tag': '标签',
    'format': '格式',
    'series': '丛书',
    'rating': '评分',
    'hot': '热门',
    'recent': '最近',
  };

  String get label => _labels[type] ?? type;
}

class _CategoryPageState extends State<CategoryPage> {
  List<Book> _books = [];
  bool _isLoading = true;
  bool _hasMore = true;
  String? _error;
  final int _pageSize = 30;
  final _scrollCtrl = ScrollController();
  final _searchCtrl = TextEditingController();
  String _query = '';

  bool get _isLibraryType => !['hot', 'recent'].contains(widget.type);

  @override
  void initState() {
    super.initState();
    if (widget.initialValue != null && widget.initialValue!.isNotEmpty) {
      _searchCtrl.text = widget.initialValue!;
      _query = widget.initialValue!;
    }
    _loadData();
    _scrollCtrl.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollCtrl.dispose();
    _searchCtrl.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scrollCtrl.position.pixels >= _scrollCtrl.position.maxScrollExtent - 200) {
      _loadMore();
    }
  }

  Future<void> _loadData() async {
    setState(() { _isLoading = true; _error = null; _books = []; _hasMore = true; });
    await _fetch();
  }

  Future<void> _loadMore() async {
    if (_isLoading || !_hasMore) return;
    setState(() => _isLoading = true);
    await _fetch();
  }

  Future<void> _fetch() async {
    final api = context.read<AuthProvider>().api;
    if (api == null) return;

    final params = <String, dynamic>{
      'size': _pageSize.toString(),
      'start': _books.length.toString(),
    };
    if (_query.isNotEmpty && _isLibraryType) params[widget.type] = _query;

    final endpoint = widget.type == 'hot'
        ? '/api/hot'
        : widget.type == 'recent'
            ? '/api/recent'
            : '/api/library';
    final response = await api.get(endpoint, queryParameters: params);
    if (!mounted) return;

    if (response.isSuccess) {
      final newBooks = response.getList('books').map((e) => Book.fromJson(e as Map<String, dynamic>)).toList();
      setState(() {
        _books.addAll(newBooks);
        _hasMore = newBooks.length >= _pageSize;
        _isLoading = false;
      });
    } else {
      setState(() { _isLoading = false; _error = response.msg.isNotEmpty ? response.msg : '加载失败'; });
    }
  }

  void _search(String q) {
    setState(() { _query = q.trim(); _books = []; });
    _fetch();
  }

  @override
  Widget build(BuildContext context) {
    final title = _query.isEmpty ? '浏览${widget.label}' : '${widget.label}: $_query';
    return AppShell(
      currentRoute: '/${widget.type}',
      title: title,
      child: Column(
        children: [
          if (_isLibraryType) _buildSearchBar(),
          Expanded(child: _buildBody()),
        ],
      ),
    );
  }

  Widget _buildSearchBar() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 8),
      child: Container(
        decoration: BoxDecoration(
          color: AppColors.surfaceInput,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: AppColors.borderDefault),
        ),
        child: Row(
          children: [
            const SizedBox(width: 14),
            const Icon(Icons.search, size: 18, color: AppColors.textTertiary),
            const SizedBox(width: 8),
            Expanded(
              child: TextField(
                controller: _searchCtrl,
                style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
                decoration: InputDecoration(
                  hintText: '搜索${widget.label}...',
                  hintStyle: const TextStyle(color: AppColors.textTertiary),
                  border: InputBorder.none,
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(vertical: 12),
                ),
                onSubmitted: _search,
              ),
            ),
            if (_query.isNotEmpty)
              IconButton(
                icon: const Icon(Icons.clear, size: 16, color: AppColors.textTertiary),
                visualDensity: VisualDensity.compact,
                onPressed: () {
                  _searchCtrl.clear();
                  _search('');
                },
              ),
            const SizedBox(width: 6),
          ],
        ),
      ),
    );
  }

  Widget _buildBody() {
    if (_isLoading && _books.isEmpty) return const LoadingIndicator(message: '加载中...');
    if (_error != null && _books.isEmpty) {
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
    if (_books.isEmpty) {
      return Center(
        child: Text('暂无${widget.label}书籍', style: const TextStyle(color: AppColors.textTertiary)),
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final spacing = 12.0;
        final maxCardWidth = 110.0;
        final cols = ((constraints.maxWidth + spacing) / (maxCardWidth + spacing)).floor().clamp(2, 12);
        final cardWidth = (constraints.maxWidth - (cols - 1) * spacing) / cols;

        return GridView.builder(
          controller: _scrollCtrl,
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: cols,
            mainAxisSpacing: spacing,
            crossAxisSpacing: spacing,
            childAspectRatio: cardWidth / (cardWidth * 15 / 11 + 40),
          ),
          itemCount: _books.length + (_hasMore ? 1 : 0),
          itemBuilder: (_, index) {
            if (index >= _books.length) {
              return const LoadingIndicator(message: '加载更多...');
            }
            return BookCard(
              book: _books[index],
              coverWidth: cardWidth,
              onTap: () => context.push('/book/${_books[index].id}'),
            );
          },
        );
      },
    );
  }
}
