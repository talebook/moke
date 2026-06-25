import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../models/book.dart';
import '../providers/auth_provider.dart';
import '../widgets/app_shell.dart';
import '../widgets/book_card.dart';
import '../widgets/loading_indicator.dart';

class LibraryPage extends StatefulWidget {
  final String? initialQuery;

  const LibraryPage({super.key, this.initialQuery});

  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  final _searchController = TextEditingController();
  final _scrollController = ScrollController();
  List<Book> _books = [];
  int _total = 0;
  bool _isLoading = false;
  bool _isLoadingMore = false;
  String? _error;
  String _query = '';
  static const _pageSize = 40;

  @override
  void initState() {
    super.initState();
    if (widget.initialQuery != null && widget.initialQuery!.isNotEmpty) {
      _searchController.text = widget.initialQuery!;
      _query = widget.initialQuery!;
    }
    _scrollController.addListener(_onScroll);
    _loadBooks();
  }

  @override
  void dispose() {
    _searchController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scrollController.position.pixels >= _scrollController.position.maxScrollExtent - 200) {
      _loadMore();
    }
  }

  Future<void> _loadBooks() async {
    setState(() {
      _isLoading = true;
      _error = null;
    });

    final api = context.read<AuthProvider>().api;
    if (api == null) return;

    final endpoint = _query.isEmpty ? '/api/library' : '/api/search';
    final params = <String, dynamic>{'size': _pageSize.toString()};
    if (_query.isNotEmpty) params['name'] = _query;

    final response = await api.get(endpoint, queryParameters: params);
    if (!mounted) return;

    if (response.isSuccess) {
      setState(() {
        _books = response.getList('books').map((e) => Book.fromJson(e as Map<String, dynamic>)).toList();
        _total = response.getInt('total');
        _isLoading = false;
      });
    } else {
      setState(() {
        _error = response.msg.isNotEmpty ? response.msg : '加载失败';
        _isLoading = false;
      });
    }
  }

  Future<void> _loadMore() async {
    if (_isLoadingMore || _books.length >= _total) return;

    setState(() => _isLoadingMore = true);

    final api = context.read<AuthProvider>().api;
    if (api == null) return;

    final endpoint = _query.isEmpty ? '/api/library' : '/api/search';
    final params = <String, dynamic>{
      'size': _pageSize.toString(),
      'start': _books.length.toString(),
    };
    if (_query.isNotEmpty) params['name'] = _query;

    final response = await api.get(endpoint, queryParameters: params);
    if (!mounted) return;

    if (response.isSuccess) {
      setState(() {
        _books.addAll(response.getList('books').map((e) => Book.fromJson(e as Map<String, dynamic>)));
        _isLoadingMore = false;
      });
    } else {
      setState(() => _isLoadingMore = false);
    }
  }

  void _onSearch() {
    final q = _searchController.text.trim();
    if (q == _query) return;
    setState(() => _query = q);
    _books = [];
    _total = 0;
    _loadBooks();
  }

  @override
  Widget build(BuildContext context) {
    final title = _query.isEmpty ? '书库' : '搜索: $_query';
    return AppShell(
      currentRoute: '/library',
      title: title,
      child: Column(
        children: [
          _buildSearchBar(),
          const SizedBox(height: 8),
          Expanded(child: _buildBody()),
        ],
      ),
    );
  }

  Widget _buildSearchBar() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
      child: TextField(
        controller: _searchController,
        decoration: InputDecoration(
          hintText: '搜索书名、作者...',
          prefixIcon: const Icon(Icons.search, size: 20),
          suffixIcon: _query.isNotEmpty
              ? IconButton(
                  icon: const Icon(Icons.clear, size: 18),
                  onPressed: () {
                    _searchController.clear();
                    _onSearch();
                  },
                )
              : null,
        ),
        textInputAction: TextInputAction.search,
        onSubmitted: (_) => _onSearch(),
      ),
    );
  }

  Widget _buildBody() {
    if (_isLoading) {
      return const LoadingIndicator(message: '加载中...');
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_error!, style: const TextStyle(color: Color(0xFFB0B0B0))),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: _loadBooks, child: const Text('重试')),
          ],
        ),
      );
    }
    if (_books.isEmpty) {
      return Center(
        child: Text(
          _query.isEmpty ? '书库为空' : '未找到"$_query"相关书籍',
          style: const TextStyle(color: Color(0xFF808080)),
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _loadBooks,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            child: Row(
              children: [
                Text(
                  '共 $_total 本',
                  style: const TextStyle(color: Color(0xFF808080), fontSize: 12),
                ),
                const Spacer(),
              ],
            ),
          ),
          Expanded(
            child: LayoutBuilder(
              builder: (context, constraints) {
                final spacing = 12.0;
                final maxCardWidth = 110.0;
                final cols = ((constraints.maxWidth + spacing) / (maxCardWidth + spacing)).floor().clamp(2, 12);
                final cardWidth = (constraints.maxWidth - (cols - 1) * spacing) / cols;

                return GridView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                  gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: cols,
                    mainAxisSpacing: spacing,
                    crossAxisSpacing: spacing,
                    childAspectRatio: cardWidth / (cardWidth * 15 / 11 + 40),
                  ),
                  itemCount: _books.length + (_isLoadingMore ? 1 : 0),
                  itemBuilder: (ctx, index) {
                    if (index >= _books.length) {
                      return const Center(
                        child: CircularProgressIndicator(strokeWidth: 2),
                      );
                    }
                    final book = _books[index];
                    return BookCard(
                      book: book,
                      compact: true,
                      onTap: () => context.push('/book/${book.id}'),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
