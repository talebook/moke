const WINDOWS_RESERVED_BASE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_FILE_NAME_LENGTH = 120;
const EOCD_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const MAX_TRAILING_BYTES = 4096;

export function normalizeOfflineFormat(format: string): string {
  return format.trim().replace(/^\./, '').toLowerCase() || 'epub';
}

/** Stable v2 key. The format segment lets EPUB/PDF/etc. coexist. */
export function makeOfflineBookKey(serverUrl: string, bookId: string, format?: string): string {
  const legacy = `${serverUrl}::${bookId}`;
  return format ? `${legacy}::${normalizeOfflineFormat(format)}` : legacy;
}

/** A path-safe, non-secret identifier. The hash prevents equal host labels colliding. */
export function makeOfflineServerDirectory(serverUrl: string): string {
  let label = 'server';
  try {
    const url = new URL(serverUrl);
    label = `${url.hostname}${url.port ? `_${url.port}` : ''}`;
  } catch {
    label = serverUrl;
  }
  label = label.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[. ]+|[. ]+$/g, '') || 'server';
  let hash = 2166136261;
  for (const char of serverUrl) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${label.slice(0, 48)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function makeOfflineRelativePath(
  serverUrl: string,
  bookId: string,
  format: string,
  fileName: string,
): string {
  const safeBookId = bookId.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^[. ]+|[. ]+$/g, '') || 'book';
  const safeFormat = normalizeOfflineFormat(format).replace(/[^a-z0-9_-]+/g, '_');
  return ['books', makeOfflineServerDirectory(serverUrl), safeBookId.slice(0, 80), safeFormat, sanitizeOfflineFileName(fileName)].join('/');
}

export function sanitizeOfflineFileName(fileName: string): string {
  const cleaned = fileName
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  const name = cleaned || 'book.epub';
  const lastDot = name.lastIndexOf('.');
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot) : '';
  const reservedBase = WINDOWS_RESERVED_BASE_NAMES.has(base.toUpperCase());
  const baseLimit = Math.max(1, MAX_FILE_NAME_LENGTH - ext.length);
  const effectiveBase = (reservedBase ? `_${base}` : base).slice(0, baseLimit);
  return `${effectiveBase}${ext}`;
}

const inFlightDownloads = new Set<string>();

export function beginOfflineDownload(serverUrl: string, bookId: string, format?: string): boolean {
  const key = makeOfflineBookKey(serverUrl, bookId, format);
  if (inFlightDownloads.has(key)) return false;
  inFlightDownloads.add(key);
  return true;
}

export function endOfflineDownload(serverUrl: string, bookId: string, format?: string): void {
  inFlightDownloads.delete(makeOfflineBookKey(serverUrl, bookId, format));
}

export function parseContentRange(value: string | null): { start: number; end: number; total: number | null } | null {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start
    ? { start, end, total }
    : null;
}

export async function hasEpubCentralDirectory(blob: Blob): Promise<boolean> {
  const tail = new Uint8Array(
    await blob.slice(Math.max(0, blob.size - EOCD_LENGTH - MAX_COMMENT_LENGTH - MAX_TRAILING_BYTES)).arrayBuffer(),
  );
  for (let index = tail.length - EOCD_LENGTH; index >= 0; index--) {
    if (tail[index] === 0x50 && tail[index + 1] === 0x4b && tail[index + 2] === 0x05 && tail[index + 3] === 0x06) {
      const commentLength = tail[index + 20]! | (tail[index + 21]! << 8);
      const endOfEocd = index + EOCD_LENGTH + commentLength;
      if (endOfEocd <= tail.length && tail.length - endOfEocd <= MAX_TRAILING_BYTES) return true;
    }
  }
  return false;
}
