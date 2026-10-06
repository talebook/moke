import { deleteOfflineBook, getOfflineBook, saveOfflineBook, type OfflineBookRecord } from './offline-books.ts';
import { hasEpubCentralDirectory } from './offline-book-core.ts';
import { SAMPLE_BOOK } from './sample-book-info.ts';

let importing: Promise<OfflineBookRecord> | undefined;

export function getSampleBook(): Promise<OfflineBookRecord | null> {
  return getOfflineBook(SAMPLE_BOOK.serverUrl, SAMPLE_BOOK.bookId, SAMPLE_BOOK.format);
}

/** Explicit opt-in only: reading the installed state never fetches or imports the asset. */
export function importSampleBook(): Promise<OfflineBookRecord> {
  if (importing) return importing;
  importing = importBundledBook().finally(() => { importing = undefined; });
  return importing;
}

async function importBundledBook(): Promise<OfflineBookRecord> {
  const existing = await getSampleBook();
  if (existing) return existing;

  const response = await fetch(SAMPLE_BOOK.assetPath);
  if (!response.ok) throw new Error('无法读取内置示例书籍，请重试。');
  const blob = await response.blob();
  if (!blob.size || blob.size > 16 * 1024 || !await hasEpubCentralDirectory(blob)) {
    throw new Error('内置示例书籍文件无效。');
  }
  await saveOfflineBook({ ...SAMPLE_BOOK, blob, inShelf: true });
  const record = await getSampleBook();
  if (!record) throw new Error('示例书籍未能保存，请重试。');
  return record;
}

export async function deleteSampleBook(): Promise<void> {
  // A second settings window may delete while the first is still importing.
  if (importing) await importing.catch(() => undefined);
  await deleteOfflineBook(SAMPLE_BOOK.serverUrl, SAMPLE_BOOK.bookId, SAMPLE_BOOK.format);
}
