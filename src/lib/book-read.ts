type RequestLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Notify Talebook through its canonical reader route after the local reader
 * has opened. That route owns both read_history persistence and the book's
 * read counter, so the client must not try to reproduce either mutation.
 */
export async function recordBookRead(
  requestLike: RequestLike,
  serverUrl: string,
  bookId: string | number,
): Promise<void> {
  const response = await requestLike(`${serverUrl}/read/${encodeURIComponent(String(bookId))}`, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`book.read_record.http.${response.status}`);
  }
}

export async function openAndRecordBookRead({
  open,
  record,
  onRecordError,
}: {
  open: () => Promise<void>;
  record: () => Promise<void>;
  onRecordError?: (error: unknown) => void;
}): Promise<void> {
  await open();
  try {
    await record();
  } catch (error) {
    onRecordError?.(error);
  }
}
