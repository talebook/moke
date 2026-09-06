import { retryOnlineRead } from './online-retry.ts';
import { MokeApiError, readJsonResponse } from './api-core.ts';

const EPUB_MIME = 'application/epub+zip';
const LEGACY_EPUB_MIME = 'application/octet-stream';
const SAFE_REVISION = /^[A-Za-z0-9._~-]{1,128}$/;
const SAFE_ETAG = /^[^\r\n]{1,256}$/;
const FIRST_BYTE_CONTENT_RANGE = /^bytes 0-0\/(\d+)$/;

export type OnlineReadingErrorCode =
  | 'online.auth_required'
  | 'online.permission_denied'
  | 'online.not_found'
  | 'online.format_unsupported'
  | 'online.server_unsupported'
  | 'online.resource_changed'
  | 'online.range_unsupported'
  | 'online.mime_invalid'
  | 'online.response_invalid'
  | 'online.network';

export type OnlineReadingErrorStage =
  | 'server-url'
  | 'book-id'
  | 'bootstrap-status'
  | 'head-status'
  | 'bootstrap-url'
  | 'bootstrap-mime'
  | 'bootstrap-body'
  | 'bootstrap-contract'
  | 'head-url'
  | 'head-metadata'
  | 'range-url'
  | 'range-status'
  | 'range-mime'
  | 'range-metadata'
  | 'range-body';

export class OnlineReadingError extends Error {
  readonly code: OnlineReadingErrorCode;
  readonly status?: number;
  readonly stage?: OnlineReadingErrorStage;

  constructor(
    code: OnlineReadingErrorCode,
    status?: number,
    stage?: OnlineReadingErrorStage,
  ) {
    // Console collectors often retain only Error.message/stack, not custom fields.
    // Include only local stage names and numeric status; never server text or URLs.
    super([code, stage, status === undefined ? undefined : `http-${status}`].filter(Boolean).join(':'));
    this.name = 'OnlineReadingError';
    this.code = code;
    this.status = status;
    this.stage = stage;
  }
}

export interface TalebookOnlineSource {
  kind: 'talebook-online';
  url: string;
  format: 'epub';
  mimeType: typeof EPUB_MIME;
  /** Null for the fixed legacy download route, whose identity comes from ETag. */
  revision: string | null;
  etag: string;
  size: number;
}

type RequestLike = (url: string, init?: RequestInit) => Promise<Response>;

type OnlineSourceCandidate = Omit<TalebookOnlineSource, 'etag' | 'size'> & {
  responseMimes: readonly string[];
};

type BootstrapEnvelope = {
  err?: unknown;
  schema?: unknown;
  engine?: unknown;
  book?: {
    id?: unknown;
    format?: unknown;
    revision?: unknown;
  };
  resource?: {
    kind?: unknown;
    url?: unknown;
    mime?: unknown;
    range?: unknown;
  };
};

function normalizedMime(value: string | null): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || '';
}

function noRedirectRequest(signal?: AbortSignal): RequestInit {
  return {
    credentials: 'include',
    redirect: 'manual',
    signal,
    // Consumed by @tauri-apps/plugin-http after request() preserves it.
    maxRedirections: 0,
  } as RequestInit;
}

function errorForStatus(
  status: number,
  stage: Extract<OnlineReadingErrorStage, 'bootstrap-status' | 'head-status' | 'range-status'>,
): OnlineReadingError {
  if (status >= 300 && status < 400) {
    return new OnlineReadingError('online.response_invalid', status, stage);
  }
  if (status === 401) {
    return new OnlineReadingError('online.auth_required', status, stage);
  }
  if (status === 403) return new OnlineReadingError('online.permission_denied', status, stage);
  if (status === 404) {
    return new OnlineReadingError(
      stage === 'bootstrap-status' ? 'online.server_unsupported' : 'online.not_found',
      status,
      stage,
    );
  }
  if (status === 409 || status === 412) {
    return new OnlineReadingError('online.resource_changed', status, stage);
  }
  return new OnlineReadingError('online.network', status, stage);
}

