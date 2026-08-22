'use client';

import {
  hasEpubCentralDirectory,
  makeOfflineBookKey,
  makeOfflineRelativePath,
  normalizeOfflineFormat,
  sanitizeOfflineFileName,
} from './offline-book-core.ts';

const DB_NAME = 'moke-offline-books';
const STORE_NAME = 'books';
const DB_VERSION = 2;
const EPUB_TAIL_WINDOW = 22 + 0xffff + 4096;
let databaseOwner: IDBFactory | undefined;
let databasePromise: Promise<IDBDatabase> | undefined;

export interface OfflineBookRecord {
  id: string;
  serverUrl: string;
  bookId: string;
  format: string;
  title: string;
  fileName: string;
  mimeType: string;
  blob?: Blob;
  size: number;
  updatedAt: number;
  sourceSignature?: string;
  filePath?: string;
  relativePath?: string;
  storageRoot?: string;
}

function formatFromRecord(record: Partial<OfflineBookRecord>): string {
  return normalizeOfflineFormat(record.format || record.fileName?.split('.').pop() || 'epub');
}

function openDatabase(): Promise<IDBDatabase> {
  const owner = window.indexedDB;
  if (databaseOwner === owner && databasePromise) return databasePromise;
  databaseOwner = owner;
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = owner.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        return;
      }

      // v1 used server + book as the key. Migrate in the same upgrade transaction,
      // deriving format from the old filename so existing downloads remain visible.
      const transaction = request.transaction;
      const store = transaction?.objectStore(STORE_NAME);
      if (!store || typeof store.openCursor !== 'function') return;
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const old = cursor.value as OfflineBookRecord;
        if (!old.format || old.id === makeOfflineBookKey(old.serverUrl, old.bookId)) {
          const format = formatFromRecord(old);
          const migrated = {
            ...old,
            id: makeOfflineBookKey(old.serverUrl, old.bookId, format),
            format,
            size: old.size ?? old.blob?.size ?? 0,
          };
          store.put(migrated);
          if (migrated.id !== old.id) cursor.delete();
        }
        cursor.continue();
      };
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        if (databaseOwner === owner && databasePromise === promise) databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      if (databaseOwner === owner && databasePromise === promise) databasePromise = undefined;
      reject(request.error);
    };
  });
  databasePromise = promise;
  return promise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getById(id: string): Promise<OfflineBookRecord | null> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_NAME, 'readonly');
  return (await requestResult(transaction.objectStore(STORE_NAME).get(id))) ?? null;
}

