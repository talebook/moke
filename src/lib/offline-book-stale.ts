export type OfflineBookFreshnessStatus = 'fresh' | 'stale' | 'unknown' | 'unavailable';

export interface OfflineBookFreshnessResult {
  status: OfflineBookFreshnessStatus;
  remoteSignature?: string;
}

export interface OfflineBookStaleRecord {
  id: string;
  serverUrl?: string;
  bookId: string;
  format: string;
  sourceSignature?: string;
}

export interface OfflineBookHeadResponse {
  ok: boolean;
  headers: Pick<Headers, 'get'>;
}

export type OfflineBookHeadRequest = (
  url: string,
  init: { method: 'HEAD'; credentials: 'include' },
) => Promise<OfflineBookHeadResponse>;

export const OFFLINE_BOOK_STALE_DEBOUNCE_MS = 300;

const inFlightByRequester = new WeakMap<
  OfflineBookHeadRequest,
  Map<string, Promise<OfflineBookFreshnessResult>>
>();

function inFlightRequests(requestHead: OfflineBookHeadRequest): Map<string, Promise<OfflineBookFreshnessResult>> {
  const existing = inFlightByRequester.get(requestHead);
  if (existing) return existing;
  const created = new Map<string, Promise<OfflineBookFreshnessResult>>();
  inFlightByRequester.set(requestHead, created);
  return created;
}

/** Compare a saved source validator with the server without ever treating missing validators as fresh. */
export function checkOfflineBookFreshness(
  serverUrl: string,
  record: OfflineBookStaleRecord,
  requestHead: OfflineBookHeadRequest,
): Promise<OfflineBookFreshnessResult> {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  if (record.serverUrl && record.serverUrl.replace(/\/+$/, '') !== baseUrl) {
    return Promise.resolve({ status: 'unknown' });
  }
  if (!record.sourceSignature) return Promise.resolve({ status: 'unknown' });

  const requestKey = JSON.stringify([
    baseUrl, record.id, record.bookId, record.format, record.sourceSignature,
  ]);
  const inFlight = inFlightRequests(requestHead);
  const existing = inFlight.get(requestKey);
  if (existing) return existing;

  const request = (async (): Promise<OfflineBookFreshnessResult> => {
    try {
      const response = await requestHead(`${baseUrl}/api/book/${record.bookId}.${record.format}`, {
        method: 'HEAD',
        credentials: 'include',
      });
      if (!response.ok) return { status: 'unavailable' };
      const remoteSignature = response.headers.get('etag') || response.headers.get('last-modified');
      if (!remoteSignature) return { status: 'unknown' };
      return {
        status: remoteSignature === record.sourceSignature ? 'fresh' : 'stale',
        remoteSignature,
      };
    } catch {
      return { status: 'unavailable' };
    }
  })();

  inFlight.set(requestKey, request);
  void request.finally(() => {
    if (inFlight.get(requestKey) === request) inFlight.delete(requestKey);
  });
  return request;
}

export async function checkOfflineBooksFreshness(
  serverUrl: string,
  records: readonly OfflineBookStaleRecord[],
  requestHead: OfflineBookHeadRequest,
): Promise<Map<string, OfflineBookFreshnessResult>> {
  const entries = await Promise.all(records.map(async (record) => (
    [record.id, await checkOfflineBookFreshness(serverUrl, record, requestHead)] as const
  )));
  return new Map(entries);
}

/** Debounce record/terminal changes and ignore results superseded by a newer check. */
export class OfflineBookStaleCheckScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private readonly requestHead: OfflineBookHeadRequest;
  private readonly debounceMs: number;

  constructor(requestHead: OfflineBookHeadRequest, debounceMs = OFFLINE_BOOK_STALE_DEBOUNCE_MS) {
    this.requestHead = requestHead;
    this.debounceMs = debounceMs;
  }

  schedule(
    serverUrl: string,
    records: readonly OfflineBookStaleRecord[],
    onResult: (results: Map<string, OfflineBookFreshnessResult>) => void,
  ): void {
    this.generation += 1;
    const generation = this.generation;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void checkOfflineBooksFreshness(serverUrl, records, this.requestHead).then((results) => {
        if (this.generation === generation) onResult(results);
      });
    }, this.debounceMs);
  }

  cancel(): void {
    this.generation += 1;
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