/** Only a permanent upgrade of the identical default-port bootstrap URL is trusted. */
function bootstrapHttpsUpgrade(response: Response, requestedUrl: string): string | null {
  if (response.status !== 301 && response.status !== 308) return null;
  const location = response.headers.get('location');
  if (!location) return null;
  try {
    const source = new URL(requestedUrl);
    const target = new URL(location, source);
    if (
      source.protocol !== 'http:' || source.port !== '' ||
      target.protocol !== 'https:' || target.port !== '' ||
      target.hostname !== source.hostname || target.username || target.password ||
      target.pathname !== source.pathname || target.search !== source.search || target.hash
    ) return null;
    return target.href;
  } catch {
    return null;
  }
}

function errorForBootstrapCode(code: unknown, status: number): OnlineReadingError {
  switch (code) {
    case 'user.need_login':
    case 'user.activation_required':
      return new OnlineReadingError('online.auth_required', status, 'bootstrap-body');
    case 'user.no_permission':
    case 'permission':
      return new OnlineReadingError('online.permission_denied', status, 'bootstrap-body');
    case 'book.not_found':
      return new OnlineReadingError('online.not_found', status, 'bootstrap-body');
    case 'reader.format_unsupported':
    case 'reader.conversion_pending':
      return new OnlineReadingError('online.format_unsupported', status, 'bootstrap-body');
    case 'reader.resource_changed':
      return new OnlineReadingError('online.resource_changed', status, 'bootstrap-body');
    default:
      return errorForStatus(status, 'bootstrap-status');
  }
}

function parseCurrentServerOrigin(serverUrl: string): string {
  try {
    // Persisted Moke data from older builds may retain whitespace, repeated
    // trailing slashes, uppercase schemes/hosts or an explicit default port.
    // URL canonicalization makes all of those equivalent to the same origin;
    // rejecting their spelling before issuing any request caused the field
    // failure to surface as online.response_invalid.
    const parsed = new URL(serverUrl.trim());
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      !/^\/+$/u.test(parsed.pathname) ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('invalid');
    }
    return parsed.origin;
  } catch {
    throw new OnlineReadingError('online.response_invalid', undefined, 'server-url');
  }
}

function requireExactResponseUrl(
  response: Response,
  expectedUrl: string,
  stage: Extract<OnlineReadingErrorStage, 'bootstrap-url' | 'head-url' | 'range-url'>,
): void {
  if (response.redirected || response.url !== expectedUrl) {
    throw new OnlineReadingError('online.response_invalid', response.status, stage);
  }
}

function validateBootstrap(
  data: BootstrapEnvelope,
  serverOrigin: string,
  bookId: string,
): OnlineSourceCandidate {
  const revision = data.book?.revision;
  const resourceUrl = data.resource?.url;
  if (
    data.err !== 'ok' ||
    data.schema !== 'talebook.reader.bootstrap.v1' ||
    data.engine !== 'readest' ||
    String(data.book?.id) !== bookId ||
    data.book?.format !== 'epub' ||
    typeof revision !== 'string' ||
    !SAFE_REVISION.test(revision) ||
    data.resource?.kind !== 'authorized-epub-url' ||
    data.resource?.mime !== EPUB_MIME ||
    data.resource?.range !== true ||
    typeof resourceUrl !== 'string' ||
    !resourceUrl.startsWith('/') ||
    resourceUrl.startsWith('//')
  ) {
    throw new OnlineReadingError('online.response_invalid', undefined, 'bootstrap-contract');
  }

  let resource: URL;
  try {
    resource = new URL(resourceUrl, serverOrigin);
  } catch {
    throw new OnlineReadingError('online.response_invalid', undefined, 'bootstrap-contract');
  }
  const keys = [...resource.searchParams.keys()];
  const revisions = resource.searchParams.getAll('revision');
  if (
    resource.origin !== serverOrigin ||
    resource.username ||
    resource.password ||
    resource.hash ||
    resource.pathname !== `/read/resource/${bookId}.epub` ||
    keys.length !== 1 ||
    keys[0] !== 'revision' ||
    revisions.length !== 1 ||
    revisions[0] !== revision
  ) {
    throw new OnlineReadingError('online.response_invalid', undefined, 'bootstrap-contract');
  }

  return {
    kind: 'talebook-online',
    url: resource.href,
    format: 'epub',
    mimeType: EPUB_MIME,
    revision,
    responseMimes: [EPUB_MIME],
  };
}

