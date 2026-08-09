const WINDOWS_RESERVED_BASE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/** 单个离线书文件名的最大总长度（含扩展名），避免 Windows MAX_PATH 超限。 */
const MAX_FILE_NAME_LENGTH = 120;

const EOCD_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
/** EOCD 之后允许存在的尾部字节数（服务端/代理可能追加换行等字节）。 */
const MAX_TRAILING_BYTES = 4096;

export function makeOfflineBookKey(serverUrl: string, bookId: string): string {
  return `${serverUrl}::${bookId}`;
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

export function beginOfflineDownload(serverUrl: string, bookId: string): boolean {
  const key = makeOfflineBookKey(serverUrl, bookId);
  if (inFlightDownloads.has(key)) return false;
  inFlightDownloads.add(key);
  return true;
}

export function endOfflineDownload(serverUrl: string, bookId: string): void {
  inFlightDownloads.delete(makeOfflineBookKey(serverUrl, bookId));
}

export async function hasEpubCentralDirectory(blob: Blob): Promise<boolean> {
  const tail = new Uint8Array(
    await blob
      .slice(Math.max(0, blob.size - EOCD_LENGTH - MAX_COMMENT_LENGTH - MAX_TRAILING_BYTES))
      .arrayBuffer(),
  );

  for (let index = tail.length - EOCD_LENGTH; index >= 0; index--) {
    if (
      tail[index] === 0x50 &&
      tail[index + 1] === 0x4b &&
      tail[index + 2] === 0x05 &&
      tail[index + 3] === 0x06
    ) {
      const commentLength = tail[index + 20]! | (tail[index + 21]! << 8);
      const endOfEocd = index + EOCD_LENGTH + commentLength;
      if (endOfEocd <= tail.length && tail.length - endOfEocd <= MAX_TRAILING_BYTES) {
        return true;
      }
    }
  }

  return false;
}
