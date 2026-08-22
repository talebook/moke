export interface BoundedRetryCacheOptions {
  /** Total attempts, including the initial load. */
  maxAttempts: number;
  retryDelayMs: number;
  sleep?: (delayMs: number) => Promise<void>;
}

/**
 * Cache the first successful load while retrying transient failures a bounded
 * number of times. Concurrent callers share one retry sequence, and an
 * exhausted cache never starts another sequence.
 */
export function createBoundedRetryCache<T>(
  load: () => Promise<T>,
  options: BoundedRetryCacheOptions,
): { get: () => Promise<T> } {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer');
  }

  const sleep = options.sleep
    ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const retryDelayMs = Math.max(0, options.retryDelayMs);
  let attempts = 0;
  let activePromise: Promise<T> | undefined;
  let cachedValue!: T;
  let hasCachedValue = false;
  let lastError: unknown;

  const run = async (): Promise<T> => {
    while (attempts < options.maxAttempts) {
      attempts += 1;
      try {
        cachedValue = await load();
        hasCachedValue = true;
        return cachedValue;
      } catch (error) {
        lastError = error;
        if (attempts >= options.maxAttempts) throw error;
        await sleep(retryDelayMs);
      }
    }

    throw lastError;
  };

  const get = (): Promise<T> => {
    if (hasCachedValue) return Promise.resolve(cachedValue);
    if (activePromise) return activePromise;
    if (attempts >= options.maxAttempts) return Promise.reject(lastError);

    const promise = run().finally(() => {
      if (activePromise === promise) activePromise = undefined;
    });
    activePromise = promise;
    return promise;
  };

  return { get };
}