/**
 * Talebook Android streams the fixed download URL into Readium and injects
 * its authenticated cookie into every request. Talebook has served this URL
 * since the early 3.x releases; Tornado StaticFileHandler-backed releases
 * (3.7+) also provide the exact single-range contract Readest needs.
 *
 * Keep the route derived from the trusted server/book instead of accepting a
 * URL from legacy response data. Older releases that ignore Range are still
 * rejected by the one-byte probe, never buffered as an online fallback.
 */
function legacyOnlineSource(serverOrigin: string, bookId: string): OnlineSourceCandidate {
  return {
    kind: 'talebook-online',
    url: `${serverOrigin}/api/book/${bookId}.epub`,
    format: 'epub',
    mimeType: EPUB_MIME,
    revision: null,
    responseMimes: [EPUB_MIME, LEGACY_EPUB_MIME],
  };
}

function sourceAcceptsMime(source: OnlineSourceCandidate, value: string | null): boolean {
  return source.responseMimes.includes(normalizedMime(value));
}

async function safeCancel(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function drainHeadResponse(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Header validation already succeeded; disposal errors must not turn the
    // source into a failure or race Tauri's eagerly-finished body resource.
  }
}

/**
 * Resolve and preflight Talebook's authorization-checked EPUB resource.
 * Only the one-byte Range proof is consumed; Reader loads the book on demand.
 */
