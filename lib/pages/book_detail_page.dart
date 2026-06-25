import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../models/book.dart';
import '../providers/auth_provider.dart';
import '../theme/app_theme.dart';
import '../widgets/app_shell.dart';
import '../widgets/book_cover.dart';
import '../widgets/loading_indicator.dart';

class BookDetailPage extends StatefulWidget {
  final String bookId;

  const BookDetailPage({super.key, required this.bookId});

  @override
  State<BookDetailPage> createState() => _BookDetailPageState();
}

class _BookDetailPageState extends State<BookDetailPage> {
  Map<String, dynamic>? _bookData;
  List<Map<String, dynamic>> _files = [];
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadBook();
  }

  Future<void> _loadBook() async {
    setState(() { _isLoading = true; _error = null; });

    final api = context.read<AuthProvider>().api;
    if (api == null) return;

    final response = await api.get('/api/book/${widget.bookId}');
    if (!mounted) return;

    if (response.isSuccess) {
      final book = response.getMap('book');
      setState(() {
        _bookData = book;
        _files = (book['files'] as List<dynamic>?)?.map((e) => e as Map<String, dynamic>).toList() ?? [];
        _isLoading = false;
      });
    } else {
      setState(() {
        _error = response.msg.isNotEmpty ? response.msg : '加载失败';
        _isLoading = false;
      });
    }
  }

  String _formatSize(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }

  static const _formatColors = <String, Color>{
    'epub': Color(0x265B8CFF),
    'mobi': Color(0x26FA8C16),
    'azw': Color(0x26FA8C16),
    'azw3': Color(0x26FA8C16),
    'pdf': Color(0x26FF4D4F),
    'txt': Color(0x2652C41A),
  };

  static const _formatFgColors = <String, Color>{
    'epub': Color(0xFF5B8CFF),
    'mobi': Color(0xFFFA8C16),
    'azw': Color(0xFFFA8C16),
    'azw3': Color(0xFFFA8C16),
    'pdf': Color(0xFFFF4D4F),
    'txt': Color(0xFF52C41A),
  };

  Color _formatBg(String fmt) => _formatColors[fmt.toLowerCase()] ?? const Color(0x265B8CFF);
  Color _formatFg(String fmt) => _formatFgColors[fmt.toLowerCase()] ?? const Color(0xFF5B8CFF);

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return AppShell(
        currentRoute: '/book/${widget.bookId}',
        title: '书籍详情',
        child: const LoadingIndicator(message: '加载中...'),
      );
    }
    if (_error != null) {
      return AppShell(
        currentRoute: '/book/${widget.bookId}',
        title: '书籍详情',
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(_error!, style: const TextStyle(color: AppColors.textTertiary)),
              const SizedBox(height: 12),
              OutlinedButton(onPressed: _loadBook, child: const Text('重试')),
            ],
          ),
        ),
      );
    }
    if (_bookData == null) return const SizedBox.shrink();

    final book = Book.fromJson(_bookData!);
    final comments = (_bookData!['comments'] as String?) ?? '';
    final publisher = (_bookData!['publisher'] as String?) ?? '';
    final series = (_bookData!['series'] as String?) ?? '';
    final isbn = (_bookData!['isbn'] as String?) ?? '';
    final pubdate = (_bookData!['pubdate'] as String?) ?? '';
    final tags = book.tags;

    return AppShell(
      currentRoute: '/book/${widget.bookId}',
      title: book.title,
      child: RefreshIndicator(
        onRefresh: _loadBook,
        child: SingleChildScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 896),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 192,
                      child: BookCover(book: book, width: 192),
                    ),
                    const SizedBox(width: 32),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(book.title, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.w700, color: AppColors.textPrimary, height: 1.25)),
                          const SizedBox(height: 8),
                          Text(book.author, style: const TextStyle(fontSize: 14, color: AppColors.textSecondary)),
                          if (book.rating > 0) ...[
                            const SizedBox(height: 12),
                            _buildStars(book.rating),
                          ],
                          if (publisher.isNotEmpty || pubdate.isNotEmpty || isbn.isNotEmpty || series.isNotEmpty) ...[
                            const SizedBox(height: 16),
                            Wrap(
                              spacing: 24,
                              runSpacing: 8,
                              children: [
                                if (publisher.isNotEmpty) _metaText('出版社: $publisher'),
                                if (pubdate.isNotEmpty) _metaText('出版日期: $pubdate'),
                                if (isbn.isNotEmpty) _metaText('ISBN: $isbn'),
                                if (series.isNotEmpty) _metaText('丛书: $series'),
                              ],
                            ),
                          ],
                          if (tags.isNotEmpty) ...[
                            const SizedBox(height: 16),
                            Wrap(spacing: 8, runSpacing: 6, children: tags.map((t) => _buildTag(t)).toList()),
                          ],
                          if (comments.isNotEmpty) ...[
                            const SizedBox(height: 20),
                            Text(comments.replaceAll(RegExp(r'<[^>]*>'), '').trim(),
                              maxLines: 6,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12, color: AppColors.textSecondary, height: 1.625)),
                          ],
                          const SizedBox(height: 24),
                          Wrap(spacing: 8, runSpacing: 8, children: [
                            _actionBtn('在线阅读', Icons.menu_book, AppColors.brandPrimary, AppColors.textPrimary),
                            _actionBtn('下载', Icons.download, Colors.transparent, AppColors.textPrimary),
                            _actionBtn('推送到设备', Icons.send, Colors.transparent, AppColors.textPrimary),
                            _actionBtn('加入收藏', Icons.favorite, Colors.transparent, AppColors.accentRed),
                          ]),
                        ],
                      ),
                    ),
                  ],
                ),
                if (_files.isNotEmpty) ...[
                  const SizedBox(height: 40),
                  const Text('可用格式', style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: AppColors.textPrimary)),
                  const SizedBox(height: 16),
                  _buildFilesList(),
                ],
                const SizedBox(height: 24),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _metaText(String text) {
    return Text(text, style: const TextStyle(fontSize: 12, color: AppColors.textSecondary));
  }

  Widget _buildTag(String tag) {
    return GestureDetector(
      onTap: () => context.push('/tag/$tag'),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        decoration: BoxDecoration(color: AppColors.brandPrimaryMuted, borderRadius: BorderRadius.circular(8)),
        child: Text(tag, style: const TextStyle(fontSize: 11, color: AppColors.brandPrimary)),
      ),
    );
  }

  Widget _buildStars(double rating) {
    final full = rating.floor();
    final hasHalf = (rating - full) >= 0.5;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        ...List.generate(full, (_) => const Icon(Icons.star, size: 16, color: AppColors.accentYellow)),
        if (hasHalf) const Icon(Icons.star_half, size: 16, color: AppColors.accentYellow),
        ...List.generate(5 - full - (hasHalf ? 1 : 0), (_) => const Icon(Icons.star_border, size: 16, color: AppColors.accentYellow)),
        const SizedBox(width: 8),
        Text(rating.toStringAsFixed(1), style: const TextStyle(fontSize: 12, color: AppColors.textTertiary)),
      ],
    );
  }

  Widget _actionBtn(String label, IconData icon, Color bg, Color fg) {
    return OutlinedButton.icon(
      onPressed: () {},
      icon: Icon(icon, size: 14, color: fg),
      label: Text(label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: fg)),
      style: OutlinedButton.styleFrom(
        backgroundColor: bg,
        side: BorderSide(color: bg == Colors.transparent ? AppColors.borderDefault : Colors.transparent),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      ),
    );
  }

  Widget _buildFilesList() {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: AppColors.borderDefault),
      ),
      child: Column(
        children: _files.asMap().entries.map((entry) {
          final file = entry.value;
          final format = (file['format'] as String?)?.toUpperCase() ?? '??';
          final size = file['size'] as int? ?? 0;
          final href = file['href'] as String? ?? '';
          final short = format.length > 2 ? format.substring(0, 2) : format;

          return Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
            decoration: BoxDecoration(
              border: entry.key < _files.length - 1
                  ? const Border(bottom: BorderSide(color: AppColors.borderLight))
                  : null,
            ),
            child: Row(
              children: [
                Container(
                  width: 32, height: 32,
                  decoration: BoxDecoration(color: _formatBg(format), borderRadius: BorderRadius.circular(4)),
                  alignment: Alignment.center,
                  child: Text(short, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: _formatFg(format))),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(format, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: AppColors.textPrimary)),
                      const SizedBox(height: 2),
                      Text(href.isNotEmpty ? href : _formatSize(size), maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 11, color: AppColors.textTertiary)),
                    ],
                  ),
                ),
                Text(_formatSize(size), style: const TextStyle(fontSize: 12, color: AppColors.textSecondary)),
                const SizedBox(width: 20),
                _downloadBtn(),
              ],
            ),
          );
        }).toList(),
      ),
    );
  }

  Widget _downloadBtn() {
    return SizedBox(
      height: 30,
      child: ElevatedButton.icon(
        onPressed: () {},
        icon: const Icon(Icons.download, size: 13),
        label: const Text('下载', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w500)),
        style: ElevatedButton.styleFrom(
          backgroundColor: AppColors.brandPrimary,
          foregroundColor: Colors.white,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
          elevation: 0,
        ),
      ),
    );
  }
}
