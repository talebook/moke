'use client';

import { downloadBookBlob, request, streamBookDownload } from '@/lib/api';
import { beginOfflineDownload, endOfflineDownload } from '@/lib/offline-book-core';
import { saveOfflineBook, saveOfflineBookStream } from '@/lib/offline-books';
import { useSettingsStore } from '@/lib/store/settings';

export { beginOfflineDownload, endOfflineDownload };

export interface DownloadOfflineBookOptions {
  serverUrl: string;
  bookId: string;
  title: string;
  author?: string;
  coverUrl?: string;
  inShelf?: boolean;
  format: string;
  onProgress?: (progress: number) => void;
  onTransfer?: (receivedBytes: number, totalBytes: number | null) => void;
  signal?: AbortSignal;
  resume?: boolean;
  preservePartialOnFailure?: boolean;
}

async function fetchCoverDataUrl(coverUrl?: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!coverUrl) return undefined;
  try {
    const response = await request(coverUrl, { credentials: 'include', signal });
    if (!response.ok) return undefined;
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

/** Unified entry: Tauri streams to a resumable file; web stores one Blob in IndexedDB. */
export async function downloadAndSaveOfflineBook(options: DownloadOfflineBookOptions): Promise<void> {
  const format = options.format.toLowerCase();
  const coverDataUrl = await fetchCoverDataUrl(options.coverUrl, options.signal);
  if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
    const downloadDirectory = useSettingsStore.getState().downloadDirectory;
    await saveOfflineBookStream({
      serverUrl: options.serverUrl,
      bookId: options.bookId,
      title: options.title,
      author: options.author,
      inShelf: options.inShelf,
      coverDataUrl,
      format,
      fileName: `${options.title}.${format}`,
      mimeType: 'application/octet-stream',
      downloadDirectory,
      resume: options.resume,
      preservePartialOnFailure: options.preservePartialOnFailure,
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
    author: options.author,
    inShelf: options.inShelf,
    coverDataUrl,
    format,
    fileName: `${options.title}.${format}`,
    mimeType: blob.type || 'application/octet-stream',
    blob,
  });
}
