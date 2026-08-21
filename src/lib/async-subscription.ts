export type SubscriptionCleanup = () => void;

/**
 * Starts an asynchronous subscription and returns a synchronous cancellation
 * function suitable for an effect cleanup. A subscription that finishes after
 * cancellation is cleaned up immediately.
 */
export function startAsyncSubscription(
  subscribe: () => Promise<SubscriptionCleanup>,
  onError: (error: unknown) => void,
): SubscriptionCleanup {
  let cancelled = false;
  let cleanup: SubscriptionCleanup | undefined;

  void subscribe()
    .then((resolvedCleanup) => {
      if (cancelled) {
        resolvedCleanup();
        return;
      }
      cleanup = resolvedCleanup;
    })
    .catch(onError);

  return () => {
    cancelled = true;
    cleanup?.();
    cleanup = undefined;
  };
}
