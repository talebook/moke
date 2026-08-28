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
  author?: string;
  coverDataUrl?: string;
  inShelf?: boolean;
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
  author?: string;
  inShelf?: boolean;
  fileName: string;
  mimeType: string;
  updatedAt: number;
  filePath: string;
  relativePath?: string;
  storageRoot?: string;
  fileSize?: number;
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
  if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const nativeRecords = await invoke<NativeOfflineBookRecord[]>('moke_list_downloaded_books');
      const indexedById = new Map(records.map((record) => [record.id, record]));
      records = nativeRecords.map((nativeRecord) => {
        const indexed = indexedById.get(nativeRecord.id);
        const recovered: OfflineBookRecord = {
          ...indexed,
          id: nativeRecord.id,
          serverUrl: nativeRecord.serverUrl,
          bookId: nativeRecord.bookId || nativeRecord.id,
          format: formatFromRecord(nativeRecord),
          title: nativeRecord.title || indexed?.title || nativeRecord.fileName,
          author: nativeRecord.author || indexed?.author,
          inShelf: nativeRecord.inShelf ?? indexed?.inShelf,
          fileName: nativeRecord.fileName,
          mimeType: nativeRecord.mimeType || indexed?.mimeType || 'application/octet-stream',
          size: nativeRecord.fileSize ?? indexed?.size ?? 0,
          updatedAt: nativeRecord.updatedAt,
          filePath: nativeRecord.filePath,
          relativePath: nativeRecord.relativePath || indexed?.relativePath,
          storageRoot: nativeRecord.storageRoot || indexed?.storageRoot,
        };
        void putOfflineBookRecord(recovered).catch(() => undefined);
        return recovered;
      });
    } catch (error) {
      debugLog('warn', 'download', '读取原生离线书库失败，使用 WebView 索引', String(error));
    }
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
      author: nativeRecord.author || indexedRecord?.author,
      inShelf: nativeRecord.inShelf ?? indexedRecord?.inShelf,
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

export async function setOfflineBookShelfState(
  serverUrl: string,
  bookId: string,
  inShelf: boolean,
): Promise<void> {
  const records = (await listOfflineBooks(serverUrl)).filter((record) => record.bookId === bookId);
  for (const record of records) {
    const updated = { ...record, inShelf };
    await putOfflineBookRecord(updated);
    if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('moke_record_downloaded_book', { book: {
        id: updated.id, serverUrl: updated.serverUrl, bookId: updated.bookId,
        title: updated.title, author: updated.author, inShelf: updated.inShelf,
        fileName: updated.fileName, relativePath: updated.relativePath,
        storageRoot: updated.storageRoot, mimeType: updated.mimeType, updatedAt: updated.updatedAt,
      } });
    }
  }
}

async function deleteRecordOnly(id: string): Promise<void> {
  const db = await openDatabase();
  const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
  await requestResult(store.delete(id));
}

type FsBaseDirectory = import('@tauri-apps/api/path').BaseDirectory;

interface OfflineFsPath {
  /** Path passed to plugin-fs. Default storage stays relative to AppData. */
  operationPath: string;
  /** Absolute path persisted for the native index and reader. */
  filePath: string;
  baseDir?: FsBaseDirectory;
}

function withFsSuffix(target: OfflineFsPath, suffix: string): OfflineFsPath {
  return {
    ...target,
    operationPath: `${target.operationPath}${suffix}`,
    filePath: `${target.filePath}${suffix}`,
  };
}

function fsPathOptions(target: OfflineFsPath): { baseDir?: FsBaseDirectory } | undefined {
  return target.baseDir === undefined ? undefined : { baseDir: target.baseDir };
}

function fsRenameOptions(
  oldPath: OfflineFsPath,
  newPath: OfflineFsPath,
): { oldPathBaseDir?: FsBaseDirectory; newPathBaseDir?: FsBaseDirectory } | undefined {
  if (oldPath.baseDir === undefined && newPath.baseDir === undefined) return undefined;
  return { oldPathBaseDir: oldPath.baseDir, newPathBaseDir: newPath.baseDir };
}

async function storedOfflineFsPath(record: OfflineBookRecord): Promise<OfflineFsPath | null> {
  if (!record.filePath) return null;
  if (record.relativePath && !record.storageRoot) {
    const { BaseDirectory } = await import('@tauri-apps/api/path');
    return {
      operationPath: record.relativePath,
      filePath: record.filePath,
      baseDir: BaseDirectory.AppData,
    };
  }
  return { operationPath: record.filePath, filePath: record.filePath };
}

