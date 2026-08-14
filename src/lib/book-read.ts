type RequestLike = (url: string, init?: RequestInit) => Promise<Response>;
const READ_RECORD_TIMEOUT_MS = 10_000;

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
  const response = await requestLike(`${serverUrl}/read/${encodeURIComponent(String(bookId))}`, {
    credentials: 'include',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`book.read_record.http.${response.status}`);
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
