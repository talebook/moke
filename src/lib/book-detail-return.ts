/** Display-only, one-shot snapshot of the detail history entry left for Reader. */
export interface BookDetail {
  media_type?: string;
  id: string;
  title: string;
  authors?: string[] | Array<{ name: string }>;
  author?: string;
  author_sort?: string;
  img?: string;
  thumb?: string;
  rating?: number | { value: number; count: number };
  tags?: string[] | Array<{ name: string }>;
  publisher?: string;
  pubdate?: string;
  description?: string;
  comments?: string;
  files?: Array<{ format: string; size: number }>;
  isbn?: string;
  series?: string;
  language?: string;
  state?: {
    read_state?: number;
    online_read?: number;
    download?: number;
    wants?: boolean | number;
  };
}

export interface DetailReturnIdentity {
  serverUrl: string;
  accountId: string;
  bookId: string;
  offlineMode: boolean;
  source: string;
}
export interface DetailReturnSnapshot {
  book: BookDetail;
  selectedFormat: string;
  inShelf: boolean;
  downloaded: boolean;
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const DETAIL_RETURN_KEY = 'moke-detail-return';
export const DETAIL_RETURN_MAX_AGE = 6 * 60 * 60 * 1000;
const MAX_SNAPSHOT_LENGTH = 192 * 1024;

export function detailReturnIdentityKey(identity: DetailReturnIdentity): string {
  return JSON.stringify([identity.serverUrl, identity.accountId, identity.bookId, identity.offlineMode, identity.source]);
}
function browserStorage(): StorageLike | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}
function cover(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32 * 1024 || value.startsWith('blob:')) return undefined;
  // Do not keep credentials or signed query strings in the display snapshot.
  if (/^https?:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return undefined;
      url.search = ''; url.hash = '';
      return url.href;
    } catch { return undefined; }
  }
  if (value.startsWith('data:image/')) return value;
  // Relative covers can also carry signed credentials in a query string.
  if (!value.startsWith('/') || value.startsWith('//')) return undefined;
  return value.split(/[?#]/, 1)[0];
}
function displayBook(book: BookDetail): BookDetail {
  const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
  const names = (value: unknown): string[] | undefined => Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? item : string(item?.name)).filter((item): item is string => Boolean(item))
    : undefined;
  const rating = typeof book.rating === 'number' ? book.rating
    : book.rating && typeof book.rating.value === 'number' && typeof book.rating.count === 'number'
      ? { value: book.rating.value, count: book.rating.count } : undefined;
  // Explicit projection excludes native paths, auth data and reading progress.
  return {
    id: String(book.id), title: book.title, media_type: string(book.media_type),
    authors: names(book.authors), author: string(book.author),
    author_sort: string(book.author_sort), img: cover(book.img), thumb: cover(book.thumb),
    rating, tags: names(book.tags), publisher: string(book.publisher), pubdate: string(book.pubdate),
    description: string(book.description), comments: string(book.comments),
    files: book.files?.map(({ format, size }) => ({ format, size: typeof size === 'number' ? size : 0 })),
    isbn: string(book.isbn), series: string(book.series), language: string(book.language),
  };
}

export function saveDetailReturn(
  identity: DetailReturnIdentity, snapshot: DetailReturnSnapshot, token: string,
  storage = browserStorage(), now = Date.now(),
): boolean {
  try {
    if (!storage || !token || String(snapshot.book.id) !== identity.bookId) return false;
    const value = JSON.stringify({
      version: 1, identity: detailReturnIdentityKey(identity), token, savedAt: now,
      snapshot: { book: displayBook(snapshot.book), selectedFormat: snapshot.selectedFormat,
        inShelf: snapshot.inShelf, downloaded: snapshot.downloaded },
    });
    // Remove a previous snapshot if this book is too large or storage is full.
    storage.removeItem(DETAIL_RETURN_KEY);
    if (value.length > MAX_SNAPSHOT_LENGTH) return false;
    storage.setItem(DETAIL_RETURN_KEY, value);
    return true;
  } catch { return false; }
}
export function takeDetailReturn(
  identity: DetailReturnIdentity, token: unknown,
  storage = browserStorage(), now = Date.now(),
): DetailReturnSnapshot | null {
  try {
    if (!storage) return null;
    const raw = storage.getItem(DETAIL_RETURN_KEY);
    if (!raw) return null;
    // Every attempt consumes it, including a change of account/source/book.
    storage.removeItem(DETAIL_RETURN_KEY);
    if (typeof token !== 'string' || raw.length > MAX_SNAPSHOT_LENGTH) return null;
    const value = JSON.parse(raw);
    const snapshot = value.snapshot;
    if (value.version !== 1 || value.token !== token || value.identity !== detailReturnIdentityKey(identity)
      || !Number.isFinite(value.savedAt) || now < value.savedAt || now - value.savedAt > DETAIL_RETURN_MAX_AGE
      || !snapshot || !snapshot.book || String(snapshot.book.id) !== identity.bookId
      || typeof snapshot.book.title !== 'string' || !snapshot.book.title
      || typeof snapshot.selectedFormat !== 'string' || !/^[a-z0-9]+$/.test(snapshot.selectedFormat)
      || typeof snapshot.inShelf !== 'boolean' || typeof snapshot.downloaded !== 'boolean') return null;
    // Malformed files must never reach the detail page's format normalization.
    if (snapshot.book.files !== undefined && (!Array.isArray(snapshot.book.files)
      || !snapshot.book.files.every((file: { format?: unknown }) => file && typeof file.format === 'string'))) return null;
    return { book: displayBook(snapshot.book), selectedFormat: snapshot.selectedFormat,
      inShelf: snapshot.inShelf, downloaded: snapshot.downloaded };
  } catch { return null; }
}

/** Save immediately before the opener hands this history entry to Reader. */
export function rememberDetailReturn(identity: DetailReturnIdentity, snapshot: DetailReturnSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    if (saveDetailReturn(identity, snapshot, token)) {
      window.history.replaceState({ ...window.history.state, mokeDetailReturn: token }, '', window.location.href);
    }
  } catch {
    // Restricted history/storage must not prevent opening a book.
  }
}
