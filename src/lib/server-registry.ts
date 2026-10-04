import { normalizeServerAddress } from './server-url.ts';

export const SERVER_STORAGE_KEY = 'moke-server-storage';
export interface SavedServer { id: string; url: string; title: string; addedAt: string }
export interface ServerRegistry {
  savedServers: SavedServer[];
  lastUsedServerId: string | null;
  offlineMode: boolean;
}
export interface RegistryStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  prepareRecovery?: () => void;
}
export type StorageResult<T> = { ok: true; value: T } | { ok: false; error: string };
export const emptyRegistry = (): ServerRegistry => ({ savedServers: [], lastUsedServerId: null, offlineMode: false });

export function parseServerRegistry(raw: string | null, legacy: string | null = null): ServerRegistry {
  const parsed = raw !== null ? JSON.parse(raw) : null;
  if (raw !== null && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !parsed.state || typeof parsed.state !== 'object' || Array.isArray(parsed.state))) {
    throw new Error('服务器配置格式损坏，原数据已保留');
  }
  const state = parsed?.state;
  if (parsed?.version === 1) {
    if (!Array.isArray(state.savedServers)) throw new Error('服务器列表损坏，原数据已保留');
    const savedServers: SavedServer[] = [];
    const ids = new Set<string>();
    for (const item of state.savedServers) {
      if (!item || typeof item.id !== 'string' || !item.id || typeof item.url !== 'string'
        || typeof item.title !== 'string' || typeof item.addedAt !== 'string' || ids.has(item.id)) {
        throw new Error('服务器条目损坏，原数据已保留');
      }
      ids.add(item.id);
      const url = normalizeServerAddress(item.url);
      if (!savedServers.some((s) => s.url === url)) savedServers.push({ id: item.id, url, title: item.title, addedAt: item.addedAt });
    }
    return {
      savedServers,
      lastUsedServerId: savedServers.some((s) => s.id === state.lastUsedServerId) ? state.lastUsedServerId : null,
      offlineMode: state.offlineMode === true,
    };
  }
  if (parsed && parsed.version !== undefined && parsed.version !== 0) throw new Error('不支持的服务器配置版本，原数据已保留');
  if (state?.serverUrl !== undefined && typeof state.serverUrl !== 'string') throw new Error('旧服务器地址损坏，原数据已保留');
  const oldUrl = state?.serverUrl?.trim() || legacy?.trim();
  return {
    ...emptyRegistry(),
    offlineMode: state?.offlineMode === true,
    savedServers: oldUrl ? [{ id: crypto.randomUUID(), url: normalizeServerAddress(oldUrl),
      title: typeof state?.serverTitle === 'string' ? state.serverTitle : '', addedAt: new Date().toISOString() }] : [],
  };
}

export function serializeServerRegistry(registry: ServerRegistry): string {
  return JSON.stringify({ version: 1, state: {
    savedServers: registry.savedServers.map(({ id, url, title, addedAt }) => ({ id, url, title, addedAt })),
    lastUsedServerId: registry.lastUsedServerId, offlineMode: registry.offlineMode,
  } });
}

/** Explicit, serial, verified writes. Runtime/session changes never write this repository. */
export class ServerRegistryRepository {
  private raw: string | null = null;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private storage: RegistryStorage;
  private legacyStorage: RegistryStorage;
  constructor(storage: RegistryStorage, legacyStorage: RegistryStorage = storage) {
    this.storage = storage;
    this.legacyStorage = legacyStorage;
  }

  async load(): Promise<StorageResult<ServerRegistry>> {
    try {
      this.raw = await this.storage.getItem(SERVER_STORAGE_KEY);
      // A valid v1 list is authoritative; a broken/unavailable compatibility key cannot override it.
      const isV1 = this.raw && JSON.parse(this.raw)?.version === 1;
      const legacy = isV1 ? null : await this.legacyStorage.getItem('moke_server_url');
      const registry = parseServerRegistry(this.raw, legacy);
      this.loaded = true;
      const encoded = serializeServerRegistry(registry);
      if (encoded !== this.raw) await this.writeVerified(encoded);
      return { ok: true, value: registry };
    } catch (error) {
      this.loaded = false;
      return { ok: false, error: `无法加载服务器列表：${error instanceof Error ? error.message : '存储不可用'}。原数据已保留，可重试或恢复。` };
    }
  }

  save(registry: ServerRegistry): Promise<StorageResult<ServerRegistry>> {
    return this.serial(async () => {
      try {
        if (!this.loaded) throw new Error('请先加载或恢复服务器列表');
        await this.writeVerified(serializeServerRegistry(registry));
        return { ok: true, value: registry };
      } catch (error) {
        return { ok: false, error: `未保存：${error instanceof Error ? error.message : '存储不可用'}，请重试。` };
      }
    });
  }

  /** Recovery is a visible UI action. Preserve both original keys before replacing anything. */
  recover(): Promise<StorageResult<ServerRegistry>> {
    return this.serial(async () => {
      try {
        this.storage.prepareRecovery?.();
        this.raw = await this.storage.getItem(SERVER_STORAGE_KEY);
        let legacy: string | null = null;
        let legacyUnavailable = false;
        try { legacy = await this.legacyStorage.getItem('moke_server_url'); }
        catch (error) {
          if (!this.storage.prepareRecovery) throw error;
          legacyUnavailable = true;
        }
        const backupKey = `${SERVER_STORAGE_KEY}-backup-${crypto.randomUUID()}`;
        const backup = JSON.stringify({ raw: this.raw, legacy, legacyUnavailable });
        await this.storage.setItem(backupKey, backup);
        if (await this.storage.getItem(backupKey) !== backup) throw new Error('原数据备份校验失败');
        await this.writeVerified(serializeServerRegistry(emptyRegistry()));
        this.loaded = true;
        return { ok: true, value: emptyRegistry() };
      } catch (error) {
        return { ok: false, error: `恢复失败：${error instanceof Error ? error.message : '存储不可用'}。` };
      }
    });
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }

  private async writeVerified(encoded: string): Promise<void> {
    if (await this.storage.getItem(SERVER_STORAGE_KEY) !== this.raw) throw new Error('配置已在另一窗口更改，请重新加载');
    // Keep a backup of migrations before overwriting the legacy payload.
    let version: unknown;
    try { version = this.raw && JSON.parse(this.raw)?.version; } catch { version = 1; }
    if (this.raw && version !== 1) {
      const key = `${SERVER_STORAGE_KEY}-legacy-backup`;
      await this.storage.setItem(key, this.raw);
      if (await this.storage.getItem(key) !== this.raw) throw new Error('迁移备份校验失败');
    }
    await this.storage.setItem(SERVER_STORAGE_KEY, encoded);
    if (await this.storage.getItem(SERVER_STORAGE_KEY) !== encoded) throw new Error('写入读回校验失败');
    this.raw = encoded;
  }
}
