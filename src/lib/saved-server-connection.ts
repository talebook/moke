'use client';

import { createStore } from 'zustand/vanilla';
import { loadSavedServers, type SavedServerView } from './saved-server-api.ts';
import { createServerConnectionController, type ConnectionEntry, type ServerConnectionState } from './server-connection-controller.ts';
import { useServerStore } from './store/server.ts';
import { hasInFlightOfflineDownloads } from './offline-book-core.ts';
import { listOfflineDownloadSnapshots } from './offline-download-manager.ts';
import { clearReadStateCache } from './reading-state.ts';
import { probeSavedServer } from './connection-probe.ts';
import { hasLegacyReaderAttempt } from './reader-source-guard.ts';

export const connectionState = createStore<{ state: ServerConnectionState | null }>(() => ({ state: null }));

async function readEntry(id: string): Promise<SavedServerView | null> {
  const loaded = await loadSavedServers();
  if (!loaded.ok) throw new Error('saved-list-unavailable');
  return loaded.savedServers.find((entry) => entry.id === id) ?? null;
}

export async function canConnectSavedServer(entry: ConnectionEntry): Promise<boolean> {
  // Window enumeration cannot rule out an earlier IPC dispatch which creates
  // its Reader late (including across a host reload). Native connection needs
  // the authoritative host/Reader lease, not an assumed empty enumeration.
  if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri' || hasLegacyReaderAttempt()) return false;
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

export const savedServerConnection = createServerConnectionController({
  readEntry,
  getSessionRevision: () => useServerStore.getState().sessionRevision,
  canConnect: canConnectSavedServer,
  async probe(entry, signal) {
    const { request } = await import('./api.ts');
    return probeSavedServer((url, init) => request(url, init, { requireValidTls: true }), entry.url, signal);
  },
  activate(entry, expectedRevision) {
    const activated = useServerStore.getState().activateSavedServer(entry, expectedRevision);
    if (activated) clearReadStateCache();
    return activated;
  },
  onState: (state) => connectionState.setState({ state }),
});

/** Access code belongs to the exact failed candidate, never to the live store. */
export async function submitSavedServerAccess(code: string, captchaData: unknown, signal: AbortSignal) {
  const candidate = savedServerConnection.getState();
  if (candidate.code !== 'access-required' || !candidate.entryId) throw new Error('candidate-unavailable');
  const revision = useServerStore.getState().sessionRevision;
  if (candidate.sessionRevision !== revision) throw new Error('candidate-changed');
  const entry = await readEntry(candidate.entryId);
  if (!entry || entry.status !== 'ready' || entry.url !== candidate.url || entry.entryRevision !== candidate.entryRevision || !await canConnectSavedServer(entry)) throw new Error('candidate-changed');
  const stillCurrent = () => !signal.aborted && savedServerConnection.getState().attempt === candidate.attempt
    && useServerStore.getState().sessionRevision === revision;
  if (!stillCurrent()) throw new Error('candidate-changed');
  const { request, readJsonResponse } = await import('./api.ts');
  if (!stillCurrent()) throw new Error('candidate-changed');
  const body = new URLSearchParams({ invite_code: code });
  if (typeof captchaData === 'string') body.set('captcha_code', captchaData);
  else if (captchaData && typeof captchaData === 'object') {
    for (const [key, value] of Object.entries(captchaData)) body.set(key, String(value));
  }
  body.set('invite_code', code);
  const response = await request(`${entry.url}/api/welcome`, {
    method: 'POST', credentials: 'include', redirect: 'error', signal,
    body,
    ...{ maxRedirections: 0 },
  }, { requireValidTls: true });
  const result = await readJsonResponse<{ err: string; msg?: string }>(response);
  if (!stillCurrent()) throw new Error('candidate-changed');
  if (!response.ok || result.err !== 'ok') return result;
  const latest = await readEntry(entry.id);
  if (!stillCurrent() || !latest || latest.status !== 'ready' || latest.entryRevision !== entry.entryRevision || latest.url !== entry.url) throw new Error('candidate-changed');
  const pending = savedServerConnection.connect(latest);
  const retryAttempt = savedServerConnection.getState().attempt;
  const cancel = () => savedServerConnection.cancel(retryAttempt);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try { return { err: 'ok', connection: await pending }; }
  finally { signal.removeEventListener('abort', cancel); }
}
