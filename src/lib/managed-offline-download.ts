'use client';

import { makeOfflineBookKey } from '@/lib/offline-book-core';
import { downloadAndSaveOfflineBook } from '@/lib/offline-download';
import { removeOfflinePartial } from '@/lib/offline-books';
import { getOfflineDownloadSnapshot, startOfflineDownload } from '@/lib/offline-download-manager';
import { useSettingsStore } from '@/lib/store/settings';

export async function startManagedOfflineBookDownload(input: {
  serverUrl: string;
  bookId: string;
  title: string;
  format: string;
}): Promise<void> {
  const format = input.format.toLowerCase();
  const key = makeOfflineBookKey(input.serverUrl, input.bookId, format);
  await startOfflineDownload({
    key,
    metadata: { ...input, format },
    run: (onProgress, signal, onTransfer) => downloadAndSaveOfflineBook({
      ...input,
      format,
      onProgress,
      onTransfer,
      signal,
      resume: true,
      preservePartialOnAbort: true,
    }),
    onCancel: () => removeOfflinePartial({
      ...input,
      format,
      downloadDirectory: useSettingsStore.getState().downloadDirectory,
    }),
  });
  const status = getOfflineDownloadSnapshot(key)?.status;
  if (status !== 'completed') throw new Error(`book.download.${status || 'interrupted'}`);
}
