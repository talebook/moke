import { normalizeServerAddress } from './server-url.ts';
import type { SavedServer } from './server-registry.ts';
import { secureRandomUUID } from './random-id.ts';

const STORAGE_KEY = 'moke-reader-return-v1';
const MARKER_PREFIX = 'moke-reader-return:';
export const READER_RETURN_TTL_MS = 12 * 60 * 60 * 1000;

export interface ReaderReturnContext {
  activeServerId: string | null;
  serverUrl: string;
  offlineMode: boolean;
  intent?: 'offline-library';
}

function returnMarker(nonce: string, context: ReaderReturnContext, createdAt: number): string {
  // The live context also binds the source tuple. Editing a stored receipt to
  // another valid list entry cannot reuse the original browsing authority.
  return `${MARKER_PREFIX}${JSON.stringify([nonce, createdAt, context.activeServerId, context.serverUrl, context.offlineMode, context.intent ?? null])}`;
}

/** Both values belong to one live browsing context, not the saved server list.
 * window.name survives same-origin document replacement and resets with a new
 * WebView. The reader's existing contract only returns the literal /library.
 */
export interface ReaderReturnChannel {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  getMarker: () => string;
  setMarker: (value: string) => void;
  getArrival: () => { pathname: string; navigationType: string };
}

export function browserReaderReturnChannel(): ReaderReturnChannel {
  return {
    storage: window.sessionStorage,
    getMarker: () => window.name,
    setMarker: (value) => { window.name = value; },
    getArrival: () => ({ pathname: window.location.pathname,
      navigationType: (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type ?? 'navigate' }),
  };
}

export function clearReaderReturn(channel?: ReaderReturnChannel): void {
  try {
    // sessionStorage's getter itself may throw (e.g. ArkWeb permissions).
    if (!channel && typeof window !== 'undefined' && window.name.startsWith(MARKER_PREFIX)) window.name = '';
    const current = channel ?? browserReaderReturnChannel();
    // Clear the in-context authority first, including when storage is denied.
    if (current.getMarker().startsWith(MARKER_PREFIX)) current.setMarker('');
    current.storage.removeItem(STORAGE_KEY);
  } catch { /* An absent marker cannot authorize a return. */ }
}

export function prepareReaderReturn(
  context: ReaderReturnContext,
  channel?: ReaderReturnChannel,
  now = Date.now(),
): void {
  clearReaderReturn(channel);
  try {
    if ((!context.offlineMode && (!context.activeServerId || !context.serverUrl))
      || (context.activeServerId === null && context.serverUrl !== '')
      || (context.intent !== undefined && (context.intent !== 'offline-library'
        || !context.offlineMode || context.activeServerId !== null || context.serverUrl !== ''))
      || (context.serverUrl && normalizeServerAddress(context.serverUrl) !== context.serverUrl)) {
      throw new Error('reader.return.context');
    }
    const current = channel ?? browserReaderReturnChannel();
    const nonce = secureRandomUUID();
    const value = JSON.stringify({ version: 1, nonce, createdAt: now,
      activeServerId: context.activeServerId, serverUrl: context.serverUrl, offlineMode: context.offlineMode,
      ...(context.intent ? { intent: context.intent } : {}) });
    current.storage.setItem(STORAGE_KEY, value);
    if (current.storage.getItem(STORAGE_KEY) !== value) throw new Error('reader.return.storage');
    current.setMarker(returnMarker(nonce, context, now));
    if (current.getMarker() !== returnMarker(nonce, context, now)) throw new Error('reader.return.marker');
  } catch {
    clearReaderReturn(channel);
    throw new Error('无法保存阅读器返回信息，当前连接已保留。请重新确认连接，并检查本次会话的存储权限与安全随机数支持后重试。');
  }
}

/** A one-use offline intent survives document replacement without restoring an account. */
export function prepareOfflineLibraryEntry(channel?: ReaderReturnChannel, now = Date.now()): void {
  try {
    prepareReaderReturn({ activeServerId: null, serverUrl: '', offlineMode: true, intent: 'offline-library' }, channel, now);
  } catch {
    throw new Error('无法保存离线书库跳转信息，请检查本次会话的存储权限与安全随机数支持后重试。');
  }
}

/** Consume before any network await. Invalid, replayed, reload/back-history or
 * cold-start contexts do not activate a source or initiate server requests.
 */
export function takeReaderReturn(
  savedServers: SavedServer[],
  channel?: ReaderReturnChannel,
  now = Date.now(),
): ReaderReturnContext | null {
  try {
    const current = channel ?? browserReaderReturnChannel();
    const raw = current.storage.getItem(STORAGE_KEY);
    const marker = current.getMarker();
    const arrival = current.getArrival();
    clearReaderReturn(channel);
    if (!raw || arrival.pathname !== '/library' || arrival.navigationType !== 'navigate') return null;
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || typeof data.nonce !== 'string'
      || !/^[0-9a-f-]{36}$/.test(data.nonce) || marker !== returnMarker(data.nonce, data, data.createdAt)
      || !Number.isFinite(data.createdAt) || data.createdAt > now || now - data.createdAt >= READER_RETURN_TTL_MS
      || typeof data.offlineMode !== 'boolean' || typeof data.serverUrl !== 'string') return null;
    if (data.intent !== undefined && (data.intent !== 'offline-library'
      || !data.offlineMode || data.activeServerId !== null || data.serverUrl !== '')) return null;
    if (data.activeServerId === null) {
      return data.offlineMode && data.serverUrl === '' ? {
        activeServerId: null, serverUrl: '', offlineMode: true,
        ...(data.intent ? { intent: data.intent } : {}),
      } : null;
    }
    if (typeof data.activeServerId !== 'string' || normalizeServerAddress(data.serverUrl) !== data.serverUrl) return null;
    const server = savedServers.find((entry) => entry.id === data.activeServerId && entry.url === data.serverUrl);
    if (!server) return null;
    return { activeServerId: server.id, serverUrl: server.url, offlineMode: data.offlineMode };
  } catch {
    clearReaderReturn(channel);
    return null;
  }
}
