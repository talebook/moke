export type SubscriptionCleanup = () => void;

function runCleanupSafely(cleanup: SubscriptionCleanup): void {
  try {
    cleanup();
  } catch {
    // Cancellation is terminal, so cleanup failures have no active subscriber to report to.
  }
}

/**
 * Starts an asynchronous subscription and returns a synchronous cancellation
 * function suitable for an effect cleanup. Cancellation is terminal: late
 * subscription errors and cleanup failures are ignored, while a subscription
 * that finishes successfully after cancellation is cleaned up as soon as its
 * promise continuation runs.
 */
export function startAsyncSubscription(
  subscribe: () => Promise<SubscriptionCleanup>,
  onError: (error: unknown) => void,
): SubscriptionCleanup {
  let cancelled = false;
  let cleanup: SubscriptionCleanup | undefined;

  try {
    void subscribe()
      .then((resolvedCleanup) => {
        if (cancelled) {
          runCleanupSafely(resolvedCleanup);
          return;
        }
        cleanup = resolvedCleanup;
      })
      .catch((error) => {
        if (!cancelled) onError(error);
      });
  } catch (error) {
    onError(error);
  }

  return () => {
    if (cancelled) return;
    cancelled = true;

    const resolvedCleanup = cleanup;
    cleanup = undefined;
    if (resolvedCleanup) runCleanupSafely(resolvedCleanup);
  };
}
