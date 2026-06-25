import 'package:flutter/material.dart';

import '../models/book.dart';
import '../theme/app_theme.dart';
import 'book_cover_image.dart';

class BookCard extends StatelessWidget {
  final Book book;
  final VoidCallback? onTap;
  final double coverWidth;
  final bool compact;

  const BookCard({
    super.key,
    required this.book,
    this.onTap,
    this.coverWidth = 140,
    this.compact = false,
  });

  String get _coverUrl => book.thumbUrl.isNotEmpty ? book.thumbUrl : book.coverUrl;

  @override
  Widget build(BuildContext context) {
    final h = coverWidth > 0 ? coverWidth * 15 / 11 : null;

    final card = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        _buildCover(h),
        if (!compact) ...[
          const SizedBox(height: 8),
          Text(
            book.title,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 13, color: AppColors.textPrimary, fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: 2),
          Text(
            book.author,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 11, color: AppColors.textTertiary),
          ),
          if (book.rating > 0) ...[
            const SizedBox(height: 2),
            Row(
              children: [
                const Icon(Icons.star, size: 11, color: AppColors.accentYellow),
                const SizedBox(width: 3),
                Text(book.rating.toStringAsFixed(1), style: const TextStyle(fontSize: 11, color: AppColors.textSecondary)),
              ],
            ),
          ],
        ],
      ],
    );

    return GestureDetector(
      onTap: onTap,
      child: coverWidth > 0 ? SizedBox(width: coverWidth, child: card) : card,
    );
  }

  Widget _buildCover(double? h) {
    final cover = BookCoverImage(
      imageUrl: _coverUrl,
      borderRadius: BorderRadius.circular(8),
    );

    if (h != null) {
      return SizedBox(width: coverWidth > 0 ? coverWidth : double.infinity, height: h, child: cover);
    }
    return AspectRatio(aspectRatio: 11 / 15, child: cover);
  }
}