async function resolveTalebookOnlineSourceOnce(
  request: RequestLike,
  serverUrl: string,
  rawBookId: string | number,
  signal?: AbortSignal,
  rangeRequest: RequestLike = request,
): Promise<TalebookOnlineSource> {
  let serverOrigin = parseCurrentServerOrigin(serverUrl);
  const bookId = String(rawBookId).trim();
  if (!/^\d+$/.test(bookId)) {
    throw new OnlineReadingError('online.response_invalid', undefined, 'book-id');
  }

  let bootstrapUrl = `${serverOrigin}/api/book/${bookId}/reader-bootstrap?engine=readest`;
  let bootstrapResponse: Response;
  try {
    bootstrapResponse = await request(bootstrapUrl, noRedirectRequest(signal));
    requireExactResponseUrl(bootstrapResponse, bootstrapUrl, 'bootstrap-url');
    const upgradedUrl = bootstrapHttpsUpgrade(bootstrapResponse, bootstrapUrl);
    if (upgradedUrl) {
      await safeCancel(bootstrapResponse);
      if (signal?.aborted) throw new DOMException('Online read cancelled', 'AbortError');
      // No general redirect following: a second redirect is rejected below.
      bootstrapUrl = upgradedUrl;
      serverOrigin = new URL(upgradedUrl).origin;
      bootstrapResponse = await request(bootstrapUrl, noRedirectRequest(signal));
    }
  } catch (error) {
    if (error instanceof OnlineReadingError) throw error;
    throw new OnlineReadingError('online.network');
  }

  requireExactResponseUrl(bootstrapResponse, bootstrapUrl, 'bootstrap-url');
  const bootstrapMime = normalizedMime(bootstrapResponse.headers.get('content-type'));
  let source: OnlineSourceCandidate;
  if (!bootstrapResponse.ok) {
    let envelope: BootstrapEnvelope | null = null;
    if (bootstrapMime === 'application/json') {
      try {
        envelope = await readJsonResponse<BootstrapEnvelope>(bootstrapResponse);
      } catch {
        envelope = null;
      }
    } else {
      await safeCancel(bootstrapResponse);
    }

    // Servers before the Readest bootstrap endpoint return an unstructured
    // 404 page here. Follow Talebook Android's fixed EPUB download route, but
    // only keep it when the real native GET proves exact 206 Range. A newer
    // server's structured book/format error must never take this downgrade.
    if (bootstrapResponse.status === 404 && !envelope?.err) {
      source = legacyOnlineSource(serverOrigin, bookId);
    } else {
      throw envelope?.err
        ? errorForBootstrapCode(envelope.err, bootstrapResponse.status)
        : errorForStatus(bootstrapResponse.status, 'bootstrap-status');
    }
  } else {
    if (bootstrapMime !== 'application/json') {
      await safeCancel(bootstrapResponse);
      throw new OnlineReadingError(
        'online.response_invalid',
        bootstrapResponse.status,
        'bootstrap-mime',
      );
    }

    let bootstrap: BootstrapEnvelope;
    try {
      bootstrap = await readJsonResponse<BootstrapEnvelope>(bootstrapResponse);
    } catch (error) {
      if (error instanceof MokeApiError) {
        throw new OnlineReadingError('online.response_invalid', error.status, 'bootstrap-body');
      }
      throw new OnlineReadingError(
        'online.response_invalid',
        bootstrapResponse.status,
        'bootstrap-body',
      );
    }
    if (bootstrap.err !== 'ok') {
      throw errorForBootstrapCode(bootstrap.err, bootstrapResponse.status);
    }
    source = validateBootstrap(bootstrap, serverOrigin, bookId);
  }

  let head: Response;
  try {
    head = await request(source.url, {
      ...noRedirectRequest(signal),
      method: 'HEAD',
      headers: { 'Accept-Encoding': 'identity' },
    });
  } catch {
    throw new OnlineReadingError('online.network');
  }
  requireExactResponseUrl(head, source.url, 'head-url');

  let headSize: number | null = null;
  let headEtag: string | null = null;
  if (head.status === 200) {
    const headMime = normalizedMime(head.headers.get('content-type'));
    if (headMime && !sourceAcceptsMime(source, headMime)) {
      await drainHeadResponse(head);
      throw new OnlineReadingError('online.mime_invalid', head.status, 'head-metadata');
    }
    const contentEncoding = head.headers.get('content-encoding');
    const contentLength = head.headers.get('content-length');
    const etag = head.headers.get('etag');
    if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
      await drainHeadResponse(head);
      throw new OnlineReadingError('online.response_invalid', head.status, 'head-metadata');
    }
    if (contentLength !== null) {
      headSize = Number(contentLength);
      if (!Number.isSafeInteger(headSize) || headSize <= 0) {
        await drainHeadResponse(head);
        throw new OnlineReadingError('online.response_invalid', head.status, 'head-metadata');
      }
    }
    if (etag !== null) {
      if (!SAFE_ETAG.test(etag)) {
        await drainHeadResponse(head);
        throw new OnlineReadingError('online.response_invalid', head.status, 'head-metadata');
      }
      headEtag = etag;
    }
  } else if (head.status !== 405 && head.status !== 501) {
    await drainHeadResponse(head);
    if (!head.ok) throw errorForStatus(head.status, 'head-status');
    throw new OnlineReadingError('online.response_invalid', head.status, 'head-metadata');
  }
  await drainHeadResponse(head);

  // HEAD claims are not enough: the original regression advertised byte
  // ranges but the Reader's first GET arrived upstream without Range and got
  // a full 200. Probe one byte through the exact transport Reader will use.
  // A HEAD-incompatible server is accepted only when this real probe is a
  // fully valid 206; a full 200 body is cancelled without being downloaded.
  let probe: Response;
  try {
    probe = await rangeRequest(source.url, {
      ...noRedirectRequest(signal),
      method: 'GET',
      headers: {
        'Accept-Encoding': 'identity',
        Range: 'bytes=0-0',
      },
    });
  } catch {
    throw new OnlineReadingError('online.network');
  }
  requireExactResponseUrl(probe, source.url, 'range-url');
  if (probe.status === 200) {
    await safeCancel(probe);
    throw new OnlineReadingError('online.range_unsupported', probe.status, 'range-status');
  }
  if (probe.status === 416) {
    await safeCancel(probe);
    throw new OnlineReadingError('online.resource_changed', probe.status);
  }
  if (!probe.ok) {
    await safeCancel(probe);
    throw errorForStatus(probe.status, 'range-status');
  }
  if (probe.status !== 206) {
    await safeCancel(probe);
    throw new OnlineReadingError('online.response_invalid', probe.status, 'range-status');
  }
  if (!sourceAcceptsMime(source, probe.headers.get('content-type'))) {
    await safeCancel(probe);
    throw new OnlineReadingError('online.mime_invalid', probe.status, 'range-mime');
  }

  const contentEncoding = probe.headers.get('content-encoding');
  const contentRange = probe.headers.get('content-range')?.match(FIRST_BYTE_CONTENT_RANGE);
  const size = Number(contentRange?.[1]);
  const etag = probe.headers.get('etag');
  if (
    (contentEncoding && contentEncoding.toLowerCase() !== 'identity') ||
    probe.headers.get('content-length') !== '1' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !etag ||
    !SAFE_ETAG.test(etag)
  ) {
    await safeCancel(probe);
    throw new OnlineReadingError('online.response_invalid', probe.status, 'range-metadata');
  }
  if (headSize !== null && headSize !== size) {
    await safeCancel(probe);
    throw new OnlineReadingError('online.resource_changed', probe.status);
  }
  if (headEtag !== null && headEtag !== etag) {
    await safeCancel(probe);
    throw new OnlineReadingError('online.resource_changed', probe.status);
  }

  let firstByte: ArrayBuffer;
  try {
    firstByte = await probe.arrayBuffer();
  } catch {
    throw new OnlineReadingError('online.network', probe.status);
  }
  if (firstByte.byteLength !== 1) {
    throw new OnlineReadingError('online.response_invalid', probe.status, 'range-body');
  }

  return {
    kind: source.kind,
    url: source.url,
    format: source.format,
    mimeType: source.mimeType,
    revision: source.revision,
    size,
    etag,
  };
}

