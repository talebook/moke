import { create } from 'zustand';
import { didServerSessionChange, invalidateServerCapabilities, type ReaderInfo } from '../server-session.ts';
import { DEFAULT_SERVER_CAPABILITIES, type ServerCapabilities } from '../server-capabilities.ts';
import { clearReadStateCache } from '../reading-state.ts';
import { normalizeServerAddress } from '../server-url.ts';
import { emptyRegistry, type SavedServer, type ServerRegistryRepository, type StorageResult } from '../server-registry.ts';
import { createServerRepository, writeActiveServerMirror } from '../server-storage.ts';
import { requireClosedReaders, withClosedReaderSession } from '../reader-source.ts';
import { clearReaderReturn, takeReaderReturn, type ReaderReturnChannel } from '../reader-return.ts';
import { checkSavedServer } from '../server-connection.ts';

export type { ReaderInfo } from '../server-session.ts';
export { DEFAULT_SERVER_CAPABILITIES } from '../server-capabilities.ts';
export type { ServerCapabilities } from '../server-capabilities.ts';

function invalidateCapabilitiesForSession(capabilities: ServerCapabilities): ServerCapabilities {
  return { ...invalidateServerCapabilities(capabilities), annotationApiStatus: 'unchecked', annotationApiCheckedAt: null };
}

interface Candidate { id: string; url: string; requestId: number; needsAccessCode: boolean }
interface ServerState {
  savedServers: SavedServer[];
  lastUsedServerId: string | null;
  storageError: string;
  storageBusy: boolean;
  saving: boolean;
  activeServerId: string | null;
  candidate: Candidate | null;
  connectionId: number;
  sessionId: number;
  offlineMode: boolean;
  serverUrl: string;
  serverTitle: string;
  capabilities: ServerCapabilities;
  protocol: 'http' | 'https';
  host: string;
  port: string;
  hasHydrated: boolean;
  readerReturnTo: '/shelf' | null;
  readerReturnError: string;
  isConnected: boolean;
  token: string;
  user: ReaderInfo | null;
  loadServers: () => Promise<void>;
  recoverServers: () => Promise<void>;
  saveServer: (value: string) => Promise<StorageResult<SavedServer>>;
  beginConnection: (id: string) => Candidate | null;
  cancelConnection: (requestId?: number) => void;
  requireAccess: (requestId: number) => void;
  activateCandidate: (requestId: number) => Promise<boolean>;
  setServer: (protocol: 'http' | 'https', host: string, port: string) => void;
  enterOfflineMode: () => Promise<void>;
  leaveOfflineMode: () => void;
  setConnected: (token: string, user: ReaderInfo) => void;
  setUser: (user: ReaderInfo | null) => void;
  setServerTitle: (title: string) => void;
  setServerCapabilities: (capabilities: ServerCapabilities) => void;
  setHasHydrated: (hydrated: boolean) => void;
  logout: () => void;
  disconnect: () => void;
}
const disconnected = {
  serverUrl: '', serverTitle: '', activeServerId: null, capabilities: DEFAULT_SERVER_CAPABILITIES,
  protocol: 'http' as const, host: '', port: '', isConnected: false, token: '', user: null,
};

