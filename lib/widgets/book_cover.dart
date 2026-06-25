import 'package:flutter/material.dart';

import '../models/book.dart';

const _gradients = [
  [Color(0xFF3B6CB5), Color(0xFF2A4D8A)],
  [Color(0xFF8B2020), Color(0xFF6B1515)],
  [Color(0xFF2D7A3A), Color(0xFF1E5C28)],
  [Color(0xFF5C3D7A), Color(0xFF452D5C)],
  [Color(0xFF2A6E8A), Color(0xFF1D5570)],
  [Color(0xFFC45E8A), Color(0xFFA34570)],
  [Color(0xFFD4A843), Color(0xFFB8922E)],
  [Color(0xFFD47A2A), Color(0xFFB86420)],
  [Color(0xFF3A3A3A), Color(0xFF555555)],
  [Color(0xFF3A7A4A), Color(0xFF2A5C38)],
  [Color(0xFF7A3D3D), Color(0xFF5C2D2D)],
  [Color(0xFF4A3D7A), Color(0xFF3A2D5C)],
  [Color(0xFF2A5A7A), Color(0xFF1D4A60)],
  [Color(0xFF7A6A3D), Color(0xFF5C502D)],
];

class BookCover extends StatelessWidget {
  final Book book;
  final double? width;
  final double? height;

  const BookCover({super.key, required this.book, this.width, this.height});

  @visibleForTesting
  static List<Color> gradientForId(int id) {
    return _gradients[id.abs() % _gradients.length];
  }

  String get _coverUrl => book.thumbUrl.isNotEmpty ? book.thumbUrl : book.coverUrl;

  @override
  Widget build(BuildContext context) {
    final gradient = gradientForId(book.id);

    final content = Stack(
      fit: StackFit.expand,
      children: [
        Container(
          decoration: BoxDecoration(
            gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: gradient),
          ),
        ),
        if (_coverUrl.isNotEmpty)
          Image.network(
            _coverUrl,
            fit: BoxFit.cover,
            errorBuilder: (c, e, s) => const SizedBox.shrink(),
            loadingBuilder: (c, child, progress) {
              if (progress == null) return child;
              return const SizedBox.shrink();
            },
          ),
        Positioned(
          left: 0,
          right: 0,
          bottom: 0,
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: const BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.bottomCenter,
                end: Alignment.topCenter,
                colors: [Color(0xB3000000), Color(0x00000000)],
              ),
            ),
            child: Text(
              book.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: Colors.white, fontSize: 12, fontWeight: FontWeight.w600),
            ),
          ),
        ),
      ],
    );

    final result = ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: content,
    );

    if (width != null || height != null) {
      final w = width ?? (height! * 11 / 15);
      final h = height ?? (width! * 15 / 11);
      return SizedBox(width: w, height: h, child: result);
    }
    return AspectRatio(aspectRatio: 11 / 15, child: result);
  }
}
