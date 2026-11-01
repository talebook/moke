import { normalizeLibraryBaseUrl } from './discovery/base-url.ts';

export const SAVED_SERVER_SCHEMA_VERSION = 2;

export type SavedServerStatus = 'ready' | 'needs-edit' | 'collision';

/** Exact legacy material, kept for correction rather than silently discarded. */
export interface PreservedServerRecord {
  source: string;
  index: number | null;
  rawUrl: unknown;
  record: unknown;
}

export interface SavedServer {
  id: string;
  url: string;
  title: string;
  addedAt: string;
  displayName?: string;
  entryRevision: string;
  status: SavedServerStatus;
  legacyAliases: string[];
  originals: PreservedServerRecord[];
  issue?: string;
}

export interface LegacyServerSources {
  stateRaw: string | null;
  urlRaw: string | null;
}

export interface SavedServerRegistry {
  version: 2;
  savedServers: SavedServer[];
  legacySources: LegacyServerSources;
}

export interface SavedServerMigrationDependencies {
  createId: () => string;
  now: () => string;
}

export class SavedServerModelError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'SavedServerModelError';
  }
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\p{Cc}\p{Cs}]/u.test(value);
}

/** Empty clears a hint. No trimming, normalization, or UTF-16 length limit. */
export function validateDisplayName(value: unknown): value is string {
  return typeof value === 'string' && Array.from(value).length <= 128
    && !/[\p{Cc}\p{Cs}]/u.test(value);
}

export function parseDisplayName(value: string): string {
  if (!validateDisplayName(value)) throw new SavedServerModelError('invalid-display-name');
  return value;
}

function canonicalAddress(value: string): string | null {
  try { return normalizeLibraryBaseUrl(value); } catch { return null; }
}

/**
 * Only a historical absolute root can receive the narrow spelling adapter.
 * New input always calls discovery/base-url directly. No protocol/path guessing.
 */
function legacyAddress(value: unknown): { url: string; aliases: string[]; issue?: string } {
  if (typeof value !== 'string') return { url: '', aliases: [], issue: 'invalid-legacy-url' };
  const strict = canonicalAddress(value);
  if (strict !== null) return { url: strict, aliases: value === strict ? [] : [value] };
  const trimmed = value.trim();
  const root = /^(https?:\/\/[^/\\%@?#\s]+)\/*$/i.exec(trimmed);
  const canonical = root ? canonicalAddress(root[1]) : null;
  if (canonical !== null) {
    return { url: canonical, aliases: value === canonical ? [] : [value] };
  }
  return { url: value, aliases: [], issue: 'invalid-legacy-url' };
}

/** Recompute URL collisions without merging records or changing their IDs. */
export function recomputeSavedServerCollisions(entries: SavedServer[]): SavedServer[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const canonical = canonicalAddress(entry.url);
    if (canonical !== null && canonical === entry.url) counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
  }
  return entries.map((entry) => {
    const canonical = canonicalAddress(entry.url);
    if (canonical === null || canonical !== entry.url) {
      return { ...entry, status: 'needs-edit', issue: entry.issue ?? 'invalid-legacy-url' };
    }
    if ((counts.get(canonical) ?? 0) > 1) {
      return { ...entry, status: 'collision' };
    }
    return { ...entry, status: entry.issue ? 'needs-edit' : 'ready' };
  });
}

function assertJsonValue(value: unknown, parents = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || parents.has(value)) throw new SavedServerModelError('invalid-saved-server-schema');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new SavedServerModelError('invalid-saved-server-schema');
  }
  parents.add(value);
  for (const item of Object.values(value)) assertJsonValue(item, parents);
  parents.delete(value);
}

function assertRegistry(value: unknown): asserts value is SavedServerRegistry {
  const registry = objectOf(value);
  if (!registry) throw new SavedServerModelError('invalid-saved-server-schema');
  if (registry.version !== SAVED_SERVER_SCHEMA_VERSION) {
    throw new SavedServerModelError('unsupported-saved-server-schema');
  }
  const sources = objectOf(registry.legacySources);
  if (!Array.isArray(registry.savedServers) || !sources
    || !(sources.stateRaw === null || typeof sources.stateRaw === 'string')
    || !(sources.urlRaw === null || typeof sources.urlRaw === 'string')) {
    throw new SavedServerModelError('invalid-saved-server-schema');
  }
  const ids = new Set<string>();
  for (const value of registry.savedServers) {
    const entry = objectOf(value);
    if (!entry || !validIdentifier(entry.id) || ids.has(entry.id)
      || typeof entry.url !== 'string' || typeof entry.title !== 'string' || typeof entry.addedAt !== 'string'
      || !validIdentifier(entry.entryRevision) || !['ready', 'needs-edit', 'collision'].includes(String(entry.status))
      || (hasOwn(entry, 'displayName') && !validateDisplayName(entry.displayName))
      || (hasOwn(entry, 'issue') && !validIdentifier(entry.issue))
      || !Array.isArray(entry.legacyAliases) || entry.legacyAliases.some((alias) => typeof alias !== 'string')
      || !Array.isArray(entry.originals)) {
      throw new SavedServerModelError('invalid-saved-server-schema');
    }
    ids.add(entry.id);
    for (const value of entry.originals) {
      const original = objectOf(value);
      if (!original || !validIdentifier(original.source)
        || !(original.index === null || Number.isSafeInteger(original.index) && (original.index as number) >= 0)
        || !hasOwn(original, 'rawUrl') || !hasOwn(original, 'record')) {
        throw new SavedServerModelError('invalid-saved-server-schema');
      }
    }
  }
  const entries = registry.savedServers as SavedServer[];
  const computed = recomputeSavedServerCollisions(entries);
  if (entries.some((entry, index) => entry.status !== computed[index].status || entry.issue !== computed[index].issue)) {
    throw new SavedServerModelError('invalid-saved-server-schema');
  }
  assertJsonValue(value);
}

