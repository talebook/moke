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

export type OfflineRangeResponseMode = 'full' | 'resume' | 'restart' | 'retry-full' | 'invalid';

export function shouldResumeOfflineDownload(appPlatform?: string, status?: string): boolean {
  return appPlatform === 'tauri' && status !== 'completed';
}

/** Decide whether a ranged response is safe before any response bytes are written. */
export function classifyOfflineRangeResponse(
  requestedOffset: number,
  status: number,
  contentRange: ReturnType<typeof parseContentRange>,
): OfflineRangeResponseMode {
  if (requestedOffset > 0) {
    // A stale/complete partial file can be beyond the server's current
    // representation. HTTP 416 is recoverable by truncating it and retrying
    // once without Range.
    if (status === 416) return 'retry-full';
    if (status !== 206) return 'restart';
    return contentRange?.start === requestedOffset ? 'resume' : 'retry-full';
  }
  if (status !== 206) return 'full';
  return contentRange?.start === 0
    && contentRange.total != null
    && contentRange.end + 1 === contentRange.total
    ? 'full'
    : 'invalid';
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

/** Bounded prefix only: do not accumulate a whole publication to validate it. */
export const BOOK_HEADER_WINDOW = 4096;
const MOBI_FORMATS = new Set(['mobi', 'azw', 'azw3']);
// These formats can legitimately contain HTML/JSON-looking text. Never infer
// an authentication failure just from their prose or an inaccurate MIME type.
const TEXT_FORMATS = new Set(['txt', 'text', 'html', 'htm', 'xhtml', 'md', 'markdown', 'json', 'xml', 'fb2', 'svg', 'csv', 'rtf']);

export function validateDownloadedBookHeader(
  prefix: Uint8Array,
  format: string,
  complete = true,
): void {
  const normalized = normalizeOfflineFormat(format);
  if (TEXT_FORMATS.has(normalized)) return;
  const sample = prefix.subarray(0, BOOK_HEADER_WINDOW);
  // The bounded window may end in the middle of a UTF-8 character. Ignore
  // that unfinished character instead of mistaking its replacement glyph
  // for evidence that an HTML/JSON response contains binary data.
  const text = new TextDecoder().decode(sample, { stream: true }).replace(/^\uFEFF/, '').trimStart();
  // Binary PalmDB headers can start with an arbitrary book title. NULs and
  // other binary controls distinguish that title from a real error document.
  const plainText = !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(text);
  // Scan comments once; a repeated lazy comment regex can backtrack
  // exponentially on a malformed response containing many comment markers.
  let documentStart = 0;
  while (text.startsWith('<!--', documentStart)) {
    const commentEnd = text.indexOf('-->', documentStart + 4);
    if (commentEnd < 0) break;
    documentStart = commentEnd + 3;
    while (documentStart < text.length && /\s/.test(text[documentStart]!)) documentStart += 1;
  }
  const html = /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(text.slice(documentStart));
  const json = /^[{[]/.test(text);
  if (plainText && (html || json)) {
    // Even a JSON-looking title is valid PalmDB data. Wait for the header
    // signature before judging an incomplete MOBI-family prefix.
    if (!MOBI_FORMATS.has(normalized) || complete || sample.length >= 68) {
      throw new Error('book.download.invalid_response');
    }
  }
  if (MOBI_FORMATS.has(normalized) && (complete || sample.length >= 68)) {
    const signature = new TextDecoder().decode(sample.subarray(60, 68));
    if (signature !== 'BOOKMOBI' && signature !== 'TEXtREAd') throw new Error('book.mobi.invalid');
  }
}
