export type AnnotationCapabilityStatus =
  | 'unchecked'
  | 'supported'
  | 'unsupported'
  | 'transient-error';

export interface AnnotationCapabilitySnapshot {
  status: AnnotationCapabilityStatus;
  checkedAt: number | null;
}

export type InitialAnnotationLoadState = 'loading' | 'error' | 'unsupported';

/**
 * A transient failure is cached briefly so route changes do not create a
 * request loop. The panel always exposes an immediate manual retry.
 */
export const ANNOTATION_CAPABILITY_RETRY_TTL_MS = 5 * 60 * 1000;

/** One automatic annotation request per panel load; further attempts are user initiated. */
export const ANNOTATION_CAPABILITY_PROBE_MAX_REQUESTS = 1;

export function createUncheckedAnnotationCapability(): AnnotationCapabilitySnapshot {
  return { status: 'unchecked', checkedAt: null };
}

export function isAnnotationCapabilityStatus(value: unknown): value is AnnotationCapabilityStatus {
  return value === 'unchecked'
    || value === 'supported'
    || value === 'unsupported'
    || value === 'transient-error';
}

/**
 * Supported endpoints are loaded to display their data. Unchecked endpoints
 * are checked once. Transient failures may be retried automatically only after
 * the TTL (or immediately by the retry button), while confirmed incompatibility
 * is stable until an explicit retry or a server reconnect resets the store.
 */
export function shouldAutomaticallyLoadAnnotations(
  capability: AnnotationCapabilitySnapshot,
  now = Date.now(),
): boolean {
  if (capability.status === 'supported' || capability.status === 'unchecked') return true;
  if (capability.status === 'unsupported') return false;
  return capability.checkedAt == null
    || now - capability.checkedAt >= ANNOTATION_CAPABILITY_RETRY_TTL_MS;
}

/** Keep the first rendered state consistent with the automatic-load decision. */
export function getInitialAnnotationLoadState(
  capability: AnnotationCapabilitySnapshot,
  now = Date.now(),
): InitialAnnotationLoadState {
  if (shouldAutomaticallyLoadAnnotations(capability, now)) return 'loading';
  return capability.status === 'unsupported' ? 'unsupported' : 'error';
}
