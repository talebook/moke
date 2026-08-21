type RequestLike = (url: string, init?: RequestInit) => Promise<Response>;
const READ_RECORD_TIMEOUT_MS = 10_000;
/**
 * Record-before-navigation must not noticeably delay opening the reader: the
 * request is best-effort, so bound it much tighter than the desktop path.
 */
export const READ_RECORD_NAV_TIMEOUT_MS = 3_000;

interface TimeoutGuard {
  signal: AbortSignal | undefined;
  expired: Promise<never>;
  cleanup: () => void;
}

/**
 * Bound the whole request even on WebViews without `AbortSignal.timeout` or
 * `AbortController`. The explicit timer can be cleared as soon as the request
 * settles, unlike a fire-and-forget fallback signal.
 */
function buildTimeoutGuard(timeoutMs: number): TimeoutGuard {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('book.read_record.timeout'));
      controller?.abort();
    }, timeoutMs);
  });

  return {
    signal: controller?.signal,
    expired,
    cleanup: () => clearTimeout(timer),
  };
}

interface UrlTarget {
  origin: string;
  pathname: string;
}

/** Origin and normalized pathname of an absolute URL; null if unparseable. */
function urlTargetOf(url: string): UrlTarget | null {
  try {
    const parsed = new URL(url);
    return {
      origin: parsed.origin,
      pathname: parsed.pathname.replace(/\/+$/, '') || '/',
    };
  } catch {
    return null;
  }
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || '';
  return contentType === 'application/json' || contentType.endsWith('+json');
}

function parseJsonBody(body: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error('book.read_record.response.invalid');
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
  const expectedTarget = urlTargetOf(readUrl);
  const timeout = buildTimeoutGuard(timeoutMs);

  try {
    const response = await Promise.race([
      requestLike(readUrl, {
        credentials: 'include',
        signal: timeout.signal,
      }),
      timeout.expired,
    ]);

    // Drain the body promptly so the underlying connection is released; the
    // online-reader page can be hundreds of KB of HTML this client never uses.
    let body: ArrayBuffer | null = null;
    try {
      body = await Promise.race([response.arrayBuffer(), timeout.expired]);
    } catch (error) {
      if (error instanceof Error && error.message === 'book.read_record.timeout') throw error;
      // A body-read failure does not invalidate an otherwise successful HTML
      // record, but a JSON response cannot be verified without its payload.
      if (isJsonResponse(response)) throw new Error('book.read_record.response.invalid');
    }

    if (!response.ok) {
      throw new Error(`book.read_record.http.${response.status}`);
    }

    // A 200 from `/`, a login page, or another host means the server followed
    // a redirect and the record was never persisted. A missing/unparseable URL
    // is also rejected because it cannot prove that the reader route handled
    // the request.
    const finalTarget = urlTargetOf(response.url);
    if (
      !expectedTarget
      || !finalTarget
      || finalTarget.origin !== expectedTarget.origin
      || finalTarget.pathname !== expectedTarget.pathname
    ) {
      throw new Error('book.read_record.redirect');
    }

    // Some Talebook-compatible servers answer this route with an API payload.
    // In that case HTTP 200 is not enough: only the explicit success contract
    // may count as a persisted read.
    if (isJsonResponse(response)) {
      const payload = body ? parseJsonBody(body) : null;
      const err = payload && typeof payload === 'object' && 'err' in payload
        ? (payload as { err?: unknown }).err
        : undefined;
      if (err !== 'ok') {
        throw new Error(`book.read_record.api.${typeof err === 'string' && err ? err : 'invalid'}`);
      }
    }
  } finally {
    timeout.cleanup();
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
