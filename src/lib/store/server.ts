import { create } from 'zustand';
import { didServerSessionChange, invalidateServerCapabilities, type ReaderInfo } from '../server-session.ts';
import { DEFAULT_SERVER_CAPABILITIES, type ServerCapabilities } from '../server-capabilities.ts';
import { clearReadStateCache } from '../reading-state.ts';
import { normalizeServerAddress } from '../server-url.ts';
import { emptyRegistry, type SavedServer, type ServerBackup, type StorageResult, type ServerRegistryRepository } from '../server-registry.ts';
import { createServerRepository, writeActiveServerMirror } from '../server-storage.ts';
import { withClosedReaderSession } from '../reader-source.ts';
import { clearReaderReturn, takeReaderReturn, type ReaderReturnChannel } from '../reader-return.ts';
import { checkSavedServer } from '../server-connection.ts';
import { createLocalId } from '../random-id.ts';
import { debugLog } from '../debug-log.ts';

export type { ReaderInfo } from '../server-session.ts';
export { DEFAULT_SERVER_CAPABILITIES } from '../server-capabilities.ts';
export type { ServerCapabilities } from '../server-capabilities.ts';

function invalidateCapabilitiesForSession(capabilities: ServerCapabilities): ServerCapabilities {
  return { ...invalidateServerCapabilities(capabilities), annotationApiStatus: 'unchecked', annotationApiCheckedAt: null };
}

function syncActiveServerMirror(url: string, operation: 'reader-return' | 'connection' | 'disconnect'): void {
  if (writeActiveServerMirror(url)) return;
  // The mirror is optional. Diagnostics must not turn its failure into a
  // failed connection or disclose addresses, stored bytes or credentials.
  try {
    debugLog('warn', 'server-storage', '兼容服务器地址镜像未同步，当前连接状态与服务器列表不受影响。', { operation });
  } catch { /* Logging is best-effort too. */ }
}

