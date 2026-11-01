'use client';

import { createStore } from 'zustand/vanilla';
import { loadSavedServers, type SavedServerView } from './saved-server-api.ts';
import { createServerConnectionController, type ConnectionEntry, type ServerConnectionState, type ConnectionAttemptContext } from './server-connection-controller.ts';
import { useServerStore, captureServerProjection, restoreServerProjection } from './store/server.ts';
import { hasInFlightOfflineDownloads } from './offline-book-core.ts';
import { listOfflineDownloadSnapshots } from './offline-download-manager.ts';
import { clearReadStateCache } from './reading-state.ts';
import { probeSavedServer } from './connection-probe.ts';
import { hasLegacyReaderAttempt } from './reader-source-guard.ts';
import { nativeConnection, isNativeConnectionRuntime, NativeConnectionError } from './native-connection.ts';

export const connectionState = createStore<{ state: ServerConnectionState | null }>(() => ({ state: null }));

async function readEntry(id: string): Promise<SavedServerView | null> {
  const loaded = await loadSavedServers();
  if (!loaded.ok) throw new Error('saved-list-unavailable');
  return loaded.savedServers.find((entry) => entry.id === id) ?? null;
}

function isSourceAvailable(entry: ConnectionEntry): boolean {
  // Window enumeration cannot rule out an earlier IPC dispatch which creates
  // its Reader late (including across a host reload). Native connection needs
  // the authoritative host/Reader lease, not an assumed empty enumeration.
  if (hasLegacyReaderAttempt()) return false;
  if (hasInFlightOfflineDownloads() || listOfflineDownloadSnapshots().some((task) => task.status === 'downloading')) return false;
  const current = useServerStore.getState();
  // Cookie jars do not partition by port or library prefix. Do not introduce
  // an unverified same-host cross-library authentication path in this stage.
  if (current.serverUrl && current.serverUrl !== entry.url) {
    try { if (new URL(current.serverUrl).hostname === new URL(entry.url).hostname) return false; }
    catch { /* Invalid legacy text is archival data, never a network authority. */ }
  }
  return true;
}
export async function canConnectSavedServer(entry: ConnectionEntry, context?: ConnectionAttemptContext): Promise<boolean> {
  if (!isSourceAvailable(entry)) return false;
  if (!isNativeConnectionRuntime()) return true;
  if (!context) return false;
  return nativeConnection.check(entry, context);
}

const projections = new Map<number, { previous: ReturnType<typeof captureServerProjection>; projectedRevision?: number }>();
function blockUncertainNative(): void {
  nativeConnection.markUncertain();
  for (const projection of projections.values()) {
    if (projection.projectedRevision !== undefined) restoreServerProjection(projection.previous, projection.projectedRevision);
  }
  projections.clear();
}

export const savedServerConnection = createServerConnectionController({
  readEntry,
  getSessionRevision: () => useServerStore.getState().sessionRevision,
  canConnect: canConnectSavedServer,
  async probe(entry, signal, context) {
    const { request } = await import('./api.ts');
    const nativeLease = isNativeConnectionRuntime() ? nativeConnection.candidateLease(context.attempt, entry) : undefined;
    return probeSavedServer((url, init) => request(url, init, { requireValidTls: true, nativeLease }), entry.url, signal);
  },
  activate(entry, expectedRevision) {
    // No await between this last occupancy check and the store mutation.
    if (!isSourceAvailable(entry)) return false;
    const activated = useServerStore.getState().activateSavedServer(entry, expectedRevision);
    if (activated && isNativeConnectionRuntime()) {
      const projection = projections.get(savedServerConnection.getState().attempt);
      if (projection) projection.projectedRevision = useServerStore.getState().sessionRevision;
    }
    if (activated) clearReadStateCache();
    return activated;
  },
  ...(isNativeConnectionRuntime() ? {
    async prepareActivation(entry: ConnectionEntry, context: ConnectionAttemptContext) {
      projections.set(context.attempt, { previous: captureServerProjection() });
      return nativeConnection.prepare(entry, context);
    },
    async acknowledgeActivation(entry: ConnectionEntry, context: ConnectionAttemptContext, prepared: unknown) {
      await nativeConnection.acknowledge(entry, context, prepared);
      projections.delete(context.attempt);
    },
    async cleanup(_entry: ConnectionEntry, context: ConnectionAttemptContext, reason: string) {
      if (reason === 'access-required') return;
      await nativeConnection.cancel(context.attempt);
      projections.delete(context.attempt);
    },
    onActivationUncertain: blockUncertainNative,
  } : {}),
  onState: (state) => connectionState.setState({ state }),
});

