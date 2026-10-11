import { create } from 'zustand';
import { didServerSessionChange, invalidateServerCapabilities, type ReaderInfo } from '../server-session.ts';
import { DEFAULT_SERVER_CAPABILITIES, type ServerCapabilities } from '../server-capabilities.ts';
import { clearReadStateCache } from '../reading-state.ts';
import { normalizeServerAddress } from '../server-url.ts';
import { emptyRegistry, type SavedServer, type ServerRegistryRepository } from '../server-registry.ts';
import { createServerRepository, writeActiveServerMirror } from '../server-storage.ts';
import { withClosedReaderSession } from '../reader-source.ts';
import { clearReaderReturn, takeReaderReturn, type ReaderReturnChannel } from '../reader-return.ts';
import { checkSavedServer } from '../server-connection.ts';
import { createLocalId } from '../random-id.ts';

export type { ReaderInfo } from '../server-session.ts';
export { DEFAULT_SERVER_CAPABILITIES } from '../server-capabilities.ts';
export type { ServerCapabilities } from '../server-capabilities.ts';

function invalidateCapabilitiesForSession(capabilities: ServerCapabilities): ServerCapabilities {
  return { ...invalidateServerCapabilities(capabilities), annotationApiStatus: 'unchecked', annotationApiCheckedAt: null };
}

