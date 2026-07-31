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
      console.error('Failed to delete book file:', e);
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
  const db = await openDatabase();
  let filePath: string | undefined;
  const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

  const fileName = sanitizeOfflineFileName(input.fileName);

  if (isTauriApp) {
    try {
      const { writeFile, BaseDirectory, mkdir } = await import('@tauri-apps/plugin-fs');
      const { appDataDir, join } = await import('@tauri-apps/api/path');

      try {
        await mkdir('books', { baseDir: BaseDirectory.AppData, recursive: true });
      } catch (e) {
        // Ignore if directory already exists
      }

      const relativePath = await join('books', fileName);
      const arrayBuffer = await input.blob.arrayBuffer();
      await writeFile(relativePath, new Uint8Array(arrayBuffer), { baseDir: BaseDirectory.AppData });

      const dir = await appDataDir();
      filePath = await join(dir, 'books', fileName);
    } catch (e) {
      console.error('Failed to save book to file system:', e);
      throw new Error('Failed to save book to file system');
    }
  }

  const record: OfflineBookRecord = {
    id: makeOfflineBookKey(input.serverUrl, input.bookId),
    serverUrl: input.serverUrl,
    bookId: input.bookId,
    title: input.title,
    fileName,
    mimeType: input.mimeType,
    blob: isTauriApp ? undefined : input.blob,
    updatedAt: Date.now(),
    filePath,
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
