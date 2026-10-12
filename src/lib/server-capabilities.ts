import {
  createUncheckedAnnotationCapability,
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

export interface ServerCapabilityDiscoveryDependencies {
  version: string;
  findSampleBookId: () => Promise<string | null>;
  probeJsonEndpoint: (path: string) => Promise<boolean>;
  now?: () => number;
}

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
 * Discover general server capabilities without probing annotation payloads.
 * The detail panel performs the first useful annotation request separately.
 */
export async function discoverGeneralServerCapabilities({
  version,
  findSampleBookId,
  probeJsonEndpoint,
  now = Date.now,
}: ServerCapabilityDiscoveryDependencies): Promise<ServerCapabilities> {
  const sampleBookId = await findSampleBookId();
  const [shelfApi, readingStatsApi, networkSourcesApi, readingStateApi, readingProgressApi] = await Promise.all([
    probeJsonEndpoint('/api/shelf'),
    probeJsonEndpoint('/api/reading/stats'),
    probeJsonEndpoint('/api/network/sources'),
    sampleBookId ? probeJsonEndpoint(`/api/book/${sampleBookId}/readstate`) : Promise.resolve(true),
    sampleBookId ? probeJsonEndpoint(`/api/book/${sampleBookId}/progress`) : Promise.resolve(true),
  ]);

  return {
    shelfApi,
    annotationApiStatus: 'unchecked',
    annotationApiCheckedAt: null,
    readingStateApi,
    readingProgressApi,
    readingStatsApi,
    networkSourcesApi,
    checkedAt: now(),
    version,
  };
}

/** Primitive inputs that are allowed to restart global capability discovery. */
export function getServerDiscoveryInputs(
  serverUrl: string,
  capabilities: Pick<ServerCapabilities, 'checkedAt'>,
): readonly [serverUrl: string, checkedAt: number | null] {
  return [serverUrl, capabilities.checkedAt];
}
