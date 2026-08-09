'use client';

import { makeOfflineBookKey, sanitizeOfflineFileName } from './offline-book-core.ts';

const DB_NAME = 'moke-offline-books';
const STORE_NAME = 'books';
const DB_VERSION = 1;

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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

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

export async function getOfflineBook(serverUrl: string, bookId: string): Promise<OfflineBookRecord | null> {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(makeOfflineBookKey(serverUrl, bookId));

    request.onsuccess = () => resolve((request.result as OfflineBookRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
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
    const request = store.delete(makeOfflineBookKey(serverUrl, bookId));

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

async function openOfflineBookFile(fileName: string): Promise<{ writer: OfflineFileWriter; filePath: string }> {
  const { open, BaseDirectory, mkdir } = await import('@tauri-apps/plugin-fs');
  const { appDataDir, join } = await import('@tauri-apps/api/path');

  try {
    await mkdir('books', { baseDir: BaseDirectory.AppData, recursive: true });
  } catch (e) {
    // Ignore if directory already exists
  }

  const relativePath = await join('books', fileName);
  const file = await open(relativePath, {
    write: true,
    create: true,
    truncate: true,
    baseDir: BaseDirectory.AppData,
  });

  const dir = await appDataDir();
  const filePath = await join(dir, 'books', fileName);

  return {
    writer: {
      write: (data) => file.write(data).then(() => undefined),
      close: () => file.close(),
    },
    filePath,
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

  try {
    const handle = await openOfflineBookFile(fileName);
    writer = handle.writer;
    filePath = handle.filePath;

    const actualMime = (await input.write(writer)) || input.mimeType;
    await writer.close();
    writer = null;

    await commitOfflineBookRecord({
      serverUrl: input.serverUrl,
      bookId: input.bookId,
      title: input.title,
      fileName,
      mimeType: actualMime,
      filePath,
    });
  } catch (e) {
    // 清理半成品/孤儿文件，避免被 legacy 扫描重新暴露成幽灵书。
    if (filePath) {
      try {
        if (writer) await writer.close();
      } catch {
        // ignore
      }
      try {
        const { remove } = await import('@tauri-apps/plugin-fs');
        await remove(filePath);
      } catch {
        // ignore
      }
    }
    throw e;
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
  const db = await openDatabase();
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

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(record);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });

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
