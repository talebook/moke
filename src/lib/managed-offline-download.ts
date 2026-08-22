'use client';

import { makeOfflineBookKey, shouldResumeOfflineDownload } from '@/lib/offline-book-core';
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
  const canResume = shouldResumeOfflineDownload(process.env.NEXT_PUBLIC_APP_PLATFORM);
  await startOfflineDownload({
    key,
    metadata: {
      ...input,
      format,
      downloadedBytes: canResume ? undefined : 0,
    },
    run: (onProgress, signal, onTransfer) => downloadAndSaveOfflineBook({
      ...input,
      format,
      onProgress,
      onTransfer,
      signal,
      resume: canResume,
      preservePartialOnFailure: true,
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
