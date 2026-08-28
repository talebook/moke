import type { OfflineBookRecord } from './offline-books.ts';

export interface OfflineLibraryBook {
  id: string;
  title: string;
  author?: string;
  files: Array<{ format: string; size: number }>;
  timestamp: number;
}

export function buildOfflineLibrary(records: readonly OfflineBookRecord[]): OfflineLibraryBook[] {
  const books = new Map<string, OfflineLibraryBook>();
  for (const record of records) {
    const key = `${record.serverUrl}::${record.bookId}`;
    const existing = books.get(key);
    if (existing) {
      if (!existing.files.some((file) => file.format === record.format)) {
        existing.files.push({ format: record.format, size: record.size });
      }
      existing.timestamp = Math.max(existing.timestamp, Math.floor(record.updatedAt / 1000));
      continue;
    }
    books.set(key, {
      id: record.bookId,
      title: record.title,
      author: record.author,
      files: [{ format: record.format, size: record.size }],
      timestamp: Math.floor(record.updatedAt / 1000),
    });
  }
  return [...books.values()].sort((left, right) => right.timestamp - left.timestamp);
}
