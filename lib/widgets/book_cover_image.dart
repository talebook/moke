import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

class BookCoverImage extends StatelessWidget {
  final String? imageUrl;
  final double? width;
  final double? height;
  final BorderRadius? borderRadius;
  final BoxFit fit;

  const BookCoverImage({
    super.key,
    this.imageUrl,
    this.width,
    this.height,
    this.borderRadius,
    this.fit = BoxFit.cover,
  });

  @override
  Widget build(BuildContext context) {
    final radius = borderRadius ?? BorderRadius.circular(4);

    if (imageUrl == null || imageUrl!.isEmpty) {
      return _buildPlaceholder(radius);
    }

    return ClipRRect(
      borderRadius: radius,
      child: Image.network(
        imageUrl!,
        width: width,
        height: height,
        fit: fit,
        errorBuilder: (context, error, stackTrace) => _buildPlaceholder(radius),
        loadingBuilder: (context, child, loadingProgress) {
          if (loadingProgress == null) return child;
          return _buildLoadingPlaceholder(radius, loadingProgress);
        },
      ),
    );
  }

  Widget _buildPlaceholder(BorderRadius radius) {
    return Container(
      width: width,
      height: height ?? width,
      decoration: BoxDecoration(
        color: AppColors.bgTertiary,
        borderRadius: radius,
      ),
      child: const Center(
        child: Icon(
          Icons.book,
          color: AppColors.textTertiary,
          size: 32,
        ),
      ),
    );
  }

  Widget _buildLoadingPlaceholder(
      BorderRadius radius, ImageChunkEvent progress) {
    return Container(
      width: width,
      height: height ?? width,
      decoration: BoxDecoration(
        color: AppColors.bgTertiary,
        borderRadius: radius,
      ),
      child: Center(
        child: CircularProgressIndicator(
          value: progress.expectedTotalBytes != null
              ? progress.cumulativeBytesLoaded / progress.expectedTotalBytes!
              : null,
          color: AppColors.brandPrimary,
          strokeWidth: 2,
        ),
      ),
    );
  }
}
