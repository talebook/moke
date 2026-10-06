'use client';

import { COMIC_OFFLINE_MESSAGE, resolveBookReader } from '@/lib/book-reader-policy';
import type { OfflineBookRecord } from '@/lib/offline-books';
import { isSampleBook } from '@/lib/sample-book-info';
import { getDebugPanelLaunchState } from '@/lib/store/developer';
import { useSettingsStore } from '@/lib/store/settings';
import { fetchReadingProgress } from '@/lib/reading-progress';
import {
  buildEmbeddedReaderUrl,
  getMokeRuntimePlatform,
  isSingleWebviewRuntime,
  openEmbeddedReaderBook,
} from '@/lib/moke-reader';

/** Return true when Reader takes over the current document. */
export async function openOfflineBook(
  record: OfflineBookRecord,
  navigate: (href: string) => void,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  if (signal?.aborted) return false;
  if (resolveBookReader({ media_type: record.media_type, files: [{ format: record.format }] }, useSettingsStore.getState().readerPreference) === 'comic') {
    throw new Error(COMIC_OFFLINE_MESSAGE);
  }
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri' || !record.filePath) {
    throw new Error('book.offline.desktop_only');
  }

  if (useSettingsStore.getState().readerPreference === 'system') {
    onProgress?.('正在打开系统阅读器…');
    await openBookWithSystemDefault(record.id, signal);
    return false;
  }

  // Progress recovery and the immutable runtime probe are independent. Offline
  // library opens intentionally do not write Talebook read history: there may
  // be no active authenticated server session, and the saved record can belong
  // to a server other than the currently connected one.
  const sampleBook = isSampleBook(record);
  onProgress?.('正在恢复阅读进度…');
  const [restoreProgress, platform] = await Promise.all([
    fetchReadingProgress(record.bookId, signal),
    getMokeRuntimePlatform(),
  ]);
  if (signal?.aborted) return false;
  onProgress?.('正在打开阅读器…');
  const common = {
    filePath: record.filePath,
    eink: useSettingsStore.getState().eink,
    debugPanel: getDebugPanelLaunchState(),
    mokeBookId: record.bookId,
    restoreProgress,
  };

  if (isSingleWebviewRuntime(platform)) {
    await openEmbeddedReaderBook(
      buildEmbeddedReaderUrl({ ...common, serverUrl: sampleBook ? '' : record.serverUrl }),
      navigate,
      platform,
      signal,
    );
    return !signal?.aborted;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  if (signal?.aborted) return false;
  await invoke('open_reader', common);
  return false;
}

export async function openBookWithSystemDefault(recordId: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
    throw new Error('book.offline.desktop_only');
  }

  const { invoke } = await import('@tauri-apps/api/core');
  if (signal?.aborted) return;
  await invoke('moke_open_downloaded_book', { id: recordId });
}
