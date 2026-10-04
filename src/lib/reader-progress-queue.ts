import type { ReaderSource } from './reader-source.ts';
import type { ReadingProgressPayload } from './reading-progress.ts';

export function createReaderProgressQueue(
  save: (source: ReaderSource, progress: ReadingProgressPayload) => Promise<void>,
  delay = 1200,
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
    const request = save(item.source, item.progress);
    inFlight.add(request);
    void request.finally(() => inFlight.delete(request)).catch(() => undefined);
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
      for (const key of pending.keys()) send(key);
      await Promise.all(inFlight);
    },
  };
}
