import { deleteOfflineBook, getOfflineBook, saveOfflineBook, type OfflineBookRecord } from './offline-books.ts';
import { hasEpubCentralDirectory } from './offline-book-core.ts';
import { SAMPLE_BOOK } from './sample-book-info.ts';
import { withSampleBookOperation, sampleBookDeletionGeneration } from './sample-book-coordination.ts';

let importing: Promise<OfflineBookRecord> | undefined;
let importingGeneration: string | undefined;

export function getSampleBook(): Promise<OfflineBookRecord | null> {
  return getOfflineBook(SAMPLE_BOOK.serverUrl, SAMPLE_BOOK.bookId, SAMPLE_BOOK.format);
}

/** Explicit opt-in only: reading the installed state never fetches or imports the asset. */
export function importSampleBook(): Promise<OfflineBookRecord> {
  const generation = sampleBookDeletionGeneration();
  if (importing && importingGeneration === generation) return importing;
  const operation = importBundledBook().finally(() => {
    if (importing === operation) importing = undefined;
  });
  importingGeneration = generation;
  importing = operation;
  return operation;
}

async function importBundledBook(): Promise<OfflineBookRecord> {
  const { existing, generation } = await withSampleBookOperation(async () => ({
    existing: await getSampleBook(), generation: sampleBookDeletionGeneration(),
  }));
  if (existing) return existing;

  const response = await fetch(SAMPLE_BOOK.assetPath);
  if (!response.ok) throw new Error('无法读取内置示例书籍，请重试。');
  const blob = await response.blob();
  if (!blob.size || blob.size > 16 * 1024 || !await hasEpubCentralDirectory(blob)) {
    throw new Error('内置示例书籍文件无效。');
  }
  return withSampleBookOperation(async () => {
    if (sampleBookDeletionGeneration() !== generation) {
      throw new Error('示例书籍已在另一窗口删除，请重新导入。');
    }
    await saveOfflineBook({ ...SAMPLE_BOOK, blob, inShelf: true });
    const record = await getSampleBook();
    if (!record) throw new Error('示例书籍未能保存，请重试。');
    return record;
  });
}

export async function deleteSampleBook(): Promise<void> {
  await deleteOfflineBook(SAMPLE_BOOK.serverUrl, SAMPLE_BOOK.bookId, SAMPLE_BOOK.format);
}
