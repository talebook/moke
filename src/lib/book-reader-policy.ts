export interface ReaderBook {
  media_type?: string;
  files?: ReadonlyArray<{ format: string }>;
}

const COMIC_FORMATS = new Set(['cbz', 'zip', 'cbr', 'rar']);

/** Explicit server classification (including a manual override) wins. */
export function isComicBook(book: ReaderBook): boolean {
  const type = book.media_type?.trim().toLowerCase();
  if (type === 'comic') return true;
  if (type === 'ebook') return false;
  return Boolean(book.files?.some(({ format }) => COMIC_FORMATS.has(format.trim().toLowerCase())));
}

export function resolveBookReader(book: ReaderBook, preference: 'embedded' | 'system') {
  return isComicBook(book) ? 'comic' : preference;
}

export function supportsComicPages(book: ReaderBook): boolean {
  return Boolean(book.files?.some(({ format }) => COMIC_FORMATS.has(format.trim().toLowerCase())));
}

export const COMIC_OFFLINE_MESSAGE = '漫画暂不支持本地离线解包阅读。请退出离线模式后在线阅读；已下载文件会保留。';
export const COMIC_FORMAT_MESSAGE = '这本书已按漫画打开，但当前 Talebook 漫画接口仅支持 CBZ、ZIP、CBR、RAR。漫画型 EPUB/PDF 需先在书库中添加图片漫画容器，暂时无法显示页面。';
