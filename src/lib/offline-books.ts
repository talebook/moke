'use client';

import { debugLog } from './debug-log.ts';
import {
  hasEpubCentralDirectory,
  makeOfflineBookKey,
  makeOfflineRelativePath,
  normalizeOfflineFormat,
  sanitizeOfflineFileName,
} from './offline-book-core.ts';

const DB_NAME = 'moke-offline-books';
const STORE_NAME = 'books';
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

interface NativeOfflineBookRecord {
  id: string;
  serverUrl: string;
  bookId: string;
  title: string;
  fileName: string;
  mimeType: string;
  updatedAt: number;
  filePath: string;
  relativePath?: string;
  storageRoot?: string;
}

function openDatabase(): Promise<IDBDatabase> {
  const owner = window.indexedDB;
  if (databaseOwner === owner && databasePromise) return databasePromise;
  databaseOwner = owner;
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    // 不指定版本：当前逻辑只依赖 books store，不需要执行 schema 升级。
    // 这样既能创建全新数据库，也能打开已有 v2（或更高）数据库，避免 VersionError。
    const request = owner.open(DB_NAME);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
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

async function putOfflineBookRecord(record: OfflineBookRecord): Promise<void> {
  const db = await openDatabase();
  await requestResult(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record));
}

function sameServer(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
  }
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
    .filter((record) => !serverUrl || sameServer(record.serverUrl, serverUrl))
    .map((record) => ({ ...record, format: formatFromRecord(record), size: record.size ?? record.blob?.size ?? 0 }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function getOfflineBook(
  serverUrl: string,
  bookId: string,
  format?: string,
): Promise<OfflineBookRecord | null> {
  let indexedRecord: OfflineBookRecord | null = null;
  try {
    if (format) {
      indexedRecord = await getById(makeOfflineBookKey(serverUrl, bookId, format));
      if (!indexedRecord) {
        const legacy = await getById(makeOfflineBookKey(serverUrl, bookId));
        if (legacy && formatFromRecord(legacy) === normalizeOfflineFormat(format)) {
          await commitOfflineBookRecord({ ...legacy, format: normalizeOfflineFormat(format) });
          await deleteRecordOnly(legacy.id);
          indexedRecord = await getById(makeOfflineBookKey(serverUrl, bookId, format));
        }
      }
    } else {
      const records = await listOfflineBooks(serverUrl);
      indexedRecord = records.find((record) => record.bookId === bookId)
        ?? await getById(makeOfflineBookKey(serverUrl, bookId));
    }
  } catch (error) {
    if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') throw error;
    debugLog('warn', 'download', '读取 WebView 离线书记录失败，尝试从原生索引恢复', String(error));
  }

  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') {
    return indexedRecord
      ? { ...indexedRecord, format: formatFromRecord(indexedRecord), size: indexedRecord.size ?? indexedRecord.blob?.size ?? 0 }
      : null;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const nativeRecords = await invoke<NativeOfflineBookRecord[]>('moke_list_downloaded_books');
    const wantedFormat = format ? normalizeOfflineFormat(format) : undefined;
    const nativeRecord = nativeRecords.find((record) => (
      record.bookId === bookId
      && sameServer(record.serverUrl, serverUrl)
      && (!wantedFormat || formatFromRecord(record) === wantedFormat)
    )) ?? (indexedRecord
      ? nativeRecords.find((record) => record.fileName === indexedRecord.fileName)
      : undefined);
    if (!nativeRecord) return null;

    const recovered: OfflineBookRecord = {
      ...indexedRecord,
      id: nativeRecord.id || indexedRecord?.id || makeOfflineBookKey(serverUrl, bookId, formatFromRecord(nativeRecord)),
      serverUrl,
      bookId,
      format: formatFromRecord(nativeRecord),
      title: nativeRecord.title || indexedRecord?.title || '',
      fileName: nativeRecord.fileName,
      mimeType: nativeRecord.mimeType || indexedRecord?.mimeType || 'application/octet-stream',
      size: indexedRecord?.size ?? 0,
      updatedAt: nativeRecord.updatedAt,
      filePath: nativeRecord.filePath,
      relativePath: nativeRecord.relativePath || indexedRecord?.relativePath,
      storageRoot: nativeRecord.storageRoot || indexedRecord?.storageRoot,
    };
    try { await putOfflineBookRecord(recovered); } catch (error) {
      debugLog('warn', 'download', '原生离线书已恢复，但写回 WebView 记录失败', String(error));
    }
    return recovered;
  } catch (error) {
    debugLog('warn', 'download', '读取原生离线书索引失败，回退到 WebView 记录', String(error));
    return indexedRecord;
  }
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
}): Promise<{ writer: OfflineFileWriter; filePath: string; partialPath: string; relativePath: string }> {
  const { open, mkdir, stat } = await import('@tauri-apps/plugin-fs');
  const { dirname } = await import('@tauri-apps/api/path');
  const { filePath, relativePath } = await resolveOfflineBookFilePath(input);
  const partialPath = `${filePath}.part`;
  const parent = await dirname(filePath);
  await mkdir(parent, { recursive: true });

  let position = 0;
  if (input.resume) {
    try { position = Number((await stat(partialPath)).size); } catch { position = 0; }
  }
  const file = await open(partialPath, { write: true, create: true, append: position > 0, truncate: position === 0 });
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
  return { writer, filePath, partialPath, relativePath };
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
  try { await removeDiskFile(`${filePath}.part`); } catch { /* already absent */ }
}