interface Candidate { id: string; url: string; requestId: number; needsAccessCode: boolean }
interface TitleSource { serverUrl: string; connectionId: number; sessionId: number }
type SaveServerResult = { ok: true; value: SavedServer; created: boolean } | { ok: false; error: string };
interface ServerState {
  savedServers: SavedServer[];
  serverListNotice: string;
  serverBackupKey: string | null;
  storageError: string;
  storageBusy: boolean;
  saving: boolean;
  activeServerId: string | null;
  candidate: Candidate | null;
  connectionId: number;
  sessionId: number;
  // Compatibility counter for the personal main image cache.
  sessionRevision: number;
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
  readServerBackup: () => Promise<StorageResult<ServerBackup>>;
  saveServer: (value: string) => Promise<SaveServerResult>;
  beginConnection: (id: string) => Candidate | null;
  beginActiveAccessConfirmation: () => Candidate | null;
  cancelConnection: (requestId?: number) => void;
  requireAccess: (requestId: number) => void;
  activateCandidate: (requestId: number, accessConfirmed?: boolean) => Promise<boolean>;
  enterOfflineMode: (prepareDocumentReturn?: () => void) => Promise<void>;
  leaveOfflineMode: (source?: TitleSource, user?: ReaderInfo | null, signal?: AbortSignal) => Promise<boolean>;
  invalidateSession: () => void;
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
    ...emptyRegistry(), ...disconnected, offlineMode: false, serverListNotice: '', candidate: null, connectionId: 0, sessionId: 0, sessionRevision: 0,
    serverBackupKey: repository.getLatestBackupKey(),
    hasHydrated: false, readerReturnTo: null, readerReturnError: '', storageError: '', storageBusy: false, saving: false,
    loadServers: async () => {
      if (loading || get().saving) return loading ?? undefined;
      set({ hasHydrated: false, storageError: '', storageBusy: true });
      // ArkWeb/native IPC must not strand the entire UI on a hydration spinner.
      // Keep recovery locked until this operation settles so a late file write
      // cannot race a new recovery or save.
      const timer = setTimeout(() => set({ hasHydrated: true,
        storageError: '服务器列表读取超时，原数据已保留。可先使用离线书库，有当前连接时也可返回当前书架。读取结束前不能重新加载或重建列表；若读取自行完成，列表会自动恢复，也可完全退出并重新启动应用后重试。' }), 8000);
      loading = (async () => {
        const result = await repository.load();
        if (!result.ok) { clearReaderReturn(returnChannel); set({ storageError: result.error, hasHydrated: true }); return; }
        clearTimeout(timer);
        // A timeout exit may already have opened an offline/current shelf.
        // Keep that UI usable when this original read eventually completes.
        set({ ...result.value, serverListNotice: result.notice ?? '', hasHydrated: get().hasHydrated, storageError: '' });
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
                offlineMode: context.offlineMode, isConnected: Boolean(context.serverUrl) && !context.offlineMode,
                protocol: url?.protocol === 'https:' ? 'https' : 'http', host: url?.hostname ?? '', port: url?.port ?? '',
                connectionId: previous.connectionId + 1, sessionId: previous.sessionId + 1, sessionRevision: previous.sessionRevision + 1,
                readerReturnTo: context.offlineMode && context.intent !== 'offline-library' ? '/shelf' : null });
              syncActiveServerMirror(context.serverUrl, 'reader-return');
            }
          } catch {
            if (requestNumber === requestAtStart && get().sessionId === previous.sessionId) {
              set({ readerReturnError: '阅读器返回连接确认失败，请点击原服务器条目重试。服务器列表已保留。' });
            }
          } finally { clearTimeout(timeout); }
        }
        set({ hasHydrated: true });
      })();
      try { await loading; } finally { clearTimeout(timer); loading = null; set({ storageBusy: false, serverBackupKey: repository.getLatestBackupKey() }); }
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
      } finally { set({ saving: false, serverBackupKey: repository.getLatestBackupKey() }); }
    },
    readServerBackup: async () => {
      // The repository serializes this read with migration, save and recovery;
      // viewing original bytes never restores a connection or changes the list.
      try { return await repository.readLatestBackup(); }
      finally { set({ serverBackupKey: repository.getLatestBackupKey() }); }
    },
    saveServer: async (value) => {
      if (get().saving || get().storageBusy || !get().hasHydrated || get().storageError) return { ok: false, error: '请先完成服务器列表加载或恢复' };
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
        if (!result.ok) {
          // The list page exposes its non-destructive reload action for this
          // conflict; retrying the same stale snapshot cannot succeed.
          if (result.reason === 'configuration-changed') {
            get().cancelConnection();
            set({ storageError: result.error });
          }
          return result;
        }
        set({ savedServers: result.value.savedServers });
        return { ok: true, value: server, created: true };
      } catch (error) {
        return { ok: false, error: `未保存：${error instanceof Error ? error.message : '存储不可用'}，请重试。` };
      } finally { set({ saving: false, serverBackupKey: repository.getLatestBackupKey() }); }
    },
    beginConnection: (id) => {
      const server = get().savedServers.find((s) => s.id === id);
      // An external configuration conflict may remove an ID or reassign its
      // origin. Keep the live connection, but reload before trusting this list
      // for another connection. Ordinary read-only writes leave storageError
      // empty, so a successfully loaded list remains connectable.
      if (!server || get().saving || get().storageBusy || get().storageError) return null;
      clearReaderReturn(returnChannel);
      const candidate = { id, url: server.url, requestId: ++requestNumber, needsAccessCode: false };
      set({ candidate, readerReturnTo: null, readerReturnError: '', serverListNotice: '' });
      return candidate;
    },
    beginActiveAccessConfirmation: () => {
      const activeServerId = get().activeServerId;
      const activeServer = get().savedServers.find((server) => server.id === activeServerId);
      // A reload can retain runtime A while an external writer reassigns its
      // saved ID to B. A's access confirmation must never target that new URL.
      const candidate = activeServer && activeServer.url === get().serverUrl
        ? get().beginConnection(activeServer.id) : null;
      if (!candidate) {
        set({ serverListNotice: '需要重新确认访问码，请从服务器列表重新连接。' });
        return null;
      }
      get().requireAccess(candidate.requestId);
      return get().candidate;
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
    activateCandidate: async (requestId, accessConfirmed = false) => {
      const candidate = get().candidate;
      // Access may confirm this candidate only after a successful server
      // response. This fences internal activation; the server owns auth.
      if (candidate?.requestId !== requestId || (candidate.needsAccessCode && !accessConfirmed)
        || get().saving || get().storageBusy || get().storageError) return false;
      set({ saving: true });
      try {
        return await withClosedReaderSession(async () => {
          const currentCandidate = get().candidate;
          if (currentCandidate?.requestId !== requestId || (currentCandidate.needsAccessCode && !accessConfirmed)
            || get().storageBusy || get().storageError) return false;
          const url = new URL(candidate.url);
          clearReaderReturn(returnChannel);
          clearReadStateCache();
          set({ ...disconnected, serverUrl: candidate.url, activeServerId: candidate.id,
            serverTitle: get().savedServers.find((s) => s.id === candidate.id)?.title || '',
            protocol: url.protocol === 'https:' ? 'https' : 'http', host: url.hostname, port: url.port,
            isConnected: true, offlineMode: false, candidate: null, serverListNotice: '',
            connectionId: get().connectionId + 1, sessionId: get().sessionId + 1, sessionRevision: get().sessionRevision + 1 });
          syncActiveServerMirror(candidate.url, 'connection');
          return true;
        });
      } finally { set({ saving: false }); }
    },
    enterOfflineMode: (prepareDocumentReturn) => withClosedReaderSession(async () => {
      clearReaderReturn(returnChannel);
      // Prepare a document handoff under the same reservation, before changing
      // identity/remounting pages. Failure leaves the original page and mode intact.
      prepareDocumentReturn?.();
      clearReadStateCache();
      // Runtime browsing is independent of an unfinished registry read. Keep
      // the storage error/busy lock so no second migration or recovery races it.
      set({ offlineMode: true, isConnected: false, hasHydrated: true, candidate: null, readerReturnTo: null, readerReturnError: '', serverListNotice: '', sessionId: get().sessionId + 1, sessionRevision: get().sessionRevision + 1 });
    }),
    leaveOfflineMode: (source, user, signal) => withClosedReaderSession(async () => {
      const state = get();
      if (!state.offlineMode || state.candidate || signal?.aborted
        || (source && (state.serverUrl !== source.serverUrl || state.connectionId !== source.connectionId
          || state.sessionId !== source.sessionId))) return false;
      clearReaderReturn(returnChannel);
      clearReadStateCache();
      set({ offlineMode: false, isConnected: Boolean(state.serverUrl),
        ...(user !== undefined ? { user, token: user ? state.token : '' } : {}),
        sessionId: state.sessionId + 1, sessionRevision: state.sessionRevision + 1,
        capabilities: invalidateCapabilitiesForSession(state.capabilities) });
      return true;
    }),
    invalidateSession: () => {
      clearReaderReturn(returnChannel);
      clearReadStateCache();
      set({ token: '', user: null, sessionId: get().sessionId + 1, sessionRevision: get().sessionRevision + 1,
        capabilities: invalidateCapabilitiesForSession(get().capabilities) });
    },
    setConnected: (token, user) => {
      clearReaderReturn(returnChannel);
      clearReadStateCache();
      set({ isConnected: true, token, user, sessionId: get().sessionId + 1, sessionRevision: get().sessionRevision + 1, capabilities: invalidateCapabilitiesForSession(get().capabilities) });
    },
    setUser: (user) => {
      const changed = didServerSessionChange(get().user, user);
      if (changed) { clearReaderReturn(returnChannel); clearReadStateCache(); }
      set({ isConnected: Boolean(get().serverUrl), token: user ? get().token : '', user,
        sessionId: get().sessionId + (changed ? 1 : 0), sessionRevision: get().sessionRevision + (changed ? 1 : 0),
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
        else {
          if (result.reason === 'configuration-changed') {
            get().cancelConnection();
            set({ storageError: result.error });
          }
          if (isSameConnection()) set({ serverListNotice: `服务器名称${result.error} 当前连接已保留。` });
        }
      } catch {
        if (isSameConnection()) set({ serverListNotice: '服务器名称未保存，请稍后重新连接以重试。当前连接已保留。' });
      } finally { set({ saving: false, serverBackupKey: repository.getLatestBackupKey() }); }
    },
    setServerCapabilities: (capabilities) => set({ capabilities }),
    logout: () => {
      clearReaderReturn(returnChannel);
      clearReadStateCache();
      set({ isConnected: Boolean(get().serverUrl), token: '', user: null, sessionId: get().sessionId + 1, sessionRevision: get().sessionRevision + 1,
        capabilities: invalidateCapabilitiesForSession(get().capabilities) });
    },
    disconnect: () => {
      clearReaderReturn(returnChannel);
      clearReadStateCache();
      ++requestNumber;
      syncActiveServerMirror('', 'disconnect');
      set({ ...disconnected, offlineMode: false, candidate: null, readerReturnTo: null, readerReturnError: '',
        serverListNotice: '已断开，服务器列表已保留',
        connectionId: get().connectionId + 1, sessionId: get().sessionId + 1, sessionRevision: get().sessionRevision + 1 });
    },
  }));
}
export const useServerStore = createServerStore();