/** Unknown versions and malformed v2 data are never silently migrated/repaired. */
export function parseSavedServerRegistry(raw: string): SavedServerRegistry {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new SavedServerModelError('invalid-saved-server-schema'); }
  assertRegistry(value);
  return value;
}

export function serializeSavedServerRegistry(registry: SavedServerRegistry): string {
  assertRegistry(registry);
  return JSON.stringify(registry);
}

/**
 * The repository persists this result before exposing generated IDs as stable.
 * Originals are archival material, never credentials or runtime server state.
 */
export function migrateSavedServerRegistry(
  sources: LegacyServerSources,
  dependencies: SavedServerMigrationDependencies,
): SavedServerRegistry {
  if (!(sources.stateRaw === null || typeof sources.stateRaw === 'string')
    || !(sources.urlRaw === null || typeof sources.urlRaw === 'string')) {
    throw new SavedServerModelError('invalid-legacy-sources');
  }
  const entries: SavedServer[] = [];
  const ids = new Set<string>();
  const reservedLegacyIds = new Set<string>();
  const duplicateIds = new Set<string>();
  const timestamp = dependencies.now();
  if (typeof timestamp !== 'string') throw new SavedServerModelError('invalid-migration-time');
  const nextId = () => {
    for (let attempt = 0; attempt < 64; attempt++) {
      const id = dependencies.createId();
      if (validIdentifier(id) && !ids.has(id) && !reservedLegacyIds.has(id)) return id;
    }
    throw new SavedServerModelError('saved-server-id-unavailable');
  };
  const append = (record: unknown, rawUrl: unknown, source: string, index: number | null, forcedIssue?: string) => {
    const old = objectOf(record);
    const existingId = old?.id;
    let id: string;
    if (validIdentifier(existingId) && !ids.has(existingId)) id = existingId;
    else {
      if (validIdentifier(existingId)) duplicateIds.add(existingId);
      id = nextId();
    }
    ids.add(id);
    const address = legacyAddress(rawUrl);
    const displayName = old && hasOwn(old, 'displayName') ? old.displayName : undefined;
    const issue = forcedIssue ?? address.issue
      ?? (displayName !== undefined && !validateDisplayName(displayName) ? 'invalid-display-name' : undefined);
    const entry: SavedServer = {
      id, url: address.url, title: typeof old?.title === 'string' ? old.title
        : typeof old?.serverTitle === 'string' ? old.serverTitle : '',
      addedAt: typeof old?.addedAt === 'string' ? old.addedAt : timestamp,
      entryRevision: nextId(), status: issue ? 'needs-edit' : 'ready',
      legacyAliases: address.aliases, originals: [{ source, index, rawUrl, record }],
      ...(issue ? { issue } : {}),
      ...(validateDisplayName(displayName) ? { displayName } : {}),
    };
    entries.push(entry);
    return entry;
  };

  let parsed: unknown = null;
  let parsedSuccessfully = false;
  if (sources.stateRaw !== null) {
    try { parsed = JSON.parse(sources.stateRaw); parsedSuccessfully = true; } catch { /* Preserve malformed source below. */ }
    const document = objectOf(parsed);
    if (document && document.version !== undefined && document.version !== 0 && document.version !== 1) {
      throw new SavedServerModelError('unsupported-legacy-schema');
    }
    const state = objectOf(document?.state);
    if (parsedSuccessfully && state) {
      if (document?.version === 1) {
        if (Array.isArray(state.savedServers)) {
          for (const record of state.savedServers) {
            const id = objectOf(record)?.id;
            if (validIdentifier(id)) reservedLegacyIds.add(id);
          }
          state.savedServers.forEach((record, index) => append(record, objectOf(record)?.url ?? null, 'moke-server-storage', index));
        } else append(parsed, null, 'moke-server-storage', null, 'invalid-legacy-list');
      } else if (hasOwn(state, 'serverUrl') && state.serverUrl !== '') {
        append(state, state.serverUrl, 'moke-server-storage', null);
      } else if (!hasOwn(state, 'serverUrl') && Object.keys(state).length > 0) {
        append(state, null, 'moke-server-storage', null, 'invalid-legacy-record');
      }
    } else append(parsedSuccessfully ? parsed : sources.stateRaw, null, 'moke-server-storage', null, 'invalid-legacy-record');
  }

  if (sources.urlRaw !== null && sources.urlRaw !== '') {
    const address = legacyAddress(sources.urlRaw);
    const matches = address.issue ? [] : entries.filter((entry) => entry.url === address.url);
    if (matches.length === 1) {
      matches[0].originals.push({ source: 'moke_server_url', index: null, rawUrl: sources.urlRaw, record: sources.urlRaw });
      if (sources.urlRaw !== matches[0].url && !matches[0].legacyAliases.includes(sources.urlRaw)) {
        matches[0].legacyAliases.push(sources.urlRaw);
      }
    } else append(sources.urlRaw, sources.urlRaw, 'moke_server_url', null);
  }
  for (const entry of entries) {
    const originalId = objectOf(entry.originals[0]?.record)?.id;
    if (typeof originalId === 'string' && duplicateIds.has(originalId)) entry.issue = 'duplicate-legacy-id';
  }
  const registry: SavedServerRegistry = {
    version: SAVED_SERVER_SCHEMA_VERSION,
    savedServers: recomputeSavedServerCollisions(entries),
    legacySources: { ...sources },
  };
  assertRegistry(registry);
  return registry;
}
