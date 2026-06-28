'use client';

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
  blob: Blob;
  updatedAt: number;
  filePath?: string;
}

function makeKey(serverUrl: string, bookId: string) {
  return `${serverUrl}::${bookId}`;
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
    const request = store.get(makeKey(serverUrl, bookId));

    request.onsuccess = () => resolve((request.result as OfflineBookRecord | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
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

  if (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri') {
    try {
      const { writeFile, BaseDirectory, mkdir } = await import('@tauri-apps/plugin-fs');
      const { appDataDir, join } = await import('@tauri-apps/api/path');

      try {
        await mkdir('books', { baseDir: BaseDirectory.AppData, recursive: true });
      } catch (e) {
        // Ignore if directory already exists
      }

      const relativePath = await join('books', input.fileName);
      const arrayBuffer = await input.blob.arrayBuffer();
      await writeFile(relativePath, new Uint8Array(arrayBuffer), { baseDir: BaseDirectory.AppData });

      const dir = await appDataDir();
      filePath = await join(dir, 'books', input.fileName);
    } catch (e) {
      console.error('Failed to save book to file system:', e);
      throw new Error('Failed to save book to file system');
    }
  }

  const record: OfflineBookRecord = {
    id: makeKey(input.serverUrl, input.bookId),
    serverUrl: input.serverUrl,
    bookId: input.bookId,
    title: input.title,
    fileName: input.fileName,
    mimeType: input.mimeType,
    blob: input.blob,
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
}