interface Candidate { id: string; url: string; requestId: number; needsAccessCode: boolean }
interface TitleSource { serverUrl: string; connectionId: number; sessionId: number }
type SaveServerResult = { ok: true; value: SavedServer; created: boolean } | { ok: false; error: string };
interface ServerState {
  savedServers: SavedServer[];
  serverListNotice: string;
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
  saveServer: (value: string) => Promise<SaveServerResult>;
  beginConnection: (id: string) => Candidate | null;
  cancelConnection: (requestId?: number) => void;
  requireAccess: (requestId: number) => void;
  activateCandidate: (requestId: number) => Promise<boolean>;
  setServer: (protocol: 'http' | 'https', host: string, port: string) => void;
  enterOfflineMode: (prepareDocumentReturn?: () => void) => Promise<void>;
  setConnected: (token: string, user: ReaderInfo) => void;
  setUser: (user: ReaderInfo | null) => void;
  setServerTitle: (title: string, source: TitleSource) => Promise<void>;
  setServerCapabilities: (capabilities: ServerCapabilities) => void;
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
    ...emptyRegistry(), ...disconnected, offlineMode: false, serverListNotice: '', candidate: null, connectionId: 0, sessionId: 0,
    hasHydrated: false, readerReturnTo: null, readerReturnError: '', storageError: '', storageBusy: false, saving: false,
    loadServers: async () => {
      if (loading || get().saving) return loading ?? undefined;
      set({ hasHydrated: false, storageError: '', storageBusy: true });
      // ArkWeb/native IPC must not strand the entire UI on a hydration spinner.
      // Keep recovery locked until this operation settles so a late file write
      // cannot race a new recovery or save.
      const timer = setTimeout(() => set({ hasHydrated: true,
        storageError: '服务器列表读取超时，原数据已保留。请完全退出并重新启动应用后重试；若读取自行完成，列表会自动恢复。' }), 8000);
      loading = (async () => {
        const result = await repository.load();
        if (!result.ok) { clearReaderReturn(returnChannel); set({ storageError: result.error, hasHydrated: true }); return; }
        clearTimeout(timer);
        set({ ...result.value, serverListNotice: result.notice ?? '', hasHydrated: false, storageError: '' });
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
              set({ ...disconnected, activeServerId: context.activeServerId, serverUrl: context.serverUrl,
                offlineMode: context.offlineMode, isConnected: Boolean(context.serverUrl),
                protocol: url?.protocol === 'https:' ? 'https' : 'http', host: url?.hostname ?? '', port: url?.port ?? '',
                connectionId: previous.connectionId + 1, sessionId: previous.sessionId + 1,
                readerReturnTo: context.offlineMode && context.intent !== 'offline-library' ? '/shelf' : null });
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
        await withClosedReaderSession(async () => {
          const result = await repository.recover();
          if (result.ok) {
            get().disconnect();
            set({ ...result.value, storageError: '', hasHydrated: true, serverListNotice: '服务器列表已重建，原连接已断开' });
          } else set({ storageError: result.error });
        });
      } catch (error) {
        set({ storageError: error instanceof Error ? error.message : '恢复失败，请重试' });
      } finally { set({ saving: false }); }
    },
    saveServer: async (value) => {
      if (get().saving || !get().hasHydrated || get().storageError) return { ok: false, error: '请先完成服务器列表加载或恢复' };
      let url: string;
      try { url = normalizeServerAddress(value); }
      catch (error) { return { ok: false, error: (error as Error).message }; }
      const existing = get().savedServers.find((s) => s.url === url);
      if (existing) return { ok: true, value: existing, created: false };
      set({ saving: true });
      try {
        const server = { id: createLocalId(), url, title: '', addedAt: new Date().toISOString() };
        const { savedServers } = get();
        const result = await repository.save({ savedServers: [...savedServers, server] });
        if (!result.ok) return result;
        set({ savedServers: result.value.savedServers });
        return { ok: true, value: server, created: true };
      } catch (error) {
        return { ok: false, error: `未保存：${error instanceof Error ? error.message : '存储不可用'}，请重试。` };
      } finally { set({ saving: false }); }
    },
    beginConnection: (id) => {
      const server = get().savedServers.find((s) => s.id === id);
      if (!server || get().saving || get().storageError) return null;
      clearReaderReturn(returnChannel);
      const candidate = { id, url: server.url, requestId: ++requestNumber, needsAccessCode: false };
      set({ candidate, readerReturnTo: null, readerReturnError: '', serverListNotice: '' });
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
        return await withClosedReaderSession(async () => {
          if (get().candidate?.requestId !== requestId) return false;
          const url = new URL(candidate.url);
          clearReaderReturn(returnChannel);
          clearReadStateCache();
          set({ ...disconnected, serverUrl: candidate.url, activeServerId: candidate.id,
            serverTitle: get().savedServers.find((s) => s.id === candidate.id)?.title || '',
            protocol: url.protocol === 'https:' ? 'https' : 'http', host: url.hostname, port: url.port,
            isConnected: true, offlineMode: false, candidate: null, serverListNotice: '',
            connectionId: get().connectionId + 1, sessionId: get().sessionId + 1 });
          writeActiveServerMirror(candidate.url);
          return true;
        });
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
    enterOfflineMode: (prepareDocumentReturn) => withClosedReaderSession(async () => {
      clearReaderReturn(returnChannel);
      // Prepare a document handoff under the same reservation, before changing
      // identity/remounting pages. Failure leaves the original page and mode intact.
      prepareDocumentReturn?.();
      clearReadStateCache();
      set({ offlineMode: true, candidate: null, readerReturnTo: null, readerReturnError: '', serverListNotice: '', sessionId: get().sessionId + 1 });
    }),
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
    setServerTitle: async (serverTitle, source) => {
      const isSameConnection = () => get().serverUrl === source.serverUrl && get().connectionId === source.connectionId;
      const isCurrent = () => isSameConnection() && get().sessionId === source.sessionId;
      if (!isCurrent()) return;
      set({ serverTitle });
      const active = get().savedServers.find((entry) => entry.id === get().activeServerId && entry.url === source.serverUrl);
      if (!active || active.title === serverTitle) return;
      // Display metadata is optional: read-only storage must not invalidate a
      // confirmed connection. Share the write reservation with save/recovery.
      if (get().saving || loading || get().storageError) {
        set({ serverListNotice: '服务器名称未保存，请稍后重新连接以重试。当前连接已保留。' });
        return;
      }
      set({ saving: true });
      try {
        const savedServers = get().savedServers.map((entry) => entry.id === active.id ? { ...entry, title: serverTitle } : entry);
        const result = await repository.save({ savedServers });
        if (result.ok) set({ savedServers: result.value.savedServers });
        else if (isSameConnection()) set({ serverListNotice: `服务器名称${result.error} 当前连接已保留。` });
      } catch {
        if (isSameConnection()) set({ serverListNotice: '服务器名称未保存，请稍后重新连接以重试。当前连接已保留。' });
      } finally { set({ saving: false }); }
    },
    setServerCapabilities: (capabilities) => set({ capabilities }),
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
        serverListNotice: '已断开，服务器列表已保留',
        connectionId: get().connectionId + 1, sessionId: get().sessionId + 1 });
    },
  }));
}
export const useServerStore = createServerStore();
