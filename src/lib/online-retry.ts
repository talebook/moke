/** Bounded retries for an idempotent online read, including body consumption. */
export async function retryOnlineRead<T>(
  read: (signal: AbortSignal) => Promise<T>,
  retryable: (error: unknown) => boolean,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<T> {
  const aborted = () => new DOMException('Online read cancelled', 'AbortError');
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw aborted();
    const controller = new AbortController();
    let rejectAbort: (reason: unknown) => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const cancel = () => {
      rejectAbort(aborted());
      controller.abort();
    };
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      rejectAbort(new DOMException('Online read timed out', 'TimeoutError'));
      controller.abort();
    }, timeoutMs);
    try {
      return await Promise.race([read(controller.signal), stopped]);
    } catch (error) {
      if (signal.aborted) throw aborted();
      if (attempt >= 2 || !retryable(error)) throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
    }
    // A cancelled book must never start another attempt after the backoff.
    await new Promise<void>((resolve, reject) => {
      const cancelDelay = () => {
        clearTimeout(delay);
        signal.removeEventListener('abort', cancelDelay);
        reject(aborted());
      };
      const delay = setTimeout(
        () => {
          signal.removeEventListener('abort', cancelDelay);
          resolve();
        },
        250 * 2 ** attempt,
      );
      signal.addEventListener('abort', cancelDelay, { once: true });
      if (signal.aborted) cancelDelay();
    });
  }
}
