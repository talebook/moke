'use client';

import { useEffect } from 'react';
import { normalizeReaderProgressEvent, saveReadingProgress } from '@/lib/reading-progress';
import { clearAnnotationLocateProgressSuppressionFromPayload, shouldSuppressAnnotationReaderProgress } from '@/lib/annotations';
import { startAsyncSubscription } from '@/lib/async-subscription';
import { sourceForReaderEvent, registerReaderProgressFlush } from '@/lib/reader-source';
import { createReaderProgressQueue } from '@/lib/reader-progress-queue';

export function ReaderProgressProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return;
    let disposed = false;
    const queue = createReaderProgressQueue((source, progress) =>
      saveReadingProgress(source.bookId, progress, source.serverUrl));
    const unregisterFlush = registerReaderProgressFlush(() => queue.flush());
    const cancel = startAsyncSubscription(async () => {
      const { listen } = await import('@tauri-apps/api/event');
      return listen<{ window: string; event: string; data: Record<string, unknown> }>('moke:reader:event', (event) => {
        if (disposed) return;
        const payload = event.payload;
        if (payload.event === 'annotation-locate:finished') {
          clearAnnotationLocateProgressSuppressionFromPayload(payload.data);
          return;
        }
        if (payload.event === 'book:closed') { void queue.flush(); return; }
        if (payload.event !== 'page:changed') return;
        const progress = normalizeReaderProgressEvent(payload.data);
        if (!progress) return;
        const source = sourceForReaderEvent(payload.window, progress.moke_book_id);
        // Unknown windows have no authenticated origin. Never guess from the active server.
        if (!source || shouldSuppressAnnotationReaderProgress(source.serverUrl, progress)) return;
        queue.schedule(source, progress);
      });
    }, (error) => console.warn('[ReaderProgressProvider] could not listen:', error));
    return () => {
      disposed = true;
      cancel();
      void queue.flush().finally(unregisterFlush);
    };
  }, []);
  return <>{children}</>;
}
