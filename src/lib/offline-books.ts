'use client';

import { debugLog } from './debug-log.ts';
import { makeOfflineBookKey, sanitizeOfflineFileName } from './offline-book-core.ts';

const DB_NAME = 'moke-offline-books';
const STORE_NAME = 'books';

export interface OfflineBookRecord {
  id: string;
  serverUrl: string;
  bookId: string;
  title: string;
  fileName: string;
  mimeType: string;
  blob?: Blob;
  updatedAt: number;
  filePath?: string;
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
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // 不指定版本：当前逻辑只依赖 books store，不需要执行 schema 升级。
    // 这样既能创建全新 v1 数据库，也能打开曾被下载管理中心升级到 v2（或更高）
    // 的用户数据库，避免用较低固定版本打开时抛 VersionError。
    const request = window.indexedDB.open(DB_NAME);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readOfflineBookRecord(serverUrl: string, bookId: string): Promise<OfflineBookRecord | null> {
  const db = await openDatabase();
  const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
  const direct = await new Promise<OfflineBookRecord | null>((resolve, reject) => {
    const request = store.get(makeOfflineBookKey(serverUrl, bookId));
    request.onsuccess = () => resolve((request.result as OfflineBookRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  if (direct) return direct;

  // v2 会把格式加入 key（server::book::format）。按记录身份兜底查找，保证从
  // 下载管理中心版本切回当前客户端时，已有书仍能被识别。
  if (typeof store.getAll === 'function') {
    const records = await new Promise<OfflineBookRecord[]>((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result as OfflineBookRecord[]);
      request.onerror = () => reject(request.error);
    });
    return records.find((record) => record.bookId === bookId && sameServer(record.serverUrl, serverUrl)) ?? null;
  }

  return null;
}

async function putOfflineBookRecord(record: OfflineBookRecord): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const request = transaction.objectStore(STORE_NAME).put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function sameServer(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
  }
}

/**
 * Tauri 的磁盘文件和原生索引是离线书的最终事实来源。WebView 的 IndexedDB
 * 可能在应用升级或来源迁移后丢失；此时从原生索引恢复记录，避免磁盘上仍有书
 * 却把“阅读”误显示成“下载”。
 */
export async function getOfflineBook(serverUrl: string, bookId: string): Promise<OfflineBookRecord | null> {
  let indexedRecord: OfflineBookRecord | null = null;
  try {
    indexedRecord = await readOfflineBookRecord(serverUrl, bookId);
  } catch (error) {
    if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') throw error;
    debugLog(
      'warn',
      'download',
      '读取 WebView 离线书记录失败，尝试从原生索引恢复',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
  if (process.env.NEXT_PUBLIC_APP_PLATFORM !== 'tauri') return indexedRecord;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const nativeRecords = await invoke<NativeOfflineBookRecord[]>('moke_list_downloaded_books');
    const nativeRecord = nativeRecords.find((record) => (
      record.bookId === bookId && sameServer(record.serverUrl, serverUrl)
    )) ?? (indexedRecord
      ? nativeRecords.find((record) => record.fileName === indexedRecord.fileName)
      : undefined);

    if (!nativeRecord) return null;

    const recovered: OfflineBookRecord = {
      id: nativeRecord.id || indexedRecord?.id || makeOfflineBookKey(serverUrl, bookId),
      serverUrl,
      bookId,
      title: nativeRecord.title || indexedRecord?.title || '',
      fileName: nativeRecord.fileName,
      mimeType: nativeRecord.mimeType || indexedRecord?.mimeType || 'application/octet-stream',
      updatedAt: nativeRecord.updatedAt,
      filePath: nativeRecord.filePath,
    };
    try {
      await putOfflineBookRecord(recovered);
    } catch (error) {
      debugLog(
        'warn',
        'download',
        '原生离线书已恢复，但写回 WebView 记录失败',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    }
    return recovered;
  } catch (error) {
    // 原生索引读取失败时保留 IndexedDB 兜底，避免一次 IPC 异常把按钮错误降级。
    debugLog(
      'warn',
      'download',
      '读取原生离线书索引失败，回退到 WebView 记录',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
    return indexedRecord;
  }
}

export async function deleteOfflineBook(serverUrl: string, bookId: string): Promise<void> {
  const db = await openDatabase();
  const record = await getOfflineBook(serverUrl, bookId);

  if (record?.filePath && process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
    try {
      const { remove } = await import('@tauri-apps/plugin-fs');
      await remove(record.filePath);
    } catch (e) {
      // 文件删除失败时确认文件是否仍在磁盘上：若仍在则保留记录并报错，
      // 让调用方提示用户重试，避免残留文件被 legacy 扫描重新暴露成幽灵书。
      let stillThere = true;
      try {
        const { exists } = await import('@tauri-apps/plugin-fs');
        stillThere = await exists(record.filePath);
      } catch {
        // 无法确认时按“仍存在”处理，保守保留记录。
      }
      if (stillThere) {
        throw new Error('Failed to delete book file');
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(record?.id ?? makeOfflineBookKey(serverUrl, bookId));

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

  if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri' && record) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('moke_remove_downloaded_book', { id: record.id });
    } catch (error) {
      console.warn('Failed to update Moke downloaded-books index:', error);
    }
  }
}

export async function saveOfflineBook(input: {
  serverUrl: string;
  bookId: string;
  title: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
}): Promise<void> {
  const fileName = sanitizeOfflineFileName(input.fileName);

  if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
    // 桌面版也走流式落盘，避免 blob.arrayBuffer() 造成整本全量拷贝。
    await saveOfflineBookStream({
      ...input,
      fileName,
      write: async (writer) => {
        const reader = input.blob.stream().getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) await writer.write(value);
          }
        } finally {
          reader.releaseLock();
        }
        return input.mimeType;
      },
    });
    return;
  }

  await commitOfflineBookRecord({
    serverUrl: input.serverUrl,
    bookId: input.bookId,
    title: input.title,
    fileName,
    mimeType: input.mimeType,
    blob: input.blob,
  });
}

export interface OfflineFileWriter {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

async function openOfflineBookFile(fileName: string): Promise<{
  writer: OfflineFileWriter;
  filePath: string;
  temporaryPath: string;
}> {
  const { open, BaseDirectory, mkdir } = await import('@tauri-apps/plugin-fs');
  const { appDataDir, join } = await import('@tauri-apps/api/path');

  try {
    await mkdir('books', { baseDir: BaseDirectory.AppData, recursive: true });
  } catch (e) {
    // Ignore if directory already exists
  }

  const token = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporaryName = `.moke-download-${token}.part`;
  const temporaryRelativePath = await join('books', temporaryName);
  const file = await open(temporaryRelativePath, {
    write: true,
    createNew: true,
    baseDir: BaseDirectory.AppData,
  });

  const dir = await appDataDir();
  const filePath = await join(dir, 'books', fileName);
  const temporaryPath = await join(dir, 'books', temporaryName);

  return {
    writer: {
      write: (data) => file.write(data).then(() => undefined),
      close: () => file.close(),
    },
    filePath,
    temporaryPath,
  };
}

async function replaceOfflineBookFile(temporaryPath: string, filePath: string): Promise<() => Promise<void>> {
  const { exists, remove, rename } = await import('@tauri-apps/plugin-fs');
  const backupPath = `${temporaryPath}.backup`;
  const hadPreviousFile = await exists(filePath);

  if (hadPreviousFile) await rename(filePath, backupPath);

  try {
    await rename(temporaryPath, filePath);
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

  return async () => {
    try {
      await remove(filePath);
    } catch {
      // ignore
    }
    if (hadPreviousFile) await rename(backupPath, filePath);
  };
}

/** 桌面版流式落盘：逐块写入磁盘（边读边写），成功后登记索引并清理旧文件。 */
export async function saveOfflineBookStream(input: {
  serverUrl: string;
  bookId: string;
  title: string;
  fileName: string;
  mimeType: string;
  write: (writer: OfflineFileWriter) => Promise<string | void>;
}): Promise<void> {
  const fileName = sanitizeOfflineFileName(input.fileName);
  const previous = await getOfflineBook(input.serverUrl, input.bookId);

  let writer: OfflineFileWriter | null = null;
  let filePath: string | undefined;
  let temporaryPath: string | undefined;
  let rollbackReplacement: (() => Promise<void>) | null = null;

  try {
    const handle = await openOfflineBookFile(fileName);
    writer = handle.writer;
    filePath = handle.filePath;
    temporaryPath = handle.temporaryPath;

    const actualMime = (await input.write(writer)) || input.mimeType;
    await writer.close();
    writer = null;

    rollbackReplacement = await replaceOfflineBookFile(temporaryPath, filePath);
    temporaryPath = undefined;

    await commitOfflineBookRecord({
      serverUrl: input.serverUrl,
      bookId: input.bookId,
      title: input.title,
      fileName,
      mimeType: actualMime,
      filePath,
    });

    // 索引已经提交，旧文件备份不再需要。
    const { remove } = await import('@tauri-apps/plugin-fs');
    const backupPath = `${handle.temporaryPath}.backup`;
    try {
      await remove(backupPath);
    } catch {
      // 原文件不存在或备份清理失败均不影响新下载；隐藏备份不会进入书库扫描。
    }
    rollbackReplacement = null;
  } catch (e) {
    // 下载始终写入隐藏临时文件。失败时恢复原文件，避免一次重试把已下载书籍
    // 截断或删除；没有原文件时只清理半成品。
    if (rollbackReplacement) {
      try {
        await rollbackReplacement();
      } catch {
        // ignore
      }
    }
    if (temporaryPath) {
      try {
        if (writer) await writer.close();
      } catch {
        // ignore
      }
      try {
        const { remove } = await import('@tauri-apps/plugin-fs');
        await remove(temporaryPath);
      } catch {
        // ignore
      }
    }

    if (e instanceof Error && (e.message === 'book.epub.invalid' || e.message.startsWith('book.download.'))) {
      throw e;
    }
    debugLog(
      'error',
      'download',
      '✗ 创建、关闭或登记离线书籍文件失败',
      e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    );
    throw new Error('book.download.storage_failed');
  }

  // M1：同书换格式/改名再下载时，删除旧的残留磁盘文件，避免目录扫描
  // 重新把旧文件暴露成 legacy 幽灵书。
  if (previous?.filePath && filePath && previous.filePath !== filePath) {
    try {
      const { remove } = await import('@tauri-apps/plugin-fs');
      await remove(previous.filePath);
    } catch (error) {
      console.warn('Failed to remove stale offline book file:', error);
    }
  }
}

async function commitOfflineBookRecord(input: {
  serverUrl: string;
  bookId: string;
  title: string;
  fileName: string;
  mimeType: string;
  blob?: Blob;
  filePath?: string;
}): Promise<void> {
  const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

  const record: OfflineBookRecord = {
    id: makeOfflineBookKey(input.serverUrl, input.bookId),
    serverUrl: input.serverUrl,
    bookId: input.bookId,
    title: input.title,
    fileName: input.fileName,
    mimeType: input.mimeType,
    blob: isTauriApp ? undefined : input.blob,
    updatedAt: Date.now(),
    filePath: input.filePath,
  };

  await putOfflineBookRecord(record);

  if (isTauriApp) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('moke_record_downloaded_book', {
        book: {
          id: record.id,
          serverUrl: record.serverUrl,
          bookId: record.bookId,
          title: record.title,
          fileName: record.fileName,
          mimeType: record.mimeType,
          updatedAt: record.updatedAt,
        },
      });
    } catch (error) {
      console.warn('Failed to update Moke downloaded-books index:', error);
    }
  }
}
