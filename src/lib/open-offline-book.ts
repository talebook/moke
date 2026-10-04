'use client';

import { COMIC_OFFLINE_MESSAGE, resolveBookReader } from '@/lib/book-reader-policy';
import { assertReaderContext, openReaderFromSource, requireClosedReaders } from '@/lib/reader-source';
import { useServerStore } from '@/lib/store/server';
import type { OfflineBookRecord } from '@/lib/offline-books';
import { getDebugPanelLaunchState } from '@/lib/store/developer';
import { useSettingsStore } from '@/lib/store/settings';
import { fetchReadingProgress } from '@/lib/reading-progress';
import {
  buildEmbeddedReaderUrl,
  getMokeRuntimePlatform,
  isSingleWebviewRuntime,
  openEmbeddedReaderBook,
} from '@/lib/moke-reader';

export async function openOfflineBook(
  record: OfflineBookRecord,
  navigate: (href: string) => void,
): Promise<void> {
  if (resolveBookReader({ media_type: record.media_type, files: [{ format: record.format }] }, useSettingsStore.getState().readerPreference) === 'comic') {
    throw new Error(COMIC_OFFLINE_MESSAGE);
  }
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri' || !record.filePath) {
    throw new Error('book.offline.desktop_only');
  }
  const source = { serverUrl: record.serverUrl, bookId: record.bookId, sessionId: useServerStore.getState().sessionId };

  if (useSettingsStore.getState().readerPreference === 'system') {
    await openBookWithSystemDefault(record.id);
    return;
  }

  // Progress recovery and the immutable runtime probe are independent. Offline
  // library opens intentionally do not write Talebook read history: there may
  // be no active authenticated server session, and the saved record can belong
  // to a server other than the currently connected one.
  const [restoreProgress, platform] = await Promise.all([
    fetchReadingProgress(record.bookId, undefined, record.serverUrl),
    getMokeRuntimePlatform(),
  ]);
  const common = {
    filePath: record.filePath,
    eink: useSettingsStore.getState().eink,
    debugPanel: getDebugPanelLaunchState(),
    mokeBookId: record.bookId,
    restoreProgress,
  };
  assertReaderContext(source, useServerStore.getState());

  if (isSingleWebviewRuntime(platform)) {
    await openEmbeddedReaderBook(
      buildEmbeddedReaderUrl({ ...common, serverUrl: record.serverUrl }),
      navigate,
      platform,
      source,
    );
    return;
  }

  await requireClosedReaders();
  await openReaderFromSource(source, common);
}

export async function openBookWithSystemDefault(recordId: string): Promise<void> {
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
    throw new Error('book.offline.desktop_only');
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('moke_open_downloaded_book', { id: recordId });
}
