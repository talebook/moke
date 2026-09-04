import { MokeApiError, readJsonResponse } from './api-core.ts';

const EPUB_MIME = 'application/epub+zip';
const SAFE_REVISION = /^[A-Za-z0-9._~-]{1,128}$/;
const SAFE_ETAG = /^[^\r\n]{1,256}$/;

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

export class OnlineReadingError extends Error {
  readonly code: OnlineReadingErrorCode;
  readonly status?: number;

  constructor(code: OnlineReadingErrorCode, status?: number) {
    super(code);
    this.name = 'OnlineReadingError';
    this.code = code;
    this.status = status;
  }
}

export interface TalebookOnlineSource {
  kind: 'talebook-online';
  url: string;
  format: 'epub';
  mimeType: typeof EPUB_MIME;
  revision: string;
  etag: string;
  size: number;
}

type RequestLike = (url: string, init?: RequestInit) => Promise<Response>;

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

function errorForStatus(status: number, bootstrap = false): OnlineReadingError {
  if (status === 401 || (status >= 300 && status < 400)) {
    return new OnlineReadingError('online.auth_required', status);
  }
  if (status === 403) return new OnlineReadingError('online.permission_denied', status);
  if (status === 404) {
    return new OnlineReadingError(
      bootstrap ? 'online.server_unsupported' : 'online.not_found',
      status,
    );
  }
  if (status === 409 || status === 412) {
    return new OnlineReadingError('online.resource_changed', status);
  }
  return new OnlineReadingError('online.network', status);
}

function errorForBootstrapCode(code: unknown, status: number): OnlineReadingError {
  switch (code) {
    case 'user.need_login':
    case 'user.activation_required':
      return new OnlineReadingError('online.auth_required', status);
    case 'user.no_permission':
    case 'permission':
      return new OnlineReadingError('online.permission_denied', status);
    case 'book.not_found':
      return new OnlineReadingError('online.not_found', status);
    case 'reader.format_unsupported':
    case 'reader.conversion_pending':
      return new OnlineReadingError('online.format_unsupported', status);
    case 'reader.resource_changed':
      return new OnlineReadingError('online.resource_changed', status);
    default:
      return errorForStatus(status, true);
  }
}

function parseCurrentServerOrigin(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.origin !== serverUrl.replace(/\/$/, '')
    ) {
      throw new Error('invalid');
    }
    return parsed.origin;
  } catch {
    throw new OnlineReadingError('online.response_invalid');
  }
}

function requireExactResponseUrl(response: Response, expectedUrl: string): void {
  if (response.redirected || response.url !== expectedUrl) {
    throw new OnlineReadingError('online.response_invalid', response.status);
  }
}

function validateBootstrap(
  data: BootstrapEnvelope,
  serverOrigin: string,
  bookId: string,
): Omit<TalebookOnlineSource, 'etag' | 'size'> {
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
    throw new OnlineReadingError('online.response_invalid');
  }

  let resource: URL;
  try {
    resource = new URL(resourceUrl, serverOrigin);
  } catch {
    throw new OnlineReadingError('online.response_invalid');
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
    throw new OnlineReadingError('online.response_invalid');
  }

  return {
    kind: 'talebook-online',
    url: resource.href,
    format: 'epub',
    mimeType: EPUB_MIME,
    revision,
  };
}

function safeCancel(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
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
 * No body is read here; Reader performs strict, on-demand 206 requests.
 */
export async function resolveTalebookOnlineSource(
  request: RequestLike,
  serverUrl: string,
  rawBookId: string | number,
  signal?: AbortSignal,
): Promise<TalebookOnlineSource> {
  const serverOrigin = parseCurrentServerOrigin(serverUrl);
  const bookId = String(rawBookId);
  if (!/^\d+$/.test(bookId)) throw new OnlineReadingError('online.response_invalid');

  const bootstrapUrl = `${serverOrigin}/api/book/${bookId}/reader-bootstrap?engine=readest`;
  let bootstrapResponse: Response;
  try {
    bootstrapResponse = await request(bootstrapUrl, noRedirectRequest(signal));
  } catch (error) {
    if (error instanceof OnlineReadingError) throw error;
    throw new OnlineReadingError('online.network');
  }

  requireExactResponseUrl(bootstrapResponse, bootstrapUrl);
  if (!bootstrapResponse.ok) {
    let envelope: BootstrapEnvelope | null = null;
    if (normalizedMime(bootstrapResponse.headers.get('content-type')) === 'application/json') {
      try {
        envelope = await readJsonResponse<BootstrapEnvelope>(bootstrapResponse);
      } catch {
        envelope = null;
      }
    } else {
      safeCancel(bootstrapResponse);
    }
    throw envelope?.err
      ? errorForBootstrapCode(envelope.err, bootstrapResponse.status)
      : errorForStatus(bootstrapResponse.status, true);
  }
  if (normalizedMime(bootstrapResponse.headers.get('content-type')) !== 'application/json') {
    safeCancel(bootstrapResponse);
    throw new OnlineReadingError('online.response_invalid', bootstrapResponse.status);
  }

  let bootstrap: BootstrapEnvelope;
  try {
    bootstrap = await readJsonResponse<BootstrapEnvelope>(bootstrapResponse);
  } catch (error) {
    if (error instanceof MokeApiError) {
      throw new OnlineReadingError('online.response_invalid', error.status);
    }
    throw new OnlineReadingError('online.response_invalid', bootstrapResponse.status);
  }
  if (bootstrap.err !== 'ok') {
    throw errorForBootstrapCode(bootstrap.err, bootstrapResponse.status);
  }
  const source = validateBootstrap(bootstrap, serverOrigin, bookId);

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
  requireExactResponseUrl(head, source.url);
  if (!head.ok) {
    await drainHeadResponse(head);
    throw errorForStatus(head.status);
  }
  if (head.status !== 200 || head.headers.get('accept-ranges')?.toLowerCase() !== 'bytes') {
    await drainHeadResponse(head);
    throw new OnlineReadingError('online.range_unsupported', head.status);
  }
  if (normalizedMime(head.headers.get('content-type')) !== source.mimeType) {
    await drainHeadResponse(head);
    throw new OnlineReadingError('online.mime_invalid', head.status);
  }
  const contentEncoding = head.headers.get('content-encoding');
  const size = Number(head.headers.get('content-length'));
  const etag = head.headers.get('etag');
  if (
    (contentEncoding && contentEncoding.toLowerCase() !== 'identity') ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !etag ||
    !SAFE_ETAG.test(etag)
  ) {
    await drainHeadResponse(head);
    throw new OnlineReadingError('online.response_invalid', head.status);
  }
  await drainHeadResponse(head);

  return { ...source, size, etag };
}

export function onlineReadingErrorMessage(error: unknown): string {
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
