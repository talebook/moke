import type { OfflineBookRecord } from './offline-books.ts';
import type { OfflineDownloadSnapshot } from './offline-download-manager.ts';

export interface OfflineDownloadItem extends OfflineDownloadSnapshot {
  key: string;
  record?: OfflineBookRecord;
  stale?: boolean;
}

export function mergeOfflineDownloadItems(
  records: OfflineBookRecord[],
  tasks: OfflineDownloadSnapshot[],
  staleKeys: ReadonlySet<string>,
): OfflineDownloadItem[] {
  const merged = new Map<string, OfflineDownloadItem>();
  for (const task of tasks) {
    if (!task.key) continue;
    merged.set(task.key, { ...task, key: task.key });
  }

  for (const record of records) {
    const task = merged.get(record.id);
    const stale = staleKeys.has(record.id);
    if (task && task.status !== 'completed') {
      merged.set(record.id, { ...task, record, stale });
      continue;
    }

    merged.set(record.id, {
      key: record.id,
      serverUrl: record.serverUrl,
      bookId: record.bookId,
      title: record.title,
      format: record.format,
      status: 'completed',
      progress: 100,
      downloadedBytes: record.size,
      totalBytes: record.size,
      updatedAt: record.updatedAt,
      record,
      stale,
    });
  }

  return Array.from(merged.values()).sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

export function calculateOfflineDownloadUsedBytes(items: OfflineDownloadItem[]): number {
  return items.reduce((sum, item) => {
    const bytes = item.status === 'completed'
      ? item.record?.size ?? item.downloadedBytes ?? 0
      : item.downloadedBytes ?? 0;
    return sum + Math.max(0, bytes);
  }, 0);
}
