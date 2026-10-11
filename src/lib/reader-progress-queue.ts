import type { ReaderSource } from './reader-source.ts';
import type { ReadingProgressPayload } from './reading-progress.ts';

export function createReaderProgressQueue(
  save: (source: ReaderSource, progress: ReadingProgressPayload) => Promise<void> | void,
  delay = 1200,
  onSaveError?: (source: Readonly<ReaderSource>) => void,
) {
  const pending = new Map<string, { source: ReaderSource; progress: ReadingProgressPayload }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<void>>();
  const send = (key: string) => {
    const item = pending.get(key);
    pending.delete(key);
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
    if (!item) return;
    // Defer the invocation as well as awaiting its result: save() can throw
    // synchronously. Best-effort failures must not reject a session flush.
    const request: Promise<void> = Promise.resolve()
      .then(() => save(item.source, item.progress))
      .catch(() => {
        // Expose only the immutable source, never raw transport errors that
        // may include credentials or response bodies. Diagnostics cannot gate
        // a session transition either.
        try { onSaveError?.(item.source); } catch { /* Best-effort diagnostics. */ }
      })
      .finally(() => { inFlight.delete(request); });
    inFlight.add(request);
  };
  return {
    schedule(source: ReaderSource, progress: ReadingProgressPayload) {
      const key = `${source.serverUrl}\n${source.sessionId}\n${source.bookId}`;
      pending.set(key, { source: { ...source }, progress });
      const timer = timers.get(key);
      if (timer) clearTimeout(timer);
      timers.set(key, setTimeout(() => send(key), delay));
    },
    async flush() {
      // Include events arriving while an earlier save is being drained.
      while (pending.size || inFlight.size) {
        for (const key of pending.keys()) send(key);
        await Promise.all(inFlight);
      }
    },
  };
}
