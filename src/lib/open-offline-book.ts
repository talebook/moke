'use client';

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
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri' || !record.filePath) {
    throw new Error('book.offline.desktop_only');
  }

  let restoreProgress = null;
  try {
    restoreProgress = await fetchReadingProgress(record.bookId);
  } catch {
    // Opening a local book must remain available while the server is offline.
  }

  const platform = await getMokeRuntimePlatform();
  const common = {
    filePath: record.filePath,
    eink: useSettingsStore.getState().eink,
    debugPanel: getDebugPanelLaunchState(),
    mokeBookId: record.bookId,
    restoreProgress,
  };

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
