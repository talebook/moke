import { SERVER_STORAGE_KEY, ServerRegistryRepository, type RegistryStorage } from './server-registry.ts';

/** Unlike the compatibility helpers, unavailable storage is an explicit failure. */
export const browserServerStorage: RegistryStorage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};

// Native builds keep the list in AppData using the existing narrow books fs scope.
// Reading the old browser keys only when no native file exists allows a one-time
// migration while retaining the original data. No credentials live in this file.
let recoveringNativeStorage = false;
const nativeServerStorage: RegistryStorage = {
  prepareRecovery: () => { recoveringNativeStorage = true; },
  async getItem(key) {
    const { BaseDirectory, exists, open } = await import('@tauri-apps/plugin-fs');
    const path = `books/.servers/${key}.json`;
    if (!await exists(path, { baseDir: BaseDirectory.AppData })) {
      // An explicit recovery may start a native list even if ArkWeb cannot read
      // its old storage. Those inaccessible browser values remain untouched.
      if (recoveringNativeStorage) return null;
      return browserServerStorage.getItem(key);
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
    const { BaseDirectory, mkdir, open, rename } = await import('@tauri-apps/plugin-fs');
    const options = { baseDir: BaseDirectory.AppData };
    await mkdir('books/.servers', { ...options, recursive: true });
    const path = `books/.servers/${key}.json`;
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, { ...options, write: true, createNew: true });
    try {
      const bytes = new TextEncoder().encode(value);
      let position = 0;
      while (position < bytes.length) {
        const count = await file.write(bytes.subarray(position));
        if (!count) throw new Error('服务器配置文件写入不完整');
        position += count;
      }
    } finally { await file.close(); }
    await rename(temporary, path, { oldPathBaseDir: BaseDirectory.AppData, newPathBaseDir: BaseDirectory.AppData });
  },
};

export function createServerRepository(): ServerRegistryRepository {
  const native = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';
  return new ServerRegistryRepository(native ? nativeServerStorage : browserServerStorage,
    // A native list is authoritative. Only migrations/recovery need this mirror.
    browserServerStorage);
}

export function writeActiveServerMirror(url: string): void {
  try {
    if (url) window.localStorage.setItem('moke_server_url', url);
    else window.localStorage.removeItem('moke_server_url');
  } catch { /* This compatibility mirror never determines the saved list. */ }
}

export { SERVER_STORAGE_KEY };