async function removeDiskFile(target: OfflineFsPath): Promise<void> {
  const { remove, exists } = await import('@tauri-apps/plugin-fs');
  try {
    await remove(target.operationPath, fsPathOptions(target));
  } catch {
    let stillThere = true;
    try { stillThere = await exists(target.operationPath, fsPathOptions(target)); } catch { /* conservatively retain */ }
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
    if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
      const target = await storedOfflineFsPath(record);
      if (target) await removeDiskFile(target);
    }
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
  format?: string; author?: string; coverDataUrl?: string; inShelf?: boolean; sourceSignature?: string; downloadDirectory?: string | null;
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
}): Promise<{ target: OfflineFsPath; relativePath: string }> {
  const { appDataDir, BaseDirectory, join } = await import('@tauri-apps/api/path');
  const relativePath = makeOfflineRelativePath(input.serverUrl, input.bookId, input.format, input.fileName);
  const custom = input.downloadDirectory || null;
  const filePath = custom ? await join(custom, ...relativePath.split('/').slice(1)) : await join(await appDataDir(), ...relativePath.split('/'));
  return {
    target: {
      operationPath: custom ? filePath : relativePath,
      filePath,
      baseDir: custom ? undefined : BaseDirectory.AppData,
    },
    relativePath,
  };
}

async function openOfflineBookFile(input: {
  serverUrl: string; bookId: string; format: string; fileName: string;
  downloadDirectory?: string | null; resume: boolean;
}): Promise<{ writer: OfflineFileWriter; target: OfflineFsPath; partialTarget: OfflineFsPath; relativePath: string }> {
  const { open, mkdir, stat } = await import('@tauri-apps/plugin-fs');
  const { dirname } = await import('@tauri-apps/api/path');
  const { target, relativePath } = await resolveOfflineBookFilePath(input);
  const partialTarget = withFsSuffix(target, '.part');
  const parent = await dirname(target.operationPath);
  await mkdir(parent, { recursive: true, ...fsPathOptions(target) });

  let position = 0;
  if (input.resume) {
    try { position = Number((await stat(partialTarget.operationPath, fsPathOptions(partialTarget))).size); } catch { position = 0; }
  }
  const file = await open(partialTarget.operationPath, {
    write: true,
    create: true,
    append: position > 0,
    truncate: position === 0,
    ...fsPathOptions(partialTarget),
  });
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
  return { writer, target, partialTarget, relativePath };
}

async function validateDiskEpub(target: OfflineFsPath): Promise<boolean> {
  const { open, stat } = await import('@tauri-apps/plugin-fs');
  const size = Number((await stat(target.operationPath, fsPathOptions(target))).size);
  const length = Math.min(size, EPUB_TAIL_WINDOW);
  const file = await open(target.operationPath, { read: true, ...fsPathOptions(target) });
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
  const { target } = await resolveOfflineBookFilePath({
    ...input,
    fileName: `${input.title}.${input.format}`,
  });
  try { await removeDiskFile(withFsSuffix(target, '.part')); } catch { /* already absent */ }
}