export async function listOfflineBooks(serverUrl?: string): Promise<OfflineBookRecord[]> {
  const db = await openDatabase();
  const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
  let records: OfflineBookRecord[];
  if (typeof store.getAll === 'function') {
    records = await requestResult(store.getAll()) as OfflineBookRecord[];
  } else {
    records = [];
  }
  return records
    .filter((record) => !serverUrl || record.serverUrl === serverUrl)
    .map((record) => ({ ...record, format: formatFromRecord(record), size: record.size ?? record.blob?.size ?? 0 }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function getOfflineBook(
  serverUrl: string,
  bookId: string,
  format?: string,
): Promise<OfflineBookRecord | null> {
  if (format) {
    const current = await getById(makeOfflineBookKey(serverUrl, bookId, format));
    if (current) return { ...current, format: formatFromRecord(current), size: current.size ?? current.blob?.size ?? 0 };
    const legacy = await getById(makeOfflineBookKey(serverUrl, bookId));
    if (legacy && formatFromRecord(legacy) === normalizeOfflineFormat(format)) {
      await commitOfflineBookRecord({ ...legacy, format: normalizeOfflineFormat(format) });
      await deleteRecordOnly(legacy.id);
      return getById(makeOfflineBookKey(serverUrl, bookId, format));
    }
    return null;
  }
  const records = await listOfflineBooks(serverUrl);
  return records.find((record) => record.bookId === bookId) ?? await getById(makeOfflineBookKey(serverUrl, bookId));
}

async function deleteRecordOnly(id: string): Promise<void> {
  const db = await openDatabase();
  const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
  await requestResult(store.delete(id));
}

async function removeDiskFile(filePath: string): Promise<void> {
  const { remove, exists } = await import('@tauri-apps/plugin-fs');
  try {
    await remove(filePath);
  } catch {
    let stillThere = true;
    try { stillThere = await exists(filePath); } catch { /* conservatively retain */ }
    if (stillThere) throw new Error('Failed to delete book file');
  }
}

export async function syncOfflineDownloadState(serverUrl: string, bookId: string, downloaded: boolean): Promise<void> {
  const { request } = await import('@/lib/api');
  const response = await request(`${serverUrl}/api/book/${bookId}/readstate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ download: downloaded ? 1 : 0 }),
  });
  if (!response.ok) throw new Error(`http.${response.status}`);
}

export async function deleteOfflineBook(
  serverUrl: string,
  bookId: string,
  format?: string,
): Promise<{ remoteSynced: boolean; remoteError?: unknown }> {
  const records = format
    ? [await getOfflineBook(serverUrl, bookId, format)].filter(Boolean) as OfflineBookRecord[]
    : (await listOfflineBooks(serverUrl)).filter((record) => record.bookId === bookId);

  for (const record of records) {
    if (record.filePath && process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') await removeDiskFile(record.filePath);
    await deleteRecordOnly(record.id);
    if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('moke_remove_downloaded_book', { id: record.id });
      } catch (error) {
        console.warn('Failed to update Moke downloaded-books index:', error);
      }
    }
  }

  // Only clear the server flag when no other local format remains.
  if ((await listOfflineBooks(serverUrl)).some((record) => record.bookId === bookId)) return { remoteSynced: true };
  try {
    await syncOfflineDownloadState(serverUrl, bookId, false);
    return { remoteSynced: true };
  } catch (remoteError) {
    return { remoteSynced: false, remoteError };
  }
}

export async function saveOfflineBook(input: {
  serverUrl: string; bookId: string; title: string; fileName: string; mimeType: string; blob: Blob;
  format?: string; sourceSignature?: string; downloadDirectory?: string | null;
}): Promise<void> {
  const fileName = sanitizeOfflineFileName(input.fileName);
  const format = normalizeOfflineFormat(input.format || fileName.split('.').pop() || 'epub');
  if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
    await saveOfflineBookStream({
      ...input,
      format,
      fileName,
      write: async (writer) => {
        const reader = input.blob.stream().getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) await writer.write(value);
          }
        } finally { reader.releaseLock(); }
        return { mimeType: input.mimeType, size: input.blob.size, sourceSignature: input.sourceSignature };
      },
    });
    return;
  }
  await commitOfflineBookRecord({ ...input, format, fileName, size: input.blob.size });
}

export interface OfflineFileWriter {
  readonly position: number;
  write(data: Uint8Array): Promise<void>;
  truncate(): Promise<void>;
  close(): Promise<void>;
}

async function resolveOfflineBookFilePath(input: {
  serverUrl: string; bookId: string; format: string; fileName: string;
  downloadDirectory?: string | null;
}): Promise<{ filePath: string; relativePath: string }> {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const relativePath = makeOfflineRelativePath(input.serverUrl, input.bookId, input.format, input.fileName);
  const custom = input.downloadDirectory || null;
  const filePath = custom ? await join(custom, ...relativePath.split('/').slice(1)) : await join(await appDataDir(), ...relativePath.split('/'));
  return { filePath, relativePath };
}

async function openOfflineBookFile(input: {
  serverUrl: string; bookId: string; format: string; fileName: string;
  downloadDirectory?: string | null; resume: boolean;
}): Promise<{ writer: OfflineFileWriter; filePath: string; relativePath: string }> {
  const { open, mkdir, stat } = await import('@tauri-apps/plugin-fs');
  const { dirname } = await import('@tauri-apps/api/path');
  const { filePath, relativePath } = await resolveOfflineBookFilePath(input);
  const parent = await dirname(filePath);
  await mkdir(parent, { recursive: true });

  let position = 0;
  if (input.resume) {
    try { position = Number((await stat(filePath)).size); } catch { position = 0; }
  }
  const file = await open(filePath, { write: true, create: true, append: position > 0, truncate: position === 0 });
  const writer: OfflineFileWriter = {
    get position() { return position; },
    async write(data) { await file.write(data); position += data.length; },
    async truncate() {
      await file.truncate(0);
      await file.seek(0, 0);
      position = 0;
    },
    async close() { await file.close(); },
  };
  return { writer, filePath, relativePath };
}

async function validateDiskEpub(filePath: string): Promise<boolean> {
  const { open, stat } = await import('@tauri-apps/plugin-fs');
  const size = Number((await stat(filePath)).size);
  const length = Math.min(size, EPUB_TAIL_WINDOW);
  const file = await open(filePath, { read: true });
  try {
    await file.seek(Math.max(0, size - length), 0);
    const tail = new Uint8Array(length);
    const count = await file.read(tail);
    return hasEpubCentralDirectory(new Blob([tail.subarray(0, count ?? 0)]));
  } finally { await file.close(); }
}

export async function removeOfflinePartial(input: {
  serverUrl: string; bookId: string; format: string; title: string; downloadDirectory?: string | null;
}): Promise<void> {
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return;
  const { filePath } = await resolveOfflineBookFilePath({
    ...input,
    fileName: `${input.title}.${input.format}`,
  });
  try { await removeDiskFile(filePath); } catch { /* already absent */ }
}

export async function saveOfflineBookStream(input: {
  serverUrl: string; bookId: string; title: string; fileName: string; mimeType: string; format?: string;
  sourceSignature?: string; downloadDirectory?: string | null; resume?: boolean; preservePartialOnAbort?: boolean;
  write: (writer: OfflineFileWriter) => Promise<string | void | { mimeType?: string; size?: number; sourceSignature?: string }>;
}): Promise<void> {
  const fileName = sanitizeOfflineFileName(input.fileName);
  const format = normalizeOfflineFormat(input.format || fileName.split('.').pop() || 'epub');
  const previous = await getOfflineBook(input.serverUrl, input.bookId, format);
  let writer: OfflineFileWriter | null = null;
  let filePath: string | undefined;
  let relativePath: string | undefined;
  try {
    const handle = await openOfflineBookFile({ ...input, fileName, format, resume: Boolean(input.resume) });
    writer = handle.writer;
    filePath = handle.filePath;
    relativePath = handle.relativePath;
    const result = await input.write(writer);
    const details = typeof result === 'string' ? { mimeType: result } : result || {};
    const size = details.size ?? writer.position;
    await writer.close();
    writer = null;
    if (format === 'epub' && !(await validateDiskEpub(filePath))) throw new Error('book.epub.invalid');
    await commitOfflineBookRecord({
      ...input,
      format,
      fileName,
      mimeType: details.mimeType || input.mimeType,
      size,
      sourceSignature: details.sourceSignature || input.sourceSignature,
      filePath,
      relativePath,
      storageRoot: input.downloadDirectory || undefined,
    });
  } catch (error) {
    try { if (writer) await writer.close(); } catch { /* ignore */ }
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    if (filePath && !(aborted && input.preservePartialOnAbort)) {
      try { await removeDiskFile(filePath); } catch { /* best effort */ }
    }
    throw error;
  }
  if (previous?.filePath && filePath && previous.filePath !== filePath) {
    try { await removeDiskFile(previous.filePath); } catch (error) { console.warn('Failed to remove stale offline book file:', error); }
  }
}

async function commitOfflineBookRecord(input: {
  serverUrl: string; bookId: string; format: string; title: string; fileName: string; mimeType: string;
  size?: number; blob?: Blob; updatedAt?: number; sourceSignature?: string; filePath?: string; relativePath?: string;
  storageRoot?: string;
}): Promise<void> {
  const db = await openDatabase();
  const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';
  const record: OfflineBookRecord = {
    id: makeOfflineBookKey(input.serverUrl, input.bookId, input.format),
    serverUrl: input.serverUrl,
    bookId: input.bookId,
    format: normalizeOfflineFormat(input.format),
    title: input.title,
    fileName: input.fileName,
    mimeType: input.mimeType,
    blob: isTauriApp ? undefined : input.blob,
    size: input.size ?? input.blob?.size ?? 0,
    updatedAt: input.updatedAt ?? Date.now(),
    sourceSignature: input.sourceSignature,
    filePath: input.filePath,
    relativePath: input.relativePath,
    storageRoot: input.storageRoot,
  };
  const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
  await requestResult(store.put(record));
  if (isTauriApp) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('moke_record_downloaded_book', { book: {
        id: record.id, serverUrl: record.serverUrl, bookId: record.bookId, title: record.title,
        fileName: record.fileName, relativePath: record.relativePath, storageRoot: record.storageRoot,
        mimeType: record.mimeType, updatedAt: record.updatedAt,
      } });
    } catch (error) { console.warn('Failed to update Moke downloaded-books index:', error); }
  }
}
