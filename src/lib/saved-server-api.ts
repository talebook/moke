import { normalizeLibraryBaseUrl } from './discovery/base-url.ts';
import { SavedServerRepository, SAVED_SERVER_STORAGE_KEY, type SaveServerInput, type SaveServerResult as RepositorySaveResult } from './saved-server-repository.ts';
import { createSavedServerStorage, readLegacyNativeSources } from './saved-server-storage.ts';
import { createSavedServerStore } from './store/saved-servers.ts';
import type { SavedServer, LegacyServerSources } from './saved-server-model.ts';

export type { SaveServerInput } from './saved-server-repository.ts';
/** Private migration originals never cross the future discovery/UI facade. */
export type SavedServerView = Pick<SavedServer, 'id' | 'url' | 'title' | 'addedAt' | 'displayName' | 'entryRevision' | 'status' | 'issue'>;
export type SaveServerResult = Exclude<RepositorySaveResult, { ok: true }>
  | { ok: true; outcome: 'created' | 'existing' | 'corrected'; server: SavedServerView; persisted: true };

function view(entry: SavedServer): SavedServerView {
  const { id, url, title, addedAt, displayName, entryRevision, status, issue } = entry;
  return { id, url, title, addedAt, entryRevision, status,
    ...(displayName === undefined ? {} : { displayName }), ...(issue === undefined ? {} : { issue }) };
}

export function createSavedServerApi(repository: SavedServerRepository) {
  const store = createSavedServerStore(repository);
  return {
    async loadSavedServers() {
      const result = await store.getState().load();
      return result.ok ? { ok: true as const, savedServers: result.registry.savedServers.map(view) } : result;
    },
    async saveServer(input: SaveServerInput): Promise<SaveServerResult> {
      const result = await store.getState().saveServer(input);
      return result.ok ? { ...result, server: view(result.server) } : result;
    },
    getSavedServersSnapshot() {
      const { registry, busy, error } = store.getState();
      return { savedServers: registry?.savedServers.map(view) ?? [], loaded: registry !== null, busy, error };
    },
  };
}

async function readLegacySources(): Promise<LegacyServerSources> {
  if (typeof window === 'undefined') throw new Error('saved_server_storage.unavailable');
  // Deliberately not safeGet*: unreadable legacy data is not evidence of an
  // empty configuration. Preserve it and stop instead of migrating over it.
  const stateRaw = window.localStorage.getItem('moke-server-storage');
  const urlRaw = window.localStorage.getItem('moke_server_url');
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return { stateRaw, urlRaw };
  // A browser v2 authority requires explicit cross-storage reconciliation;
  // native does not silently choose it or fall back after an IO failure.
  if (window.localStorage.getItem(SAVED_SERVER_STORAGE_KEY) !== null) {
    throw new Error('saved_server_storage.conflicting_sources');
  }
  const native = await readLegacyNativeSources();
  const nativeRaw = native[0]?.raw;
  if (nativeRaw !== undefined && stateRaw !== null && nativeRaw !== stateRaw) {
    throw new Error('saved_server_storage.conflicting_sources');
  }
  return { stateRaw: nativeRaw ?? stateRaw, urlRaw };
}

async function legacyEntryInUse(entry: SavedServer): Promise<boolean> {
  const { useServerStore } = await import('./store/server.ts');
  const current = useServerStore.getState().serverUrl;
  if (current) {
    try { if (normalizeLibraryBaseUrl(current) === entry.url) return true; }
    catch { if (current === entry.url || entry.legacyAliases.includes(current)) return true; }
  }
  // S2's authoritative Reader/candidate lease is not integrated yet. Default
  // address corrections fail closed on all platforms rather than guessing
  // that no late Reader can claim the source. Data-layer clients can supply
  // the real guard; pure renames never change source and remain available.
  return true;
}

let defaultApi: ReturnType<typeof createSavedServerApi> | undefined;
function api() {
  return defaultApi ??= createSavedServerApi(new SavedServerRepository(createSavedServerStorage(), {
    readLegacySources, isEntryInUse: legacyEntryInUse,
  }));
}
export const loadSavedServers = () => api().loadSavedServers();
export const saveServer = (input: SaveServerInput) => api().saveServer(input);
export const getSavedServersSnapshot = () => api().getSavedServersSnapshot();
