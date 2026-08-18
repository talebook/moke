'use client';

import { useEffect, useRef } from 'react';
import { normalizeReaderProgressEvent, saveReadingProgress, type ReadingProgressPayload } from '@/lib/reading-progress';
import { shouldSuppressAnnotationReaderProgress } from '@/lib/annotations';
import { useServerStore } from '@/lib/store/server';

const SAVE_DELAY_MS = 1200;

export function ReaderProgressProvider({ children }: { children: React.ReactNode }) {
  const serverUrl = useServerStore((s) => s.serverUrl);
  const progressSupported = useServerStore((s) => s.capabilities.readingProgressApi);
  const capabilityChecked = useServerStore((s) => Boolean(s.capabilities.checkedAt));
  const pendingRef = useRef(new Map<string, ReadingProgressPayload>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return;
    if (!serverUrl) return;
    if (capabilityChecked && !progressSupported) return;

    let unlisten: (() => void) | undefined;

    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<Record<string, unknown>>('reader:page:changed', (event) => {
        const progress = normalizeReaderProgressEvent(event.payload);
        if (!progress) return;
        if (shouldSuppressAnnotationReaderProgress(serverUrl, progress)) return;

        const bookId = progress.moke_book_id;
        pendingRef.current.set(bookId, progress);

        const existingTimer = timersRef.current.get(bookId);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
          const latest = pendingRef.current.get(bookId);
          pendingRef.current.delete(bookId);
          timersRef.current.delete(bookId);
          if (latest) void saveReadingProgress(bookId, latest);
        }, SAVE_DELAY_MS);

        timersRef.current.set(bookId, timer);
      }))
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error) => {
        console.warn('[ReaderProgressProvider] could not listen for reader progress:', error);
      });

    return () => {
      unlisten?.();
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      for (const [bookId, progress] of pendingRef.current.entries()) {
        void saveReadingProgress(bookId, progress);
      }
      timersRef.current.clear();
      pendingRef.current.clear();
    };
  }, [capabilityChecked, progressSupported, serverUrl]);

  return <>{children}</>;
}
