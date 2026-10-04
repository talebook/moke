import { create } from 'zustand';
import { didServerSessionChange, invalidateServerCapabilities, type ReaderInfo } from '../server-session.ts';
import { DEFAULT_SERVER_CAPABILITIES, type ServerCapabilities } from '../server-capabilities.ts';
import { clearReadStateCache } from '../reading-state.ts';
import { normalizeServerAddress } from '../server-url.ts';
import { emptyRegistry, type SavedServer, type ServerRegistryRepository, type StorageResult } from '../server-registry.ts';
import { createServerRepository, writeActiveServerMirror } from '../server-storage.ts';
import { requireClosedReaders } from '../reader-source.ts';

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
  enterOfflineMode: () => void;
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

export function createServerStore(repository: ServerRegistryRepository = createServerRepository()) {
  let loading: Promise<void> | null = null;
  let requestNumber = 0;
  return create<ServerState>()((set, get) => ({
    ...emptyRegistry(), ...disconnected, candidate: null, connectionId: 0, sessionId: 0,
    hasHydrated: false, storageError: '', storageBusy: false, saving: false,
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
        if (result.ok) set({ ...result.value, hasHydrated: true, storageError: '' });
        else set({ storageError: result.error, hasHydrated: true });
      })();
      try { await loading; } finally { clearTimeout(timer); loading = null; set({ storageBusy: false }); }
    },
    recoverServers: async () => {
      if (get().saving || loading) return;
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
      const candidate = { id, url: server.url, requestId: ++requestNumber, needsAccessCode: false };
      set({ candidate });
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
      clearReadStateCache();
      set({ ...disconnected, serverUrl: normalizeServerAddress(`${protocol}://${host}${port ? `:${port}` : ''}`),
        protocol, host, port, offlineMode: false, isConnected: true,
        connectionId: get().connectionId + 1, sessionId: get().sessionId + 1 });
    },
    enterOfflineMode: () => { clearReadStateCache(); set({ offlineMode: true, candidate: null, sessionId: get().sessionId + 1 }); },
    leaveOfflineMode: () => set({ offlineMode: false, sessionId: get().sessionId + 1 }),
    setConnected: (token, user) => {
      clearReadStateCache();
      set({ isConnected: true, token, user, sessionId: get().sessionId + 1, capabilities: invalidateCapabilitiesForSession(get().capabilities) });
    },
    setUser: (user) => {
      const changed = didServerSessionChange(get().user, user);
      if (changed) clearReadStateCache();
      set({ isConnected: Boolean(get().serverUrl), token: user ? get().token : '', user,
        sessionId: get().sessionId + (changed ? 1 : 0),
        capabilities: changed ? invalidateCapabilitiesForSession(get().capabilities) : get().capabilities });
    },
    setServerTitle: (serverTitle) => set({ serverTitle }),
    setServerCapabilities: (capabilities) => set({ capabilities }),
    setHasHydrated: (hasHydrated) => set({ hasHydrated }),
    logout: () => {
      clearReadStateCache();
      set({ isConnected: Boolean(get().serverUrl), token: '', user: null, sessionId: get().sessionId + 1,
        capabilities: invalidateCapabilitiesForSession(get().capabilities) });
    },
    disconnect: () => {
      clearReadStateCache();
      ++requestNumber;
      writeActiveServerMirror('');
      set({ ...disconnected, offlineMode: false, candidate: null,
        connectionId: get().connectionId + 1, sessionId: get().sessionId + 1 });
    },
  }));
}
export const useServerStore = createServerStore();
