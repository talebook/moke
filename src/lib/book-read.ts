type RequestLike = (url: string, init?: RequestInit) => Promise<Response>;
const READ_RECORD_TIMEOUT_MS = 10_000;
/**
 * Record-before-navigation must not noticeably delay opening the reader: the
 * request is best-effort, so bound it much tighter than the desktop path.
 */
export const READ_RECORD_NAV_TIMEOUT_MS = 3_000;

/**
 * Build a record timeout signal that also works on WebViews without
 * `AbortSignal.timeout` (some OHOS / older iOS WebViews); without any abort
 * mechanism the request runs unbounded, which is still better than throwing
 * and losing the record silently.
 */
function buildTimeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(timeoutMs);
  if (typeof AbortController !== 'function') return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}

/** Pathname of an absolute URL with trailing slashes stripped; null if unparseable. */
function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * Notify Talebook through its canonical reader route after the local reader
 * has opened. That route owns both read_history persistence and the book's
 * read counter, so the client must not try to reproduce either mutation.
 */
export async function recordBookRead(
  requestLike: RequestLike,
  serverUrl: string,
  bookId: string | number,
  timeoutMs = READ_RECORD_TIMEOUT_MS,
): Promise<void> {
  const readUrl = `${serverUrl}/read/${encodeURIComponent(String(bookId))}`;
  const response = await requestLike(readUrl, {
    credentials: 'include',
    signal: buildTimeoutSignal(timeoutMs),
  });

  // Drain the body promptly so the underlying connection is released; the
  // online-reader page can be hundreds of KB of HTML this client never uses.
  try {
    await response.arrayBuffer();
  } catch {
    // A body-read failure does not invalidate an otherwise successful record.
  }

  if (!response.ok) {
    throw new Error(`book.read_record.http.${response.status}`);
  }

  // A 200 from a login page means the session expired and the server
  // redirected `/read/{id}` away — the record was never persisted.
  const finalUrl = response.url || readUrl;
  const finalPath = pathnameOf(finalUrl);
  if (finalPath && finalPath !== pathnameOf(readUrl)) {
    throw new Error('book.read_record.redirect');
  }
}

export async function openAndRecordBookRead({
  open,
  record,
  onOpened,
  onRecordError,
}: {
  open: () => Promise<void>;
  record: () => Promise<void>;
  onOpened?: () => void;
  onRecordError?: (error: unknown) => void;
}): Promise<void> {
  await open();
  onOpened?.();
  try {
    await record();
  } catch (error) {
    onRecordError?.(error);
  }
}

/** Record first when opening replaces the current WebView and destroys this page. */
export async function recordAndOpenBookRead({
  record,
  open,
  onRecordError,
}: {
  record: () => Promise<void>;
  open: () => Promise<void>;
  onRecordError?: (error: unknown) => void;
}): Promise<void> {
  try {
    await record();
  } catch (error) {
    onRecordError?.(error);
  }
  await open();
}