/** Retry only transient connection failures; protocol/auth failures require user action. */
export async function resolveTalebookOnlineSource(
  request: RequestLike,
  serverUrl: string,
  rawBookId: string | number,
  signal?: AbortSignal,
  rangeRequest: RequestLike = request,
): Promise<TalebookOnlineSource> {
  try {
    return await retryOnlineRead(
      (attemptSignal) => resolveTalebookOnlineSourceOnce(
        request, serverUrl, rawBookId, attemptSignal, rangeRequest,
      ),
      (error) => error instanceof DOMException && error.name === 'TimeoutError' ||
        error instanceof OnlineReadingError && error.code === 'online.network' &&
        (error.status === undefined || [408, 502, 503, 504].includes(error.status)),
      signal ?? new AbortController().signal,
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new OnlineReadingError('online.network');
    }
    throw error;
  }
}

export function onlineReadingErrorMessage(error: unknown): string {
  if (error instanceof OnlineReadingError && error.status && error.status >= 300 && error.status < 400) {
    return '在线阅读请求被服务器重定向，请检查书库地址是否应使用 HTTPS；无法验证的跳转已停止。';
  }
  const code = error instanceof OnlineReadingError ? error.code : 'online.network';
  switch (code) {
    case 'online.auth_required':
      return '登录状态已失效，请重新登录后重试在线阅读，或下载后阅读。';
    case 'online.permission_denied':
      return '当前账号没有在线阅读权限，请联系管理员，或在有下载权限时下载后阅读。';
    case 'online.not_found':
      return '书籍资源不存在或已被移除，请刷新书籍信息。';
    case 'online.format_unsupported':
      return '当前书籍格式暂不支持在线阅读，请下载后阅读。';
    case 'online.server_unsupported':
      return '当前 Talebook 服务器尚未提供安全的在线读取接口，请更新服务器或下载后阅读。';
    case 'online.resource_changed':
      return '书籍资源已更新，请重试在线阅读以加载新版本。';
    case 'online.range_unsupported':
      return '服务器不支持按需读取，已停止在线打开；请下载后阅读。';
    case 'online.mime_invalid':
      return '服务器返回的书籍类型异常，已拒绝打开；请检查服务器或下载后阅读。';
    case 'online.response_invalid':
      return '服务器在线阅读响应不符合安全要求，请更新服务器或下载后阅读。';
    default:
      return '在线阅读连接失败，请检查网络后重试，或使用下方“下载后阅读”。';
  }
}
