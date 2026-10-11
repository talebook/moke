import type { ReaderSource } from './reader-source.ts';
import type { ReadingProgressPayload } from './reading-progress.ts';

export const READER_PROGRESS_TIMEOUT_MS = 8000;
export type ReaderProgressFailure = 'rejected' | 'timeout';

/** Bound best-effort work, abort its transport, and observe even a late rejection.
 * complete releases callers at the deadline; settled tracks a callback which
 * ignores cancellation so the same hung work is not started again on every wait.
 */
export function runReaderProgressBestEffort(
  run: (signal: AbortSignal) => Promise<void> | void,
  onFailure: (reason: ReaderProgressFailure) => void,
): { complete: Promise<void>; settled: Promise<void> } {
  const abort = new AbortController();
  let finished = false;
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => { complete = resolve; });
  const finish = (reason?: ReaderProgressFailure) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (reason) {
      try { onFailure(reason); } catch { /* Diagnostics are also best-effort. */ }
    }
    if (reason === 'timeout') abort.abort();
    complete();
  };
  const timer = setTimeout(() => finish('timeout'), READER_PROGRESS_TIMEOUT_MS);
  const settled = Promise.resolve().then(() => run(abort.signal)).then(
    () => { finish(); },
    () => { finish('rejected'); },
  );
  return { complete: completion, settled };
}

export function createReaderProgressQueue(
  save: (source: ReaderSource, progress: ReadingProgressPayload, signal: AbortSignal) => Promise<void> | void,
  delay = 1200,
  onSaveError?: (source: Readonly<ReaderSource>, reason: ReaderProgressFailure) => void,
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
    const attempt = runReaderProgressBestEffort(
      (signal) => save(item.source, item.progress, signal),
      (reason) => {
        // Expose only the immutable source, never raw transport errors that
        // may include credentials or response bodies. Diagnostics cannot gate
        // a session transition either.
        onSaveError?.(item.source, reason);
      },
    );
    const request = attempt.complete.then(() => { inFlight.delete(request); });
    inFlight.add(request);
  };
  return {
    schedule(source: ReaderSource, progress: ReadingProgressPayload) {
      const key = `${source.serverUrl}\n${source.sessionId}\n${source.bookId}`;
      pending.set(key, { source: Object.freeze({ ...source }), progress });
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
