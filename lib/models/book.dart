class Book {
  final int id;
  final String title;
  final String author;
  final double rating;
  final String coverUrl;
  final String thumbUrl;
  final String? publisher;
  final String? series;
  final List<String> tags;
  final String? comments;
  final int countVisit;
  final int countDownload;
  final String timestamp;

  Book({
    required this.id,
    required this.title,
    required this.author,
    this.rating = 0,
    required this.coverUrl,
    required this.thumbUrl,
    this.publisher,
    this.series,
    this.tags = const [],
    this.comments,
    this.countVisit = 0,
    this.countDownload = 0,
    this.timestamp = '',
  });

  factory Book.fromJson(Map<String, dynamic> json) {
    return Book(
      id: json['id'] as int? ?? 0,
      title: json['title'] as String? ?? '未知书名',
      author: json['author'] as String? ?? '未知作者',
      rating: (json['rating'] as num?)?.toDouble() ?? 0,
      coverUrl: json['img'] as String? ?? '',
      thumbUrl: json['thumb'] as String? ?? '',
      publisher: json['publisher'] as String?,
      series: json['series'] as String?,
      tags: (json['tags'] as List<dynamic>?)
              ?.map((e) => e.toString())
              .toList() ??
          [],
      comments: json['comments'] as String?,
      countVisit: json['count_visit'] as int? ?? 0,
      countDownload: json['count_download'] as int? ?? 0,
      timestamp: json['timestamp'] as String? ?? '',
    );
  }
}