export function createServerStore(repository: ServerRegistryRepository = createServerRepository(), returnChannel?: ReaderReturnChannel) {
  let loading: Promise<void> | null = null;
  let requestNumber = 0;
  return create<ServerState>()((set, get) => ({
    ...emptyRegistry(), ...disconnected, candidate: null, connectionId: 0, sessionId: 0,
    hasHydrated: false, readerReturnTo: null, readerReturnError: '', storageError: '', storageBusy: false, saving: false,
    loadServers: async () => {
      if (loading || get().saving) return loading ?? undefined;
      set({ hasHydrated: false, storageError: '', storageBusy: true });
      // ArkWeb/native IPC must not strand the entire UI on a hydration spinner.
      // Keep recovery locked until this operation settles so a late file write
      // cannot race a new recovery or save.
      const timer = setTimeout(() => set({ hasHydrated: true,
        storageError: '服务器存储操作超时，原数据保留。请等待操作结束后重试，或重启应用。' }), 8000);
      loading = (async () => {
        const result = await repository.load();
        if (!result.ok) { clearReaderReturn(returnChannel); set({ storageError: result.error, hasHydrated: true }); return; }
        clearTimeout(timer);
        set({ ...result.value, hasHydrated: false, storageError: '' });
        // A cold launch only loads the list. A live Reader return consumes its
        // one-use browsing-context receipt before confirming the connection.
        let context = null;
        try { context = takeReaderReturn(result.value.savedServers, returnChannel); } catch { clearReaderReturn(returnChannel); }
        const previous = get();
        const requestAtStart = requestNumber;
        if (context && !previous.serverUrl && !previous.offlineMode && !previous.candidate) {
          const abort = new AbortController();
          const timeout = setTimeout(() => abort.abort(new Error('返回连接确认超时')), 20_000);
          try {
            if (!context.offlineMode) {
              const { validateServerConnection, checkWelcomeRequirement } = await import('../api.ts');
              const checked = await checkSavedServer(context.serverUrl,
                { validate: validateServerConnection, welcome: checkWelcomeRequirement }, abort.signal);
              if (checked.needsAccessCode) throw new Error('需要重新确认访问码');
            }
            if (requestNumber === requestAtStart && get().connectionId === previous.connectionId
              && get().sessionId === previous.sessionId && !get().candidate) {
              const url = context.serverUrl ? new URL(context.serverUrl) : null;
              set({ ...disconnected, ...context, isConnected: Boolean(context.serverUrl),
                protocol: url?.protocol === 'https:' ? 'https' : 'http', host: url?.hostname ?? '', port: url?.port ?? '',
                connectionId: previous.connectionId + 1, sessionId: previous.sessionId + 1,
                readerReturnTo: context.offlineMode ? '/shelf' : null });
              writeActiveServerMirror(context.serverUrl);
            }
          } catch {
            if (requestNumber === requestAtStart && get().sessionId === previous.sessionId) {
              set({ readerReturnError: '阅读器返回连接确认失败，请点击原服务器条目重试。服务器列表已保留。' });
            }
          } finally { clearTimeout(timeout); }
        }
        set({ hasHydrated: true });
      })();
      try { await loading; } finally { clearTimeout(timer); loading = null; set({ storageBusy: false }); }
    },
    recoverServers: async () => {
      if (get().saving || loading) return;
      clearReaderReturn(returnChannel);
      set({ saving: true });
      try {
        const result = await repository.recover();
        if (result.ok) set({ ...result.value, storageError: '', hasHydrated: true });
        else set({ storageError: result.error });
      } finally { set({ saving: false }); }
    },
    saveServer: async (value) => {
      if (get().saving || !get().hasHydrated || get().storageError) return { ok: false, error: '请先完成服务器列表加载或恢复' };
      let url: string;
      try { url = normalizeServerAddress(value); }
      catch (error) { return { ok: false, error: (error as Error).message }; }
      const existing = get().savedServers.find((s) => s.url === url);
      if (existing) return { ok: true, value: existing };
      const server = { id: crypto.randomUUID(), url, title: '', addedAt: new Date().toISOString() };
      set({ saving: true });
      try {
        const { savedServers, lastUsedServerId, offlineMode } = get();
        const result = await repository.save({ savedServers: [...savedServers, server], lastUsedServerId, offlineMode });
        if (!result.ok) return result;
        set({ savedServers: result.value.savedServers });
        return { ok: true, value: server };
      } finally { set({ saving: false }); }
    },
    beginConnection: (id) => {
      const server = get().savedServers.find((s) => s.id === id);
      if (!server || get().saving || get().storageError) return null;
      clearReaderReturn(returnChannel);
      const candidate = { id, url: server.url, requestId: ++requestNumber, needsAccessCode: false };
      set({ candidate, readerReturnTo: null, readerReturnError: '' });
      return candidate;
    },
    cancelConnection: (requestId) => {
      if (requestId !== undefined && get().candidate?.requestId !== requestId) return;
      ++requestNumber;
      set({ candidate: null });
    },
    requireAccess: (requestId) => {
      const candidate = get().candidate;
      if (candidate?.requestId === requestId) set({ candidate: { ...candidate, needsAccessCode: true } });
    },
    activateCandidate: async (requestId) => {
      const candidate = get().candidate;
      if (candidate?.requestId !== requestId || get().saving) return false;
      set({ saving: true });
      try {
        await requireClosedReaders();
        if (get().candidate?.requestId !== requestId) return false;
        const { savedServers, offlineMode, lastUsedServerId } = get();
        const result = await repository.save({ savedServers, lastUsedServerId: candidate.id, offlineMode: false });
        if (!result.ok) throw new Error(result.error);
        if (get().candidate?.requestId !== requestId) {
          const restored = await repository.save({ savedServers, lastUsedServerId, offlineMode });
          if (!restored.ok) set({ storageError: restored.error });
          return false;
        }
        const url = new URL(candidate.url);
        clearReaderReturn(returnChannel);
        clearReadStateCache();
        set({ ...disconnected, serverUrl: candidate.url, activeServerId: candidate.id,
          serverTitle: savedServers.find((s) => s.id === candidate.id)?.title || '',
          protocol: url.protocol === 'https:' ? 'https' : 'http', host: url.hostname, port: url.port,
          isConnected: true, offlineMode: false, candidate: null, lastUsedServerId: candidate.id,
          connectionId: get().connectionId + 1, sessionId: get().sessionId + 1 });
        writeActiveServerMirror(candidate.url);
        return true;
      } finally { set({ saving: false }); }
    },
    // Legacy test/integration entry point: only updates the active runtime snapshot.
    setServer: (protocol, host, port) => {
      clearReaderReturn(returnChannel);
      clearReadStateCache();
      set({ ...disconnected, serverUrl: normalizeServerAddress(`${protocol}://${host}${port ? `:${port}` : ''}`),
        protocol, host, port, offlineMode: false, isConnected: true,
        connectionId: get().connectionId + 1, sessionId: get().sessionId + 1 });
    },
    enterOfflineMode: () => withClosedReaderSession(async () => {
      clearReaderReturn(returnChannel);
      clearReadStateCache();
      set({ offlineMode: true, candidate: null, readerReturnTo: null, readerReturnError: '', sessionId: get().sessionId + 1 });
    }),
    leaveOfflineMode: () => { clearReaderReturn(returnChannel); set({ offlineMode: false, sessionId: get().sessionId + 1 }); },
    setConnected: (token, user) => {
      clearReaderReturn(returnChannel);
      clearReadStateCache();
      set({ isConnected: true, token, user, sessionId: get().sessionId + 1, capabilities: invalidateCapabilitiesForSession(get().capabilities) });
    },
    setUser: (user) => {
      const changed = didServerSessionChange(get().user, user);
      if (changed) { clearReaderReturn(returnChannel); clearReadStateCache(); }
      set({ isConnected: Boolean(get().serverUrl), token: user ? get().token : '', user,
        sessionId: get().sessionId + (changed ? 1 : 0),
        capabilities: changed ? invalidateCapabilitiesForSession(get().capabilities) : get().capabilities });
    },
    setServerTitle: (serverTitle) => set({ serverTitle }),
    setServerCapabilities: (capabilities) => set({ capabilities }),
    setHasHydrated: (hasHydrated) => set({ hasHydrated }),
    logout: () => {
      clearReaderReturn(returnChannel);
      clearReadStateCache();
      set({ isConnected: Boolean(get().serverUrl), token: '', user: null, sessionId: get().sessionId + 1,
        capabilities: invalidateCapabilitiesForSession(get().capabilities) });
    },
    disconnect: () => {
      clearReaderReturn(returnChannel);
      clearReadStateCache();
      ++requestNumber;
      writeActiveServerMirror('');
      set({ ...disconnected, offlineMode: false, candidate: null, readerReturnTo: null, readerReturnError: '',
        connectionId: get().connectionId + 1, sessionId: get().sessionId + 1 });
    },
  }));
}
export const useServerStore = createServerStore();
