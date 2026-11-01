import { normalizeLibraryBaseUrl } from './discovery/base-url.ts';
import {
  migrateSavedServerRegistry, parseSavedServerRegistry, recomputeSavedServerCollisions,
  serializeSavedServerRegistry, validateDisplayName, SavedServerModelError,
  type LegacyServerSources, type SavedServer, type SavedServerRegistry,
} from './saved-server-model.ts';
import type { RegistryStorage } from './saved-server-storage.ts';

export const SAVED_SERVER_STORAGE_KEY = 'moke-saved-servers-v2';
export interface SaveServerInput {
  rawBaseUrl: string;
  displayName?: string;
  target?: { id: string; expectedEntryRevision: string };
}
export type SaveServerResult =
  | { ok: true; outcome: 'created' | 'existing' | 'corrected'; server: SavedServer; persisted: true }
  | { ok: false; outcome: 'needs-edit'; code: string; entryId?: string }
  | { ok: false; outcome: 'collision'; entryIds: string[] }
  | { ok: false; outcome: 'entry-in-use' | 'entry-changed' | 'entry-not-found'; entryId: string }
  | { ok: false; outcome: 'admission-rejected'; code: string }
  | StorageFailure;
/** The writer must revalidate its authority at its actual commit point. A
 * preflight callback followed by an ordinary asynchronous storage write is not
 * sufficient. Production discovery supplies the native compare-and-commit. */
export interface SavedServerWriteAuthorization {
  readonly baseUrl: string;
  commit(value: string, expectedRaw: string | null): Promise<void>;
}
/** Only use when the authority guarantees no registry write occurred. */
export class SavedServerAdmissionRejected extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
export interface StorageFailure {
  ok: false;
  outcome: 'storage-failure';
  code: 'unavailable' | 'write-rejected' | 'verification-failed' | 'configuration-changed'
    | 'unsupported-schema' | 'invalid-schema' | 'reload-required';
  persistence: 'unchanged' | 'unknown';
  reloadRequired: boolean;
}
export type LoadSavedServersResult = { ok: true; registry: SavedServerRegistry } | StorageFailure;
export interface SavedServerRepositoryOptions {
  readLegacySources(): LegacyServerSources | Promise<LegacyServerSources>;
  createId?: () => string;
  now?: () => string;
  /** Absence is conservative: source integration must prove an edit is safe. */
  isEntryInUse?: (entry: SavedServer) => boolean | Promise<boolean>;
}

export function createSavedServerId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (!globalThis.crypto?.getRandomValues) throw new Error('saved-server-id-unavailable');
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sameSources = (a: LegacyServerSources, b: LegacyServerSources) =>
  a.stateRaw === b.stateRaw && a.urlRaw === b.urlRaw;
class ConfigurationChanged extends Error {}
class VerificationFailed extends Error {}
class EntryBecameBusy extends Error {
  readonly entryId: string;
  constructor(entryId: string) { super('entry-in-use'); this.entryId = entryId; }
}

