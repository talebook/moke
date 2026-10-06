'use client';

import {
  safeGetLocalStorageItem,
  safeSetLocalStorageItem,
} from './browser-storage.ts';

export const CONTINUE_READING_CHANGED_EVENT = 'moke:continue-reading-changed';
export const CONTINUE_READING_NATIVE_EVENT = 'moke:continue-reading-request';

const STORAGE_KEY = 'moke-continue-reading';
const STORAGE_VERSION = 2;

export type ContinueReadingMode = 'online' | 'offline';

export interface ContinueReadingEntry {
  serverUrl: string;
  mode: ContinueReadingMode;
  bookId: string;
  title?: string;
  author?: string;
  cover?: string;
  format?: string;
  progress?: number;
  page?: number;
  totalPages?: number;
  updatedAt: number;
}

interface ContinueReadingStorage {
  version: number;
  entries: Record<string, ContinueReadingEntry>;
}

interface StorageLike {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
}

export interface ReadingHistoryItem {
  id?: string | number;
  title?: string;
  author?: string;
  authors?: string[] | Array<{ name?: string }>;
  img?: string;
  thumb?: string;
  timestamp?: number | string;
  files?: Array<{ format?: string }>;
}

type RequestLike = (url: string, init?: RequestInit) => Promise<Response>;

function defaultStorage(): StorageLike {
  return {
    getItem: safeGetLocalStorageItem,
    setItem: safeSetLocalStorageItem,
  };
}

export function continueReadingScope(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin.toLowerCase();
  } catch {
    return serverUrl.trim().replace(/\/+$/, '').toLowerCase();
  }
}

function continueReadingStorageKey(serverUrl: string, mode: ContinueReadingMode): string {
  if (mode === 'offline') return '__offline__';
  return `${continueReadingScope(serverUrl)}::${mode}`;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeEntry(value: unknown): ContinueReadingEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ContinueReadingEntry>;
  const serverUrl = nonEmptyString(candidate.serverUrl);
  const rawBookId = (candidate as { bookId?: unknown }).bookId;
  const bookId = typeof rawBookId === 'number' ? String(rawBookId) : nonEmptyString(rawBookId);
  const mode: ContinueReadingMode = candidate.mode === 'offline' ? 'offline' : 'online';
  const updatedAt = finiteNumber(candidate.updatedAt);
  if (!serverUrl || !bookId || updatedAt === undefined || updatedAt <= 0) return null;

  return {
    serverUrl,
    mode,
    bookId,
    title: nonEmptyString(candidate.title),
    author: nonEmptyString(candidate.author),
    cover: nonEmptyString(candidate.cover),
    format: nonEmptyString(candidate.format)?.toLowerCase(),
    progress: finiteNumber(candidate.progress),
    page: finiteNumber(candidate.page),
    totalPages: finiteNumber(candidate.totalPages),
    updatedAt,
  };
}

function readStorage(storage: StorageLike): ContinueReadingStorage {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}') as Partial<ContinueReadingStorage>;
    const entries: Record<string, ContinueReadingEntry> = {};
    if (parsed.entries && typeof parsed.entries === 'object') {
      for (const value of Object.values(parsed.entries)) {
        const entry = normalizeEntry(value);
        if (entry) entries[continueReadingStorageKey(entry.serverUrl, entry.mode)] = entry;
      }
    }
    return { version: STORAGE_VERSION, entries };
  } catch {
    return { version: STORAGE_VERSION, entries: {} };
  }
}

export function getContinueReading(
  serverUrl: string,
  mode: ContinueReadingMode = 'online',
  storage: StorageLike = defaultStorage(),
): ContinueReadingEntry | null {
  if (!serverUrl && mode === 'online') return null;
  return readStorage(storage).entries[continueReadingStorageKey(serverUrl, mode)] ?? null;
}

export function rememberContinueReading(
  update: Omit<ContinueReadingEntry, 'updatedAt' | 'mode'> & {
    mode?: ContinueReadingMode;
    updatedAt?: number;
  },
  storage: StorageLike = defaultStorage(),
): ContinueReadingEntry | null {
  const mode: ContinueReadingMode = update.mode === 'offline' ? 'offline' : 'online';
  const scope = continueReadingStorageKey(update.serverUrl, mode);
  const bookId = String(update.bookId).trim();
  if (!scope || !bookId) return null;

  const state = readStorage(storage);
  const previous = state.entries[scope];
  const sameBook = previous?.bookId === bookId ? previous : undefined;
  const entry = normalizeEntry({
    ...sameBook,
    ...update,
    mode,
    bookId,
    updatedAt: update.updatedAt ?? Date.now(),
  });
  if (!entry) return null;

  state.entries[scope] = entry;
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CONTINUE_READING_CHANGED_EVENT, { detail: entry }));
  }
  return entry;
}

export function continueReadingHref(
  entry: Pick<ContinueReadingEntry, 'bookId'> & Partial<Pick<ContinueReadingEntry, 'mode' | 'serverUrl'>>,
): string {
  const params = new URLSearchParams({ id: entry.bookId, continue: '1' });
  if (entry.mode === 'offline' && entry.serverUrl) params.set('source', entry.serverUrl);
  return `/detail?${params.toString()}`;
}

function historyTimestamp(value: unknown, fallback: number): number {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) return fallback;
  return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
}

function historyAuthor(item: ReadingHistoryItem): string | undefined {
  if (nonEmptyString(item.author)) return nonEmptyString(item.author);
  if (!Array.isArray(item.authors)) return undefined;
  const names = item.authors
    .map((author) => typeof author === 'string' ? author : author?.name)
    .map(nonEmptyString)
    .filter((name): name is string => Boolean(name));
  return names.length ? names.join('、') : undefined;
}

export function latestContinueReadingFromHistory(
  serverUrl: string,
  items: ReadingHistoryItem[],
  now: number = Date.now(),
): ContinueReadingEntry | null {
  const candidates: ContinueReadingEntry[] = [];
  items.forEach((item, index) => {
    if (item.id === undefined || item.id === null || String(item.id).trim() === '') return;
    candidates.push({
      serverUrl,
      mode: 'online',
      bookId: String(item.id),
      title: nonEmptyString(item.title),
      author: historyAuthor(item),
      cover: nonEmptyString(item.img) || nonEmptyString(item.thumb),
      format: nonEmptyString(item.files?.[0]?.format)?.toLowerCase(),
      updatedAt: historyTimestamp(item.timestamp, now - index),
    });
  });

  return candidates.sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}

export async function fetchContinueReadingFromHistory(
  requestLike: RequestLike,
  serverUrl: string,
  signal?: AbortSignal,
): Promise<ContinueReadingEntry | null> {
  if (!serverUrl) return null;
  const response = await requestLike(`${serverUrl}/api/user/info?detail=1`, {
    credentials: 'include',
    signal,
  });
  if (!response.ok) return null;
  const data = await response.json() as {
    err?: string;
    user?: { extra?: { read_history?: ReadingHistoryItem[] } };
  };
  if (data.err !== 'ok') return null;
  const history = data.user?.extra?.read_history;
  if (!Array.isArray(history)) return null;
  return latestContinueReadingFromHistory(serverUrl, history);
}

export async function resolveContinueReading(
  requestLike: RequestLike,
  serverUrl: string,
  signal?: AbortSignal,
): Promise<ContinueReadingEntry | null> {
  const local = getContinueReading(serverUrl, 'online');
  if (local) return local;
  const remote = await fetchContinueReadingFromHistory(requestLike, serverUrl, signal);
  return remote ? rememberContinueReading(remote) : null;
}
