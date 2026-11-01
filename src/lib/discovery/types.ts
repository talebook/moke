export interface DiscoverySource {
  fullname: string;
  interface: string;
  addresses: string[];
  name: string;
}

export interface DiscoveryCandidate {
  baseUrl: string;
  name: string;
  joinable: boolean;
  unavailableReason: string | null;
  sources: DiscoverySource[];
}

export interface DiscoveryRow {
  id: string;
  name: string;
  conflict: boolean;
  candidates: DiscoveryCandidate[];
}

export type NativeDiscoveryStatus = 'searching' | 'network_unavailable' | 'permission_denied' | 'error' | 'unsupported' | 'stopped';

export interface DiscoverySnapshot {
  sessionId?: string;
  status: NativeDiscoveryStatus;
  rows: DiscoveryRow[];
  error?: { code: string; message: string } | null;
}

export type DiscoveryStatus = Exclude<NativeDiscoveryStatus, 'stopped'> | 'empty' | 'paused';

export interface DiscoveryState {
  status: DiscoveryStatus;
  rows: DiscoveryRow[];
}
/** A selector is untrusted input. Only native session/cache admission can
 * authorize it, and only native compare-and-commit can perform its write. */
export interface DiscoverySelection {
  sessionId: string;
  generation: number;
  rowId: string;
  baseUrl: string;
}
export interface DiscoveryAdmission {
  admissionId: string;
  baseUrl: string;
  name: string;
}

/** Only these fixed commands cross IPC; no URL, service type or scan range is accepted. */
export interface DiscoveryAdapter {
  start(sessionId: string): Promise<unknown>;
  snapshot(sessionId: string): Promise<DiscoverySnapshot>;
  stop(sessionId: string): Promise<unknown>;
  admit?(selection: DiscoverySelection): Promise<DiscoveryAdmission>;
  commit?(sessionId: string, admissionId: string, expectedRaw: string | null, value: string): Promise<void>;
}