async function replaceOfflineBookFile(partialPath: string, filePath: string): Promise<{
  backupPath: string;
  rollback: () => Promise<void>;
}> {
  const { exists, remove, rename } = await import('@tauri-apps/plugin-fs');
  const backupPath = `${partialPath}.backup`;
  if (await exists(backupPath)) {
    if (await exists(filePath)) await remove(backupPath);
    else await rename(backupPath, filePath);
  }
  const hadPreviousFile = await exists(filePath);

  if (hadPreviousFile) await rename(filePath, backupPath);

  try {
    await rename(partialPath, filePath);
  } catch (error) {
    if (hadPreviousFile) {
      try {
        await rename(backupPath, filePath);
      } catch {
        // 交给外层记录原始安装失败；备份仍留在磁盘，避免静默丢失。
      }
    }
    throw error;
  }

  return {
    backupPath,
    rollback: async () => {
      try { await remove(filePath); } catch { /* ignore */ }
      if (hadPreviousFile) await rename(backupPath, filePath);
    },
  };
}

export function shouldPreserveOfflinePartial(error: unknown, enabled?: boolean): boolean {
  if (!enabled) return false;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message === 'book.download.incomplete'
    || message === 'book.download.transfer_failed'
    || /^http\.(408|429|5\d\d)$/.test(message);
}

export async function saveOfflineBookStream(input: {
  serverUrl: string; bookId: string; title: string; fileName: string; mimeType: string; format?: string;
  sourceSignature?: string; downloadDirectory?: string | null; resume?: boolean; preservePartialOnFailure?: boolean;
  write: (writer: OfflineFileWriter) => Promise<string | void | { mimeType?: string; size?: number; sourceSignature?: string }>;
}): Promise<void> {
  const fileName = sanitizeOfflineFileName(input.fileName);
  const format = normalizeOfflineFormat(input.format || fileName.split('.').pop() || 'epub');
  const previous = await getOfflineBook(input.serverUrl, input.bookId, format);
  let writer: OfflineFileWriter | null = null;
  let filePath: string | undefined;
  let partialPath: string | undefined;
  let relativePath: string | undefined;
  let replacement: Awaited<ReturnType<typeof replaceOfflineBookFile>> | null = null;
  try {
    const handle = await openOfflineBookFile({ ...input, fileName, format, resume: Boolean(input.resume) });
    writer = handle.writer;
    filePath = handle.filePath;
    partialPath = handle.partialPath;
    relativePath = handle.relativePath;
    const result = await input.write(writer);
    const details = typeof result === 'string' ? { mimeType: result } : result || {};
    const size = details.size ?? writer.position;
    await writer.close();
    writer = null;
    if (format === 'epub' && !(await validateDiskEpub(partialPath))) throw new Error('book.epub.invalid');
    replacement = await replaceOfflineBookFile(partialPath, filePath);
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
    // 索引已经提交，旧文件备份不再需要。
    const { remove } = await import('@tauri-apps/plugin-fs');
    try { await remove(replacement.backupPath); } catch { /* no previous file or best-effort cleanup */ }
    replacement = null;
  } catch (error) {
    try { if (writer) await writer.close(); } catch { /* ignore */ }
    if (replacement) {
      try { await replacement.rollback(); } catch { /* preserve backup for manual recovery */ }
    } else if (partialPath && !shouldPreserveOfflinePartial(error, input.preservePartialOnFailure)) {
      try { await removeDiskFile(partialPath); } catch { /* best effort */ }
    }
    if (error instanceof DOMException || error instanceof TypeError) throw error;
    if (error instanceof Error && (error.message.startsWith('book.') || error.message.startsWith('http.'))) throw error;
    debugLog(
      'error',
      'download',
      '✗ 创建、关闭或登记离线书籍文件失败',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
    throw new Error('book.download.storage_failed');
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
  await putOfflineBookRecord(record);
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
