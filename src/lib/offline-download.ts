'use client';

import { downloadBookBlob, streamBookDownload } from '@/lib/api';
import { beginOfflineDownload, endOfflineDownload } from '@/lib/offline-book-core';
import { saveOfflineBook, saveOfflineBookStream } from '@/lib/offline-books';

export { beginOfflineDownload, endOfflineDownload };

export interface DownloadOfflineBookOptions {
  serverUrl: string;
  bookId: string;
  title: string;
  format: string;
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
}

/** 统一离线下载入口：tauri 走磁盘流式写入（低内存峰值 + 原子索引），web 走 Blob 存 IndexedDB。 */
export async function downloadAndSaveOfflineBook(options: DownloadOfflineBookOptions): Promise<void> {
  if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
    await saveOfflineBookStream({
      serverUrl: options.serverUrl,
      bookId: options.bookId,
      title: options.title,
      fileName: `${options.title}.${options.format}`,
      mimeType: 'application/octet-stream',
      write: async (writer) => {
        const result = await streamBookDownload(options.bookId, options.format, {
          write: (chunk) => writer.write(chunk),
          onProgress: options.onProgress,
          signal: options.signal,
        });
        return result.mimeType;
      },
    });
    return;
  }

  const blob = await downloadBookBlob(options.bookId, options.format, {
    onProgress: options.onProgress,
    signal: options.signal,
  });
  await saveOfflineBook({
    serverUrl: options.serverUrl,
    bookId: options.bookId,
    title: options.title,
    fileName: `${options.title}.${options.format}`,
    mimeType: blob.type || 'application/octet-stream',
    blob,
  });
}
