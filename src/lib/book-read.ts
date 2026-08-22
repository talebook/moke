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
  protocol: string;
  hostname: string;
  port: string;
  pathname: string;
}

/** Network target and decoded pathname of an absolute URL; null if unsafe. */
function urlTargetOf(url: string): UrlTarget | null {
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      pathname: decodeURIComponent(parsed.pathname).replace(/\/+$/, '') || '/',
    };
  } catch {
    return null;
  }
}

function isAllowedTarget(expected: UrlTarget, actual: UrlTarget): boolean {
  const allowedProtocol = actual.protocol === expected.protocol
    || (expected.protocol === 'http:' && actual.protocol === 'https:');
  return allowedProtocol
    && actual.hostname === expected.hostname
    && actual.port === expected.port
    && actual.pathname === expected.pathname;
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

function safeApiErrorCode(value: unknown): string {
  return typeof value === 'string'
    && value.length <= 64
    && /^[a-z0-9_.-]+$/.test(value)
    ? value
    : 'invalid';
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

    if (!response.ok) {
      throw new Error(`book.read_record.http.${response.status}`);
    }

    // A 200 from `/`, a login page, or another host means the server followed
    // a redirect and the record was never persisted. Browser fetch and the
    // pinned Tauri plugin-http expose the final URL; an empty value is therefore
    // unverifiable and must fail closed instead of bypassing redirect checks.
    const finalTarget = urlTargetOf(response.url);
    if (
      !expectedTarget
      || !finalTarget
      || !isAllowedTarget(expectedTarget, finalTarget)
    ) {
      throw new Error('book.read_record.redirect');
    }

    // Some Talebook-compatible servers answer this route with an API payload.
    // In that case HTTP 200 is not enough: only the explicit success contract
    // may count as a persisted read.
    if (isJsonResponse(response)) {
      let body: ArrayBuffer;
      try {
        body = await Promise.race([response.arrayBuffer(), timeout.expired]);
      } catch (error) {
        if (error instanceof Error && error.message === 'book.read_record.timeout') throw error;
        throw new Error('book.read_record.response.invalid');
      }
      const payload = parseJsonBody(body);
      const err = payload && typeof payload === 'object' && 'err' in payload
        ? (payload as { err?: unknown }).err
        : undefined;
      if (err !== 'ok') {
        throw new Error(`book.read_record.api.${safeApiErrorCode(err)}`);
      }
      return;
    }

    // Drain successful HTML only to release the native connection. Receiving
    // the expected response headers already proves the record route completed,
    // so a slow or failed drain must not turn a persisted record into an error.
    try {
      await Promise.race([response.arrayBuffer(), timeout.expired]);
    } catch {
      // The timeout still aborts/cancels the body resource, but remains a
      // best-effort cleanup outcome for HTML responses.
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