/** Access code belongs to the exact failed candidate, never to the live store. */
const accessSubmissions = new Set<number>();
function assertNoAccessSubmission(attempt: number): void {
  if (accessSubmissions.has(attempt)) throw new NativeConnectionError('operation_busy');
}
export async function submitSavedServerAccess(code: string, captchaData: unknown, signal: AbortSignal) {
  const attempt = savedServerConnection.getState().attempt;
  assertNoAccessSubmission(attempt);
  accessSubmissions.add(attempt);
  try { return await performSavedServerAccess(code, captchaData, signal); }
  finally { accessSubmissions.delete(attempt); }
}
async function performSavedServerAccess(code: string, captchaData: unknown, signal: AbortSignal) {
  const candidate = savedServerConnection.getState();
  if (candidate.code !== 'access-required' || !candidate.entryId) throw new Error('candidate-unavailable');
  const revision = useServerStore.getState().sessionRevision;
  if (candidate.sessionRevision !== revision) throw new Error('candidate-changed');
  const entry = await readEntry(candidate.entryId);
  if (!entry || entry.status !== 'ready' || entry.url !== candidate.url || entry.entryRevision !== candidate.entryRevision || !isSourceAvailable(entry)) throw new Error('candidate-changed');
  const stillCurrent = () => !signal.aborted && savedServerConnection.getState().attempt === candidate.attempt
    && useServerStore.getState().sessionRevision === revision;
  if (!stillCurrent()) throw new Error('candidate-changed');
  const { request, readJsonResponse } = await import('./api.ts');
  if (!stillCurrent()) throw new Error('candidate-changed');
  // Typing a code may outlive the host's 15s attempt deadline. A new explicit
  // submission rechecks the exact saved entry under a fresh native attempt.
  const nativeLease = isNativeConnectionRuntime() ? await nativeConnection.renewCandidate(candidate.attempt, entry) : undefined;
  if (!stillCurrent()) throw new Error('candidate-changed');
  const body = new URLSearchParams({ invite_code: code });
  if (typeof captchaData === 'string') body.set('captcha_code', captchaData);
  else if (captchaData && typeof captchaData === 'object') {
    // The entered code wins even if a captcha provider returns the same key.
    for (const [key, value] of Object.entries(captchaData)) {
      if (key !== 'invite_code') body.set(key, String(value));
    }
  }
  const response = await request(`${entry.url}/api/welcome`, {
    method: 'POST', credentials: 'include', redirect: 'error', signal,
    body,
    ...{ maxRedirections: 0 },
  }, { requireValidTls: true, nativeLease });
  const result = await readJsonResponse<{ err?: unknown; msg?: unknown }>(response);
  if (!stillCurrent()) throw new Error('candidate-changed');
  const err = typeof result?.err === 'string' ? result.err : '';
  const msg = typeof result?.msg === 'string' ? result.msg : undefined;
  if (!response.ok) return { err: err && err !== 'ok' ? err : `http.${response.status}`, msg };
  if (err !== 'ok') return { err: err || 'server.invalid_response', msg };
  const latest = await readEntry(entry.id);
  if (!stillCurrent() || !latest || latest.status !== 'ready' || latest.entryRevision !== entry.entryRevision || latest.url !== entry.url) throw new Error('candidate-changed');
  if (isNativeConnectionRuntime()) await nativeConnection.cancel(candidate.attempt);
  if (!stillCurrent()) throw new Error('candidate-changed');
  const pending = savedServerConnection.connect(latest);
  const retryAttempt = savedServerConnection.getState().attempt;
  const cancel = () => savedServerConnection.cancel(retryAttempt);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try { return { err: 'ok', connection: await pending }; }
  finally { signal.removeEventListener('abort', cancel); }
}

/** Captcha belongs to the pending saved candidate, not the still-active A.
 * Every refresh is a new explicit check of the same ready local entry. */
export async function requestSavedServerCaptcha(url: string, init: RequestInit = {}): Promise<Response> {
  const candidate = savedServerConnection.getState();
  // A refresh may supersede a captcha GET, but may never retire the permit of
  // an already dispatched access-code mutation in order to obtain a new one.
  assertNoAccessSubmission(candidate.attempt);
  if (candidate.code !== 'access-required' || !candidate.entryId || init.signal?.aborted) throw new Error('candidate-unavailable');
  const revision = useServerStore.getState().sessionRevision;
  if (revision !== candidate.sessionRevision) throw new Error('candidate-changed');
  const entry = await readEntry(candidate.entryId);
  assertNoAccessSubmission(candidate.attempt);
  const current = () => !init.signal?.aborted && useServerStore.getState().sessionRevision === revision
    && savedServerConnection.getState().attempt === candidate.attempt && savedServerConnection.getState().code === 'access-required';
  if (!current() || !entry || entry.status !== 'ready' || entry.url !== candidate.url || entry.entryRevision !== candidate.entryRevision
      || !isSourceAvailable(entry) || !url.startsWith(`${entry.url}/api/captcha/`) || (init.method ?? 'GET').toUpperCase() !== 'GET') {
    throw new Error('candidate-changed');
  }
  const nativeLease = isNativeConnectionRuntime() ? await nativeConnection.renewCandidate(candidate.attempt, entry) : undefined;
  assertNoAccessSubmission(candidate.attempt);
  if (!current()) throw new Error('candidate-changed');
  const { request } = await import('./api.ts');
  assertNoAccessSubmission(candidate.attempt);
  if (!current()) throw new Error('candidate-changed');
  return request(url, { ...init, credentials: 'include', redirect: 'error' }, { requireValidTls: true, nativeLease });
}
