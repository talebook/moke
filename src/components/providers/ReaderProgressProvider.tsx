'use client';

import { useEffect } from 'react';
import { normalizeReaderProgressEvent, saveReadingProgress } from '@/lib/reading-progress';
import { clearAnnotationLocateProgressSuppressionFromPayload, shouldSuppressAnnotationReaderProgress } from '@/lib/annotations';
import { startAsyncSubscription } from '@/lib/async-subscription';
import { sourceForReaderEvent, retireReaderWindow, registerReaderProgressFlush, type ReaderSource } from '@/lib/reader-source';
import { createReaderProgressQueue, type ReaderProgressFailure } from '@/lib/reader-progress-queue';
import { debugLog } from '@/lib/debug-log';
import { rememberContinueReading } from '@/lib/continue-reading';
import { useServerStore } from '@/lib/store/server';

export function ReaderProgressProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return;
    let disposed = false;
    const reportProgressFailure = (source?: Readonly<ReaderSource>, reason?: ReaderProgressFailure) => {
      try {
        debugLog('warn', 'reader-progress', '阅读进度同步失败，已继续处理连接与阅读器操作',
          { reason: reason ?? 'rejected', ...(source ? { serverUrl: source.serverUrl, bookId: source.bookId, sessionId: source.sessionId } : {}) });
      } catch { /* Diagnostics must not prevent cleanup or session changes. */ }
    };
    const queue = createReaderProgressQueue((source, progress, signal) =>
      saveReadingProgress(source.bookId, progress, source.serverUrl, signal), 1200, reportProgressFailure);
    const flush = () => queue.flush().catch(() => reportProgressFailure());
    const unregisterFlush = registerReaderProgressFlush(flush);
    const cancel = startAsyncSubscription(async () => {
      const { listen } = await import('@tauri-apps/api/event');
      return listen<{ window: string; event: string; data: Record<string, unknown> }>('moke:reader:event', (event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.event === 'annotation-locate:finished') {
          clearAnnotationLocateProgressSuppressionFromPayload(payload.data);
          return;
        }
        if (payload.event === 'book:closed') { retireReaderWindow(payload.window); void flush(); return; }
        if (payload.event !== 'page:changed') return;
        const progress = normalizeReaderProgressEvent(payload.data);
        if (!progress) return;
        const source = sourceForReaderEvent(payload.window, progress.moke_book_id);
        // Unknown windows have no authenticated origin. Never guess from the active server.
        if (!source) {
          debugLog('warn', 'reader-progress', '无法确认阅读器来源，未同步进度',
            { window: payload.window, bookId: progress.moke_book_id });
          return;
        }
        if (shouldSuppressAnnotationReaderProgress(source.serverUrl, progress)) return;
        const current = useServerStore.getState();
        if (current.sessionId === source.sessionId) {
          rememberContinueReading({
            serverUrl: source.serverUrl,
            mode: current.offlineMode ? 'offline' : 'online',
            bookId: source.bookId,
            progress: progress.progress ?? progress.fraction,
            page: progress.page,
            totalPages: progress.total_pages,
          });
        }
        queue.schedule(source, progress);
      });
    }, (error) => console.warn('[ReaderProgressProvider] could not listen:', error));
    return () => {
      disposed = true;
      cancel();
      void flush().finally(unregisterFlush).catch(() => reportProgressFailure());
    };
  }, []);
  return <>{children}</>;
}
