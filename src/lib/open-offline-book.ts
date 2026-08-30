'use client';

import type { OfflineBookRecord } from '@/lib/offline-books';
import { getDebugPanelLaunchState } from '@/lib/store/developer';
import { useSettingsStore } from '@/lib/store/settings';
import { fetchReadingProgress } from '@/lib/reading-progress';
import { prepareEmbeddedBookOpen } from '@/lib/book-read';
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
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri' || !record.filePath) {
    throw new Error('book.offline.desktop_only');
  }

  if (useSettingsStore.getState().readerPreference === 'system') {
    await openBookWithSystemDefault(record.id);
    return;
  }

  const prepared = await prepareEmbeddedBookOpen({
    loadRecord: async () => record,
    loadProgress: async () => {
      try {
        return await fetchReadingProgress(record.bookId);
      } catch {
        // Opening a local book must remain available while the server is offline.
        return null;
      }
    },
    loadPlatform: getMokeRuntimePlatform,
  });
  const common = {
    filePath: record.filePath,
    eink: useSettingsStore.getState().eink,
    debugPanel: getDebugPanelLaunchState(),
    mokeBookId: prepared.record.bookId,
    restoreProgress: prepared.restoreProgress,
  };

  const platform = prepared.platform;

  if (isSingleWebviewRuntime(platform)) {
    await openEmbeddedReaderBook(
      buildEmbeddedReaderUrl({ ...common, serverUrl: record.serverUrl }),
      navigate,
      platform,
    );
    return;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_reader', common);
}

export async function openBookWithSystemDefault(recordId: string): Promise<void> {
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
    throw new Error('book.offline.desktop_only');
  }

  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('moke_open_downloaded_book', { id: recordId });
}
