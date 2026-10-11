import { SERVER_STORAGE_KEY, ServerRegistryRepository, type RegistryStorage } from './server-registry.ts';
import { safeGetLocalStorageItem } from './browser-storage.ts';
import { createLocalId } from './random-id.ts';
import { normalizeServerAddress } from './server-url.ts';

/** Unlike the compatibility helpers, unavailable storage is an explicit failure. */
export const browserServerStorage: RegistryStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};

// Native builds keep non-secret list metadata in the existing books fs scope.
// Reader windows can read this directory (including via the asset protocol);
// it is not a main-window confidentiality boundary. Only main may write it.
// Reading the old browser keys only when no native file exists allows a one-time
// migration while retaining the original data. No credentials live in this file.
export function createNativeServerStorage(): RegistryStorage {
  let recovering = false;
  return {
    prepareRecovery: () => { recovering = true; return () => { recovering = false; }; },
    async getItem(key) {
      const { BaseDirectory, exists, open } = await import('@tauri-apps/plugin-fs');
      const path = `books/.servers/${key}.json`;
      if (!await exists(path, { baseDir: BaseDirectory.AppData })) {
        // An explicit recovery may start a native list even if ArkWeb cannot read
        // its old storage. Those inaccessible browser values remain untouched.
        if (recovering) return null;
        return safeGetLocalStorageItem(key);
      }
      const file = await open(path, { baseDir: BaseDirectory.AppData, read: true });
      try {
        const { size } = await file.stat();
        if (size > 4 * 1024 * 1024) throw new Error('服务器配置文件过大');
        const bytes = new Uint8Array(size);
        let position = 0;
        while (position < size) {
          const count = await file.read(bytes.subarray(position));
          if (!count) throw new Error('服务器配置文件读取不完整');
          position += count;
        }
        return new TextDecoder().decode(bytes);
      } finally { await file.close(); }
    },
    async setItem(key, value) {
      const { BaseDirectory, mkdir, open, remove, rename } = await import('@tauri-apps/plugin-fs');
      const options = { baseDir: BaseDirectory.AppData };
      await mkdir('books/.servers', { ...options, recursive: true });
      const path = `books/.servers/${key}.json`;
      const temporary = `${path}.${createLocalId()}.tmp`;
      const file = await open(temporary, { ...options, write: true, createNew: true });
      let closed = false;
      try {
        const bytes = new TextEncoder().encode(value);
        let position = 0;
        while (position < bytes.length) {
          const count = await file.write(bytes.subarray(position));
          if (!count) throw new Error('服务器配置文件写入不完整');
          position += count;
        }
        await file.close();
        closed = true;
        await rename(temporary, path, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData });
      } catch (error) {
        // Clean up only the temporary file we successfully created. A failed
        // createNew may mean that path belongs to another writer. Cleanup must
        // preserve the write/close/rename error and never remove the target.
        if (!closed) { try { await file.close(); } catch { /* Best effort. */ } }
        try { await remove(temporary, options); } catch { /* Best effort. */ }
        throw error;
      }
    },
  };
}

export function createServerRepository(): ServerRegistryRepository {
  const native = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';
  return new ServerRegistryRepository(native ? createNativeServerStorage() : browserServerStorage,
    // A native list is authoritative. Only migrations/recovery need this mirror.
    native ? { getItem: safeGetLocalStorageItem, setItem: browserServerStorage.setItem } : browserServerStorage);
}

export function writeActiveServerMirror(url: string): boolean {
  try {
    const storage = window.localStorage;
    const previous = storage.getItem('moke_server_url');
    if (previous !== null) {
      try { normalizeServerAddress(previous); }
      catch {
        // A tolerant legacy load may still need these exact bytes. Preserve
        // and verify them before a connection/disconnect updates the mirror.
        const backupKey = `${SERVER_STORAGE_KEY}-damaged-legacy-url-backup-${createLocalId()}`;
        storage.setItem(backupKey, previous);
        if (storage.getItem(backupKey) !== previous || storage.getItem('moke_server_url') !== previous) return false;
      }
    }
    if (url) storage.setItem('moke_server_url', url);
    else storage.removeItem('moke_server_url');
    return storage.getItem('moke_server_url') === (url || null);
  } catch { return false; /* This compatibility mirror never determines the saved list. */ }
}

export { SERVER_STORAGE_KEY };
