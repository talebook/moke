/** Storage failures are explicit. The repository owns migration and verified commits. */
export interface RegistryStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
}

export const SAVED_SERVER_DIRECTORY = 'server-registry';
export const MAX_SAVED_SERVER_STORAGE_BYTES = 4 * 1024 * 1024;
const STORAGE_KEY = /^moke-saved-servers-v2(?:-[A-Za-z0-9-]+)?$/;
const LEGACY_NATIVE_PATH = 'books/.servers/moke-server-storage.json';
type NativeFs = Pick<typeof import('@tauri-apps/plugin-fs'),
  'BaseDirectory' | 'exists' | 'mkdir' | 'open' | 'remove' | 'rename'>;
type FsBaseDirectory = import('@tauri-apps/api/path').BaseDirectory;

export interface NativeSavedServerStorageOptions {
  loadFs?: () => Promise<NativeFs>;
  createTemporaryId?: () => string;
}

export interface LegacyNativeServerSource {
  source: 'native';
  key: 'moke-server-storage';
  path: string;
  raw: string;
}

function assertKey(key: string): void {
  if (typeof key !== 'string' || key.length > 200 || !STORAGE_KEY.test(key)) {
    throw new Error('saved_server_storage.invalid_key');
  }
}

function encodeValue(value: string): Uint8Array {
  if (typeof value !== 'string') throw new Error('saved_server_storage.invalid_value');
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > MAX_SAVED_SERVER_STORAGE_BYTES) {
    throw new Error('saved_server_storage.too_large');
  }
  return bytes;
}

function browserStorage(): Storage {
  // Reading the localStorage getter can throw on native/custom schemes.
  if (typeof window === 'undefined') throw new Error('saved_server_storage.unavailable');
  return window.localStorage;
}

export function createBrowserSavedServerStorage(storage?: RegistryStorage): RegistryStorage {
  return {
    async getItem(key) {
      assertKey(key);
      const value = await (storage ?? browserStorage()).getItem(key);
      if (value !== null) encodeValue(value);
      return value;
    },
    async setItem(key, value) {
      assertKey(key);
      encodeValue(value);
      await (storage ?? browserStorage()).setItem(key, value);
    },
  };
}

const loadNativeFs = () => import('@tauri-apps/plugin-fs');
let temporarySequence = 0;
function createTemporaryId(): string {
  // This is collision avoidance, never an authentication token. createNew is
  // the final ownership check even when a WebView has no randomUUID API.
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${(++temporarySequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function readNativeFile(fs: NativeFs, path: string, baseDir: FsBaseDirectory): Promise<string | null> {
  if (!await fs.exists(path, { baseDir })) return null;
  const file = await fs.open(path, { baseDir, read: true });
  let failed = false;
  try {
    const { size } = await file.stat();
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SAVED_SERVER_STORAGE_BYTES) {
      throw new Error('saved_server_storage.too_large');
    }
    const bytes = new Uint8Array(size);
    let position = 0;
    while (position < bytes.byteLength) {
      const count = await file.read(bytes.subarray(position));
      if (!Number.isSafeInteger(count) || !count || count < 0 || count > bytes.byteLength - position) {
        throw new Error('saved_server_storage.incomplete_read');
      }
      position += count;
    }
    if ((await file.stat()).size !== size) throw new Error('saved_server_storage.changed_during_read');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try { await file.close(); } catch (error) { if (!failed) throw error; }
  }
}

export function createNativeSavedServerStorage(options: NativeSavedServerStorageOptions = {}): RegistryStorage {
  const loadFs = options.loadFs ?? loadNativeFs;
  const temporaryId = options.createTemporaryId ?? createTemporaryId;
  return {
    async getItem(key) {
      assertKey(key);
      const fs = await loadFs();
      return readNativeFile(fs, `${SAVED_SERVER_DIRECTORY}/${key}.json`, fs.BaseDirectory.AppConfig);
    },
    async setItem(key, value) {
      assertKey(key);
      const bytes = encodeValue(value);
      const suffix = temporaryId();
      if (!/^[A-Za-z0-9-]{1,128}$/.test(suffix)) throw new Error('saved_server_storage.invalid_temporary_id');
      const fs = await loadFs();
      const baseDir = fs.BaseDirectory.AppConfig;
      await fs.mkdir(SAVED_SERVER_DIRECTORY, { baseDir, recursive: true });
      const path = `${SAVED_SERVER_DIRECTORY}/${key}.json`;
      const temporary = `${path}.${suffix}.tmp`;
      // Do not clean up when open fails: the file may belong to another writer.
      const file = await fs.open(temporary, { baseDir, write: true, createNew: true });
      let closed = false;
      try {
        let position = 0;
        while (position < bytes.byteLength) {
          const count = await file.write(bytes.subarray(position));
          if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.byteLength - position) {
            throw new Error('saved_server_storage.incomplete_write');
          }
          position += count;
        }
        await file.close();
        closed = true;
        await fs.rename(temporary, path, { oldPathBaseDir: baseDir, newPathBaseDir: baseDir });
      } catch (error) {
        if (!closed) { try { await file.close(); } catch { /* Preserve the original failure. */ } }
        try { await fs.remove(temporary, { baseDir }); } catch { /* Only our own temporary file. */ }
        throw error;
      }
    },
  };
}

/** Old H files are a distinct read-only migration source, never a fallback. */
export async function readLegacyNativeSources(options: NativeSavedServerStorageOptions = {}): Promise<LegacyNativeServerSource[]> {
  const fs = await (options.loadFs ?? loadNativeFs)();
  const raw = await readNativeFile(fs, LEGACY_NATIVE_PATH, fs.BaseDirectory.AppData);
  return raw === null ? [] : [{ source: 'native', key: 'moke-server-storage', path: LEGACY_NATIVE_PATH, raw }];
}

export function createSavedServerStorage(): RegistryStorage {
  return process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri'
    ? createNativeSavedServerStorage()
    : createBrowserSavedServerStorage();
}
