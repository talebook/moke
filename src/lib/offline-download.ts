'use client';

import { downloadBookBlob, streamBookDownload } from '@/lib/api';
import { beginOfflineDownload, endOfflineDownload } from '@/lib/offline-book-core';
import { saveOfflineBook, saveOfflineBookStream } from '@/lib/offline-books';
import { useSettingsStore } from '@/lib/store/settings';

export { beginOfflineDownload, endOfflineDownload };

export interface DownloadOfflineBookOptions {
  serverUrl: string;
  bookId: string;
  title: string;
  format: string;
  onProgress?: (progress: number) => void;
  onTransfer?: (receivedBytes: number, totalBytes: number | null) => void;
  signal?: AbortSignal;
  resume?: boolean;
  preservePartialOnAbort?: boolean;
}

/** Unified entry: Tauri streams to a resumable file; web stores one Blob in IndexedDB. */
export async function downloadAndSaveOfflineBook(options: DownloadOfflineBookOptions): Promise<void> {
  const format = options.format.toLowerCase();
  if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
    const downloadDirectory = useSettingsStore.getState().downloadDirectory;
    await saveOfflineBookStream({
      serverUrl: options.serverUrl,
      bookId: options.bookId,
      title: options.title,
      format,
      fileName: `${options.title}.${format}`,
      mimeType: 'application/octet-stream',
      downloadDirectory,
      resume: options.resume,
      preservePartialOnAbort: options.preservePartialOnAbort,
      write: async (writer) => streamBookDownload(options.bookId, format, {
        write: (chunk) => writer.write(chunk),
        onProgress: options.onProgress,
        onTransfer: options.onTransfer,
        signal: options.signal,
        resumeFrom: writer.position,
        onRangeReset: () => writer.truncate(),
        validateEpub: false,
      }),
    });
    return;
  }

  const blob = await downloadBookBlob(options.bookId, format, {
    onProgress: options.onProgress,
    signal: options.signal,
  });
  options.onTransfer?.(blob.size, blob.size);
  await saveOfflineBook({
    serverUrl: options.serverUrl,
    bookId: options.bookId,
    title: options.title,
    format,
    fileName: `${options.title}.${format}`,
    mimeType: blob.type || 'application/octet-stream',
    blob,
  });
}