async function replaceOfflineBookFile(partialTarget: OfflineFsPath, target: OfflineFsPath): Promise<{
  backupTarget: OfflineFsPath;
  rollback: () => Promise<void>;
}> {
  const { exists, remove, rename } = await import('@tauri-apps/plugin-fs');
  const backupTarget = withFsSuffix(partialTarget, '.backup');
  if (await exists(backupTarget.operationPath, fsPathOptions(backupTarget))) {
    if (await exists(target.operationPath, fsPathOptions(target))) {
      await remove(backupTarget.operationPath, fsPathOptions(backupTarget));
    } else {
      await rename(
        backupTarget.operationPath,
        target.operationPath,
        fsRenameOptions(backupTarget, target),
      );
    }
  }
  const hadPreviousFile = await exists(target.operationPath, fsPathOptions(target));

  if (hadPreviousFile) {
    await rename(target.operationPath, backupTarget.operationPath, fsRenameOptions(target, backupTarget));
  }

  try {
    await rename(partialTarget.operationPath, target.operationPath, fsRenameOptions(partialTarget, target));
  } catch (error) {
    if (hadPreviousFile) {
      try {
        await rename(
          backupTarget.operationPath,
          target.operationPath,
          fsRenameOptions(backupTarget, target),
        );
      } catch {
        // 交给外层记录原始安装失败；备份仍留在磁盘，避免静默丢失。
      }
    }
    throw error;
  }

  return {
    backupTarget,
    rollback: async () => {
      try { await remove(target.operationPath, fsPathOptions(target)); } catch { /* ignore */ }
      if (hadPreviousFile) {
        await rename(
          backupTarget.operationPath,
          target.operationPath,
          fsRenameOptions(backupTarget, target),
        );
      }
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
  author?: string; coverDataUrl?: string; inShelf?: boolean; sourceSignature?: string; downloadDirectory?: string | null; resume?: boolean; preservePartialOnFailure?: boolean;
  write: (writer: OfflineFileWriter) => Promise<string | void | { mimeType?: string; size?: number; sourceSignature?: string }>;
}): Promise<void> {
  const fileName = sanitizeOfflineFileName(input.fileName);
  const format = normalizeOfflineFormat(input.format || fileName.split('.').pop() || 'epub');
  const previous = await getOfflineBook(input.serverUrl, input.bookId, format);
  let writer: OfflineFileWriter | null = null;
  let target: OfflineFsPath | undefined;
  let partialTarget: OfflineFsPath | undefined;
  let relativePath: string | undefined;
  let replacement: Awaited<ReturnType<typeof replaceOfflineBookFile>> | null = null;
  try {
    const handle = await openOfflineBookFile({ ...input, fileName, format, resume: Boolean(input.resume) });
    writer = handle.writer;
    target = handle.target;
    partialTarget = handle.partialTarget;
    relativePath = handle.relativePath;
    const result = await input.write(writer);
    const details = typeof result === 'string' ? { mimeType: result } : result || {};
    const size = details.size ?? writer.position;
    await writer.close();
    writer = null;
    if (format === 'epub' && !(await validateDiskEpub(partialTarget))) throw new Error('book.epub.invalid');
    replacement = await replaceOfflineBookFile(partialTarget, target);
    await commitOfflineBookRecord({
      ...input,
      format,
      fileName,
      mimeType: details.mimeType || input.mimeType,
      size,
      sourceSignature: details.sourceSignature || input.sourceSignature,
      coverDataUrl: input.coverDataUrl ?? previous?.coverDataUrl,
      filePath: target.filePath,
      relativePath,
      storageRoot: input.downloadDirectory || undefined,
    });
    // 索引已经提交，旧文件备份不再需要。
    try { await removeDiskFile(replacement.backupTarget); } catch { /* no previous file or best-effort cleanup */ }
    replacement = null;
  } catch (error) {
    try { if (writer) await writer.close(); } catch { /* ignore */ }
    if (replacement) {
      try { await replacement.rollback(); } catch { /* preserve backup for manual recovery */ }
    } else if (partialTarget && !shouldPreserveOfflinePartial(error, input.preservePartialOnFailure)) {
      try { await removeDiskFile(partialTarget); } catch { /* best effort */ }
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
  if (previous?.filePath && target && previous.filePath !== target.filePath) {
    try {
      const previousTarget = await storedOfflineFsPath(previous);
      if (previousTarget) await removeDiskFile(previousTarget);
    } catch (error) { console.warn('Failed to remove stale offline book file:', error); }
  }
}

async function commitOfflineBookRecord(input: {
  serverUrl: string; bookId: string; format: string; title: string; fileName: string; mimeType: string;
  author?: string; coverDataUrl?: string; inShelf?: boolean; size?: number; blob?: Blob; updatedAt?: number; sourceSignature?: string; filePath?: string; relativePath?: string;
  storageRoot?: string;
}): Promise<void> {
  const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';
  const record: OfflineBookRecord = {
    id: makeOfflineBookKey(input.serverUrl, input.bookId, input.format),
    serverUrl: input.serverUrl,
    bookId: input.bookId,
    format: normalizeOfflineFormat(input.format),
    title: input.title,
    author: input.author,
    coverDataUrl: input.coverDataUrl,
    inShelf: input.inShelf,
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
        id: record.id, serverUrl: record.serverUrl, bookId: record.bookId, title: record.title, author: record.author, inShelf: record.inShelf,
        fileName: record.fileName, relativePath: record.relativePath, storageRoot: record.storageRoot,
        mimeType: record.mimeType, updatedAt: record.updatedAt,
      } });
    } catch (error) { console.warn('Failed to update Moke downloaded-books index:', error); }
  }
}
