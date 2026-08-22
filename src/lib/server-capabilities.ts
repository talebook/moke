import {
  createUncheckedAnnotationCapability,
  isAnnotationCapabilityStatus,
  type AnnotationCapabilityStatus,
} from './annotation-capability.ts';

export interface ServerCapabilities {
  shelfApi: boolean;
  annotationApiStatus: AnnotationCapabilityStatus;
  annotationApiCheckedAt: number | null;
  readingStateApi: boolean;
  readingProgressApi: boolean;
  readingStatsApi: boolean;
  networkSourcesApi: boolean;
  checkedAt: number | null;
  version: string;
}

export type PersistedServerCapabilities = Partial<ServerCapabilities> & {
  annotationApi?: unknown;
};

const uncheckedAnnotationCapability = createUncheckedAnnotationCapability();

export const DEFAULT_SERVER_CAPABILITIES: ServerCapabilities = {
  shelfApi: false,
  annotationApiStatus: uncheckedAnnotationCapability.status,
  annotationApiCheckedAt: uncheckedAnnotationCapability.checkedAt,
  readingStateApi: false,
  readingProgressApi: false,
  readingStatsApi: false,
  networkSourcesApi: false,
  checkedAt: null,
  version: '',
};

/**
 * Merge persisted capabilities while migrating the legacy annotationApi flag.
 * The removed key must not leak back into Zustand's next persisted snapshot.
 */
export function mergePersistedServerCapabilities(
  currentCapabilities: ServerCapabilities,
  persistedCapabilities: PersistedServerCapabilities | undefined,
): ServerCapabilities {
  const persistedStatus = persistedCapabilities?.annotationApiStatus;
  const legacyAnnotationApi = persistedCapabilities?.annotationApi;
  const capabilitiesWithoutLegacy = { ...(persistedCapabilities ?? {}) };
  delete capabilitiesWithoutLegacy.annotationApi;

  // A legacy `false` may have come from a network failure, so it must be
  // rechecked rather than migrated to a durable "unsupported" result.
  const annotationApiStatus = isAnnotationCapabilityStatus(persistedStatus)
    ? persistedStatus
    : legacyAnnotationApi === true
      ? 'supported'
      : 'unchecked';
  const persistedAnnotationCheckedAt = persistedCapabilities?.annotationApiCheckedAt;
  const persistedGeneralCheckedAt = persistedCapabilities?.checkedAt;
  const annotationApiCheckedAt = annotationApiStatus === 'unchecked'
    ? null
    : typeof persistedAnnotationCheckedAt === 'number'
      ? persistedAnnotationCheckedAt
      : typeof persistedGeneralCheckedAt === 'number'
        ? persistedGeneralCheckedAt
        : null;

  return {
    ...currentCapabilities,
    ...capabilitiesWithoutLegacy,
    annotationApiStatus,
    annotationApiCheckedAt,
  };
}

/** Primitive inputs that are allowed to restart global capability discovery. */
export function getServerDiscoveryInputs(
  serverUrl: string,
  capabilities: Pick<ServerCapabilities, 'checkedAt'>,
): readonly [serverUrl: string, checkedAt: number | null] {
  return [serverUrl, capabilities.checkedAt];
}