/** One serialized authority; no HTTP, discovery, auth, connection, or offline writes. */
export class SavedServerRepository {
  private registry: SavedServerRegistry | null = null;
  private raw: string | null = null;
  private blocked: StorageFailure | null = null;
  private pendingWrite: { before: string | null; after: string } | null = null;
  private readonly allocatedIds = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly storage: RegistryStorage;
  private readonly options: SavedServerRepositoryOptions;
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(storage: RegistryStorage, options: SavedServerRepositoryOptions) {
    this.storage = storage;
    this.options = options;
    this.createId = options.createId ?? createSavedServerId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getSnapshot(): SavedServerRegistry | null { return this.registry ? copy(this.registry) : null; }
  load(): Promise<LoadSavedServersResult> { return this.serial(() => this.loadInside()); }

  saveServer(input: SaveServerInput, authorization?: SavedServerWriteAuthorization): Promise<SaveServerResult> {
    // Capture caller-owned objects before waiting for the writer queue.
    const command = { ...input, ...(input.target ? { target: { ...input.target } } : {}) };
    authorization = authorization ? { baseUrl: authorization.baseUrl, commit: authorization.commit.bind(authorization) } : undefined;
    return this.serial<SaveServerResult>(async () => {
      if (this.blocked) return { ...this.blocked, code: 'reload-required' };
      if (!this.registry) {
        // Loading/migration is an explicit independent operation. A rejected
        // discovered save must not first create an authority behind its gate.
        if (authorization) return { ok: false, outcome: 'storage-failure', code: 'reload-required', persistence: 'unchanged', reloadRequired: true };
        const loaded = await this.loadInside();
        if (!loaded.ok) return loaded;
      }
      try {
        await this.assertCurrent();
        let url: string;
        try { url = normalizeLibraryBaseUrl(command.rawBaseUrl); }
        catch (error) {
          return { ok: false, outcome: 'needs-edit', code: error instanceof Error ? error.message : 'invalid_base_url',
            ...(command.target ? { entryId: command.target.id } : {}) };
        }
        if (authorization && (authorization.baseUrl !== url || command.target)) {
          return { ok: false, outcome: 'admission-rejected', code: 'candidate-changed' };
        }
        if (command.displayName !== undefined && !validateDisplayName(command.displayName)) {
          return { ok: false, outcome: 'needs-edit', code: 'invalid-display-name' };
        }
        const current = this.registry!;
        const matches = current.savedServers.filter((entry) => entry.url === url);
        const target = command.target ? current.savedServers.find((entry) => entry.id === command.target!.id) : undefined;
        if (command.target && !target) return { ok: false, outcome: 'entry-not-found', entryId: command.target.id };
        if (target && command.target!.expectedEntryRevision !== target.entryRevision) {
          const prior = target.originals.at(-1);
          const previous = prior?.record as Partial<SavedServer> | undefined;
          if (prior && ['correction', 'rename'].includes(prior.source)
            && previous?.entryRevision === command.target!.expectedEntryRevision && target.url === url
            && (command.displayName === undefined ? previous.displayName === target.displayName : command.displayName === target.displayName)) {
            return { ok: true, outcome: 'existing', server: copy(target), persisted: true };
          }
          return { ok: false, outcome: 'entry-changed', entryId: target.id };
        }
        if ((target && matches.some((entry) => entry.id !== target.id)) || matches.length > 1) {
          return { ok: false, outcome: 'collision', entryIds: [...new Set([...matches.map((entry) => entry.id), ...(target ? [target.id] : [])])] };
        }
        if (!target && matches.length === 1) {
          if (matches[0].status === 'needs-edit') {
            return { ok: false, outcome: 'needs-edit', code: 'entry-needs-edit', entryId: matches[0].id };
          }
          // Duplicate selection still consumes current native authority, but
          // identical bytes are check-only and must never rename/overwrite.
          if (authorization) {
            await authorization.commit(this.raw!, this.raw);
            await this.assertCurrent();
          }
          return { ok: true, outcome: 'existing', server: copy(matches[0]), persisted: true };
        }
        const addressChanged = target && target.url !== url;
        if (addressChanged && (!this.options.isEntryInUse || await this.options.isEntryInUse(copy(target)))) {
          return { ok: false, outcome: 'entry-in-use', entryId: target.id };
        }
        if (target && target.status === 'ready' && !addressChanged && (command.displayName === undefined || command.displayName === target.displayName)) {
          return { ok: true, outcome: 'existing', server: copy(target), persisted: true };
        }
        // Awaiting a source guard must not allow a changed disk snapshot through.
        await this.assertCurrent();
        const next = copy(current);
        let saved: SavedServer;
        if (target) {
          saved = { ...copy(target), url, entryRevision: this.freshId(), status: 'ready' };
          delete saved.issue;
          // History is flat: all earlier originals are already in this array.
          // Nesting the entire history on every edit would grow exponentially.
          const previousRecord: Record<string, unknown> = { ...copy(target) };
          delete previousRecord.originals;
          saved.originals.push({ source: addressChanged ? 'correction' : 'rename', index: null,
            rawUrl: target.url, record: previousRecord });
          if (addressChanged) {
            saved.title = '';
            // Keep old identity and metadata as history; never relabel its files,
            // credentials, progress, or aliases as belonging to the new base.
            saved.legacyAliases = [];
          }
          if (command.displayName !== undefined) saved.displayName = command.displayName;
          next.savedServers = next.savedServers.map((entry) => entry.id === saved.id ? saved : entry);
        } else {
          saved = { id: this.freshId(), url, title: '', addedAt: this.now(), entryRevision: this.freshId(),
            status: 'ready', legacyAliases: [], originals: [],
            ...(command.displayName === undefined ? {} : { displayName: command.displayName }) };
          next.savedServers.push(saved);
        }
        next.savedServers = recomputeSavedServerCollisions(next.savedServers);
        const committed = await this.commit(next, this.raw, addressChanged ? async () => {
          if (!this.options.isEntryInUse || await this.options.isEntryInUse(copy(target!))) throw new EntryBecameBusy(target!.id);
        } : undefined, authorization);
        if (committed) return committed;
        return { ok: true, outcome: target ? 'corrected' : 'created', server: copy(next.savedServers.find((entry) => entry.id === saved.id)!), persisted: true };
      } catch (error) {
        if (error instanceof SavedServerAdmissionRejected) return { ok: false, outcome: 'admission-rejected', code: error.code };
        if (error instanceof EntryBecameBusy) return { ok: false, outcome: 'entry-in-use', entryId: error.entryId };
        return this.fail(error, false);
      }
    });
  }

  private freshId(): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = this.createId();
      if (typeof id === 'string' && id && /^[A-Za-z0-9-]+$/.test(id)
        && !this.allocatedIds.has(id)
        && !this.registry?.savedServers.some((entry) => entry.id === id || entry.entryRevision === id)) {
        this.allocatedIds.add(id);
        return id;
      }
    }
    throw new Error('saved-server-id-unavailable');
  }

  private async loadInside(): Promise<LoadSavedServersResult> {
    try {
      const raw = await this.storage.getItem(SAVED_SERVER_STORAGE_KEY);
      const sources = await this.options.readLegacySources();
      if (raw !== null) {
        const registry = parseSavedServerRegistry(raw);
        if (!sameSources(registry.legacySources, sources)) throw new ConfigurationChanged();
        this.registry = registry;
        this.raw = raw;
        this.blocked = null;
        this.pendingWrite = null;
        return { ok: true, registry: copy(registry) };
      }
      // Do not recreate an authority that another process removed after load.
      if (this.raw !== null || (this.blocked?.persistence === 'unknown' && this.pendingWrite?.before !== null)) {
        throw new ConfigurationChanged();
      }
      // A completed, rejected first write can be reconciled to a proven absent
      // authority. No operation is retried while its original IO is pending.
      this.blocked = null;
      this.pendingWrite = null;
      const registry = migrateSavedServerRegistry(sources, { createId: () => this.freshId(), now: this.now });
      const failed = await this.commit(registry, null);
      if (failed) return failed;
      return { ok: true, registry: copy(registry) };
    } catch (error) { return this.fail(error, false); }
  }

  private async assertCurrent(expectedRaw = this.raw, expectedSources = this.registry?.legacySources): Promise<void> {
    if (await this.storage.getItem(SAVED_SERVER_STORAGE_KEY) !== expectedRaw) throw new ConfigurationChanged();
    if (!expectedSources || !sameSources(await this.options.readLegacySources(), expectedSources)) throw new ConfigurationChanged();
  }

  private async commit(next: SavedServerRegistry, expectedRaw: string | null, beforeWrite?: () => Promise<void>, authorization?: SavedServerWriteAuthorization): Promise<StorageFailure | null> {
    let writing = false;
    try {
      const encoded = serializeSavedServerRegistry(next);
      await this.assertCurrent(expectedRaw, next.legacySources);
      // Keep the exact prior authority AND both original sources. Never write
      // v2 into a legacy key that a still-running v0/v1 client can overwrite.
      const backup = JSON.stringify({ previous: expectedRaw, legacySources: next.legacySources });
      const backupKey = `${SAVED_SERVER_STORAGE_KEY}-backup-${this.freshId()}`;
      await this.storage.setItem(backupKey, backup);
      if (await this.storage.getItem(backupKey) !== backup) throw new VerificationFailed();
      await this.assertCurrent(expectedRaw, next.legacySources);
      await beforeWrite?.();
      await this.assertCurrent(expectedRaw, next.legacySources);
      writing = true;
      this.pendingWrite = { before: expectedRaw, after: encoded };
      if (authorization) await authorization.commit(encoded, expectedRaw);
      else await this.storage.setItem(SAVED_SERVER_STORAGE_KEY, encoded);
      if (await this.storage.getItem(SAVED_SERVER_STORAGE_KEY) !== encoded) throw new VerificationFailed();
      parseSavedServerRegistry(encoded);
      // A legacy client may have written during the asynchronous commit.
      if (!sameSources(await this.options.readLegacySources(), next.legacySources)) throw new ConfigurationChanged();
      this.registry = copy(next);
      this.raw = encoded;
      this.blocked = null;
      this.pendingWrite = null;
      return null;
    } catch (error) {
      if (error instanceof SavedServerAdmissionRejected) {
        this.pendingWrite = null;
        throw error;
      }
      if (error instanceof EntryBecameBusy) throw error;
      return this.fail(error, writing);
    }
  }

  private fail(error: unknown, writing: boolean): StorageFailure {
    const unknown = writing || this.blocked?.persistence === 'unknown';
    const code: StorageFailure['code'] = error instanceof ConfigurationChanged ? 'configuration-changed'
      : error instanceof VerificationFailed ? 'verification-failed'
        : error instanceof SavedServerModelError ? (error.message.startsWith('unsupported') ? 'unsupported-schema' : 'invalid-schema')
          : writing ? 'write-rejected' : 'unavailable';
    const result: StorageFailure = { ok: false, outcome: 'storage-failure', code,
      persistence: unknown ? 'unknown' : 'unchanged', reloadRequired: true };
    this.blocked = result;
    return { ...result };
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
