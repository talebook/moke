import { readConnectionWelcome } from '@/lib/server-connection';
import { throwIfAborted } from '@/lib/abort-signal';
import type { ServerCapabilities } from '@/lib/store/server';
import { useServerStore } from '@/lib/store/server';
import { debugLog } from '@/lib/debug-log';
import { getSafeErrorCode, logHttpErrorMetadata } from '@/lib/api-log';
import {
  attachSafeJsonReader,
  buildTauriBinaryHeaders,
  buildTauriRequestInit,
  cancelResponseBodyQuietly,
  drainResponseBodyQuietly,
  getErrorMessage,
  isAbsoluteHttpUrl,
  MokeApiError,
  readApiJson,
  readJsonResponse,
  resolveAppPlatform,
} from '@/lib/api-core';
import {
  classifyOfflineRangeResponse,
  hasEpubCentralDirectory,
  parseContentRange,
} from '@/lib/offline-book-core';
import {
  resolveCurrentUserResult,
  type CurrentUserResult,
  type UserInfoResponse,
} from '@/lib/server-session';
import { discoverGeneralServerCapabilities } from '@/lib/server-capabilities';
export { getErrorMessage, MokeApiError, readApiJson, readJsonResponse } from '@/lib/api-core';

const appPlatform = resolveAppPlatform(process.env.NEXT_PUBLIC_APP_PLATFORM);
const isTauriApp = appPlatform === 'tauri';

function isRequestCancelled(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /request cancell?ed|aborted?/i.test(message);
}

function binaryTransferErrorDetail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function logBinaryTransferFailure(
  url: string,
  response: Response,
  error: unknown,
  receivedBytes: number,
): void {
  debugLog('error', 'download', `✗ GET ${url} 响应正文读取失败`, {
    status: response.status,
    receivedBytes,
    expectedBytes: Number(response.headers.get('content-length') || 0),
    contentRange: response.headers.get('content-range'),
    contentEncoding: response.headers.get('content-encoding'),
    error: binaryTransferErrorDetail(error),
  }, 'network');
}

function logOfflineWriteFailure(error: unknown, receivedBytes: number): void {
  debugLog('error', 'download', '✗ 下载内容写入本地文件失败', {
    receivedBytes,
    error: binaryTransferErrorDetail(error),
  });
}

async function validateDownloadedBook(blob: Blob, format: string): Promise<Blob> {
  if (format.toLowerCase() === 'epub' && !(await hasEpubCentralDirectory(blob))) {
    throw new Error('book.epub.invalid');
  }
  return blob;
}

export async function request(
  url: string | URL,
  options?: RequestInit,
  diagnostics?: { expectedStatuses?: readonly number[] },
): Promise<Response> {
  const urlStr = url.toString();
  const method = (options?.method || 'GET').toUpperCase();

  // 关键检测：Tauri 桌面端必须使用绝对 URL（http(s)://...），
  // 否则没有"当前域名"可拼接，会直接网络异常。
  if (!isAbsoluteHttpUrl(urlStr)) {
    debugLog(
      'error',
      'request',
      `Request rejected: ${method} ${urlStr}; missing absolute server URL`,
      'Connection information is unavailable.',
    );
    throw new Error('server.url.missing');
  }

  debugLog('info', 'request', `→ ${method} ${urlStr}`, {
    platform: isTauriApp ? 'tauri' : 'web',
    credentials: options?.credentials,
  });

  let response: Response;
  const startedAt = Date.now();
  try {
    if (isTauriApp) {
      const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
      // Tauri 桌面端：使用插件 fetch。需要显式放宽以兼容自建 Talebook 服务器：
      // - danger.acceptInvalidCerts: 允许自签名 / 内网 HTTPS 证书
      // - maxRedirections: 跟随登录后的重定向（与浏览器行为一致）
      response = await tauriFetch(urlStr, buildTauriRequestInit(options) as any);
    } else {
      response = await fetch(url, options);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    if (options?.signal?.aborted || isRequestCancelled(e)) {
      debugLog('info', 'request', `⊘ ${method} ${urlStr} 已取消 (${Date.now() - startedAt}ms)`);
      throw e;
    }
    debugLog('error', 'request', `✗ ${method} ${urlStr} 网络异常 (${Date.now() - startedAt}ms)`, errMsg);
    // 不在这里弹 toast：页面层各自 catch 后按业务文案提示，
    // 避免网络错误时页面 toast 与这里重复弹出两条。此处只记录日志。
    throw e;
  }

  const elapsed = Date.now() - startedAt;
  const expectedStatus = diagnostics?.expectedStatuses?.includes(response.status) === true;
  const level = response.ok ? 'success' : expectedStatus ? 'info' : 'error';
  debugLog(level, 'request', `← ${response.status} ${method} ${urlStr} (${elapsed}ms)`, {
    status: response.status,
    contentType: response.headers.get('content-type'),
  });

  // 历史调用点仍有直接使用 response.json() 的情况。统一改为单次文本读取，
  // 使所有 JSON 入口都不再暴露底层流关闭/解析异常，且可保留纯文本网关原因。
  return attachSafeJsonReader(response);
}

/**
 * 通过带认证的 request 获取图片字节，下方缓存再生成 <img src> 的 object URL。
 *
 * 为什么需要它：在 Tauri 桌面端，前端运行在自定义协议（tauri://localhost），
 * 与 http(s):// 服务器跨源。<img src> 由 WebView 直接发起，绕过 tauriFetch 插件，
 * 也拿不到登录后由 Rust 侧 cookie jar 维护的 session，因此会 401。
 * 这里改为用 request()（Tauri 下走 tauriFetch、自动带认证）拉取字节再转 blob。
 *
 * 生命周期由缓存管理：调用方用 acquire/release（下方），不要自行 revoke，
 * 否则命中的缓存 URL 会失效。
 */
async function loadImageBlob(imageUrl: string, signal: AbortSignal): Promise<Blob> {
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error('image.url.invalid');
  }
  const startedAt = Date.now();
  debugLog('info', 'image', `→ GET ${imageUrl}`);
  try {
    const response = await request(imageUrl, { credentials: 'include', signal });
    // Some native bridges can return a response after cancellation.
    if (signal.aborted) {
      void cancelResponseBodyQuietly(response);
      throw new DOMException('Image load cancelled', 'AbortError');
    }
    if (!response.ok) {
      void cancelResponseBodyQuietly(response);
      debugLog(
        'error',
        'image',
        `✗ ${response.status} 封面/图片加载失败 ${imageUrl} (${Date.now() - startedAt}ms)`,
        response.status === 401 ? '未授权：登录会话可能未携带或已失效' : `HTTP ${response.status}`,
      );
      throw new Error(`image.http.${response.status}`);
    }
    const blob = await response.blob();
    if (signal.aborted) throw new DOMException('Image load cancelled', 'AbortError');
    debugLog(
      'success',
      'image',
      `← 图片加载成功 ${imageUrl} (${Date.now() - startedAt}ms)`,
      { type: blob.type, size: blob.size },
    );
    return blob;
  } catch (e) {
    const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    debugLog(signal.aborted ? 'info' : 'error', 'image', `✗ 图片加载异常 ${imageUrl}`, errMsg);
    throw e;
  }
}

/**
 * 封面/图片 object URL 缓存。
 *
 * 背景：Tauri 下每张封面都要经过一次带认证的 fetch + createObjectURL。
 * 列表页一屏几十张、翻页/返回时同一本书会反复出现，若每次都重新下载，
 * 会同时打满并发连接并重复消耗流量。
 *
 * 规则：
 * - 同一 URL 并发请求合并为一次（in-flight 去重）；
 * - 加载完成的 object URL 进入 LRU 缓存，按引用计数淘汰（仅淘汰没有组件在用的）；
 * - 全局并发上限，避免挂载瞬间发起整页请求风暴。
 */
const IMAGE_CACHE_LIMIT = 128;
const IMAGE_FETCH_CONCURRENCY = 6;
// Includes queueing, the request, and response body consumption.
const IMAGE_FETCH_TIMEOUT_MS = 15_000;

interface ImageFetchTask {
  promise: Promise<string>;
  start: () => void;
  cancel: (reason: DOMException) => void;
}

const imageObjectUrlCache = new Map<string, string>();
const imageObjectUrlInflight = new Map<string, ImageFetchTask>();
const imageObjectUrlRefCounts = new Map<string, number>();
const imageFetchQueue: ImageFetchTask[] = [];
let activeImageFetches = 0;

function imageCacheKey(imageUrl: string, sessionRevision: number): string {
  return `${sessionRevision}\0${imageUrl}`;
}

function drainImageFetchQueue(): void {
  while (activeImageFetches < IMAGE_FETCH_CONCURRENCY && imageFetchQueue.length > 0) {
    imageFetchQueue.shift()?.start();
  }
}

function queueImageFetch(key: string, imageUrl: string): ImageFetchTask {
  const controller = new AbortController();
  let running = false;
  let settled = false;
  let resolve!: (objectUrl: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const finish = (error: unknown, blob?: Blob) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const queuedIndex = imageFetchQueue.indexOf(task);
    if (queuedIndex >= 0) imageFetchQueue.splice(queuedIndex, 1);
    if (imageObjectUrlInflight.get(key) === task) imageObjectUrlInflight.delete(key);
    let objectUrl: string | undefined;
    if (blob) {
      try {
        objectUrl = URL.createObjectURL(blob);
        imageObjectUrlCache.set(key, objectUrl);
        evictUnusedImageObjectUrls();
      } catch (cause) {
        error = cause;
      }
    }
    if (objectUrl !== undefined) resolve(objectUrl);
    else reject(error);
    // Release once, even when the native request ignores abort or settles late.
    if (running) activeImageFetches -= 1;
    drainImageFetchQueue();
  };
  const task: ImageFetchTask = {
    promise,
    start: () => {
      if (settled) return;
      running = true;
      activeImageFetches += 1;
      // Only create an object URL in finish, so late results cannot leak URLs
      // or populate the cache of a replacement task with the same key.
      void loadImageBlob(imageUrl, controller.signal).then((blob) => finish(undefined, blob), finish);
    },
    cancel: (reason) => {
      if (settled) return;
      controller.abort();
      finish(reason);
    },
  };
  const timer = setTimeout(() => task.cancel(new DOMException('Image load timed out', 'TimeoutError')), IMAGE_FETCH_TIMEOUT_MS);
  imageObjectUrlInflight.set(key, task);
  imageFetchQueue.push(task);
  drainImageFetchQueue();
  return task;
}

function evictUnusedImageObjectUrls(): void {
  if (imageObjectUrlCache.size <= IMAGE_CACHE_LIMIT) return;
  for (const [url, objectUrl] of imageObjectUrlCache) {
    if (imageObjectUrlCache.size <= IMAGE_CACHE_LIMIT) break;
    if ((imageObjectUrlRefCounts.get(url) ?? 0) > 0) continue;
    imageObjectUrlCache.delete(url);
    URL.revokeObjectURL(objectUrl);
  }
}

function revokeUnusedImageObjectUrl(key: string): void {
  if (imageObjectUrlRefCounts.has(key)) return;
  const objectUrl = imageObjectUrlCache.get(key);
  if (objectUrl === undefined) return;
  imageObjectUrlCache.delete(key);
  URL.revokeObjectURL(objectUrl);
}

useServerStore.subscribe((state, previous) => {
  if (state.sessionRevision === previous.sessionRevision) return;
  const currentPrefix = `${state.sessionRevision}\0`;
  for (const key of imageObjectUrlCache.keys()) {
    // Mounted consumers retain their URLs until their final release.
    if (!key.startsWith(currentPrefix)) revokeUnusedImageObjectUrl(key);
  }
});

/** 同步读取已缓存（且未被淘汰）的 object URL，用于避免重复加载时的回退闪烁。 */
export function getCachedImageObjectUrl(imageUrl: string, sessionRevision: number): string | null {
  return imageObjectUrlCache.get(imageCacheKey(imageUrl, sessionRevision)) ?? null;
}

/**
 * 获取图片 object URL 并持有一次引用。调用方在图片不再使用时必须调用
 * releaseImageObjectUrl；不要自行 URL.revokeObjectURL。
 */
export function acquireImageObjectUrl(imageUrl: string, sessionRevision: number): Promise<string> {
  const key = imageCacheKey(imageUrl, sessionRevision);
  imageObjectUrlRefCounts.set(key, (imageObjectUrlRefCounts.get(key) ?? 0) + 1);

  const cached = imageObjectUrlCache.get(key);
  if (cached !== undefined) {
    // 命中即刷新 LRU 位置（Map 迭代顺序即插入顺序）。
    imageObjectUrlCache.delete(key);
    imageObjectUrlCache.set(key, cached);
    return Promise.resolve(cached);
  }

  const inflight = imageObjectUrlInflight.get(key);
  if (inflight) return inflight.promise;
  return queueImageFetch(key, imageUrl).promise;
}

/** 释放一次图片引用；引用归零后该图片才允许被淘汰。 */
export function releaseImageObjectUrl(imageUrl: string, sessionRevision: number): void {
  const key = imageCacheKey(imageUrl, sessionRevision);
  const count = imageObjectUrlRefCounts.get(key) ?? 0;
  if (count <= 1) imageObjectUrlRefCounts.delete(key);
  else imageObjectUrlRefCounts.set(key, count - 1);
  const task = imageObjectUrlInflight.get(key);
  if (count <= 1 && task) {
    // React StrictMode immediately re-runs effects. Let that same-turn acquire
    // retain the shared task before cancelling genuinely unmounted consumers.
    queueMicrotask(() => {
      if (!imageObjectUrlRefCounts.has(key) && imageObjectUrlInflight.get(key) === task) {
        task.cancel(new DOMException('Image load cancelled', 'AbortError'));
      }
    });
  }
  if (sessionRevision !== useServerStore.getState().sessionRevision) revokeUnusedImageObjectUrl(key);
  evictUnusedImageObjectUrls();
}

/**
 * /api/user/info 在途去重。能力探测一轮会由 fetchCurrentUser、fetchServerInfo、
 * discoverServerCapabilities 同时请求同一端点，这里合并为一次请求，各自复用解析结果。
 * 仅在同一会话的请求在途期间合并，不做 TTL 缓存。凭据改变后必须先
 * invalidateSession，再确认用户，避免复用改变 Cookie 之前的响应。
 */
interface UserInfoPayload {
  ok: boolean;
  status: number;
  data: UserInfoResponse;
  parseError: unknown;
}

const userInfoInflight = new Map<string, Promise<UserInfoPayload>>();
// A successful sign-in changes the cookie before the new account is known.
// Isolate its verification from old requests without remounting the form in
// the middle of the Reader-reserved authentication operation.
export function invalidateUserInfoCache(): void { userInfoInflight.clear(); }
const userInfoSignalIds = new WeakMap<AbortSignal, number>();
let nextUserInfoSignalId = 0;
// Bound both headers and body, including native bridges that ignore abort.
const USER_INFO_TIMEOUT_MS = 15_000;

function fetchUserInfoPayload(serverUrl: string, signal?: AbortSignal): Promise<UserInfoPayload> {
  throwIfAborted(signal);
  if (signal && !userInfoSignalIds.has(signal)) userInfoSignalIds.set(signal, ++nextUserInfoSignalId);
  // Share one provider round without letting an unrelated consumer's abort
  // cancel another form. Cookie/session changes always get a distinct key.
  const key = `${useServerStore.getState().sessionRevision}\0${serverUrl}\0${signal ? userInfoSignalIds.get(signal) : 'default'}`;
  const existing = userInfoInflight.get(key);
  if (existing) return existing;

  const controller = new AbortController();
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  let rejectStopped!: (reason: unknown) => void;
  const cancel = () => {
    expired = true;
    const reason = signal?.reason ?? new DOMException('User info request cancelled', 'AbortError');
    rejectStopped(reason);
    controller.abort(reason);
  };
  const timeout = new Promise<never>((_, reject) => {
    rejectStopped = reject;
    timer = setTimeout(() => {
      expired = true;
      reject(new DOMException('User info request timed out', 'TimeoutError'));
      controller.abort();
    }, USER_INFO_TIMEOUT_MS);
  });
  signal?.addEventListener('abort', cancel, { once: true });
  const loading = (async (): Promise<UserInfoPayload> => {
    const response = await request(`${serverUrl}/api/user/info`, { credentials: 'include', signal: controller.signal });
    if (expired) {
      void cancelResponseBodyQuietly(response);
      throw new DOMException('User info request timed out', 'TimeoutError');
    }
    try {
      return { ok: response.ok, status: response.status, data: await readJsonResponse<UserInfoResponse>(response), parseError: null };
    } catch (error) {
      return { ok: response.ok, status: response.status, data: {} as UserInfoResponse, parseError: error };
    }
  })();
  const promise = Promise.race([loading, timeout]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    if (userInfoInflight.get(key) === promise) userInfoInflight.delete(key);
  });

  userInfoInflight.set(key, promise);
  return promise;
}

export async function welcomeCheck(code?: string): Promise<{ err: string; msg?: string }> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const body = new URLSearchParams();

  if (code) {
    body.append('invite_code', code);
  }

  const response = await request(`${serverUrl}/api/welcome`, {
    method: code ? 'POST' : 'GET',
    body: code ? body : undefined,
    credentials: 'include',
  });
  return readJsonResponse(response);
}

export async function fetchCurrentUser(serverUrlOverride?: string, signal?: AbortSignal): Promise<CurrentUserResult> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const payload = await fetchUserInfoPayload(serverUrlOverride ?? serverUrl, signal);
  throwIfAborted(signal);
  if (payload.parseError) throw payload.parseError;
  return resolveCurrentUserResult(payload.data, payload.ok, payload.status);
}

export async function fetchServerInfo(server?: string, signal?: AbortSignal): Promise<{ err: string; msg?: string; title: string; version: string }> {
  const serverUrl = server ?? (await import('@/lib/store/server')).useServerStore.getState().serverUrl;
  if (!serverUrl) {
    // 未连接服务器时直接返回空信息，避免发起无前缀 URL 的请求
    return { err: 'no_server', title: '', version: '' };
  }
  const payload = await fetchUserInfoPayload(serverUrl, signal);
  throwIfAborted(signal);
  if (payload.parseError) throw payload.parseError;
  const data = payload.data;

  return {
    err: data.err,
    msg: data.msg,
    title: data.sys?.title || '',
    version: data.sys?.version || '',
  };
}

async function probeJsonEndpoint(serverUrl: string, path: string, signal?: AbortSignal): Promise<boolean> {
  try {
    throwIfAborted(signal);
    const response = await request(`${serverUrl}${path}`, {
      credentials: 'include', signal,
    });
    throwIfAborted(signal);

    if (response.status === 404 || response.status === 405) return false;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return response.ok;

    const data = await readJsonResponse<any>(response).catch(() => null);
    throwIfAborted(signal);
    const err = typeof data?.err === 'string' ? data.err : '';

    if (!err) return response.ok;
    if (err === 'page.not_found' || err === 'handler.not_found' || err === 'api.not_found') return false;
    return true;
  } catch (error) {
    throwIfAborted(signal);
    debugLog('warn', 'capabilities', `能力探测失败: ${path}`, getErrorMessage(error));
    return false;
  }
}

async function findSampleBookId(serverUrl: string, signal?: AbortSignal): Promise<string | null> {
  const candidates = ['/api/shelf', '/api/library?num=1', '/api/library?page=1&num=1'];

  for (const path of candidates) {
    try {
      throwIfAborted(signal);
      const response = await request(`${serverUrl}${path}`, { credentials: 'include', signal });
      throwIfAborted(signal);
      if (!response.ok) continue;

      const data = await readJsonResponse<any>(response).catch(() => null);
      throwIfAborted(signal);
      const books = data?.books || data?.items || data?.data?.books || data?.data?.items;
      if (Array.isArray(books) && books.length > 0 && books[0]?.id != null) {
        return String(books[0].id);
      }
    } catch (error) {
      throwIfAborted(signal);
      debugLog('warn', 'capabilities', `样本书籍探测失败: ${path}`, getErrorMessage(error));
    }
  }

  return null;
}

export async function discoverServerCapabilities(serverUrl: string, signal?: AbortSignal): Promise<ServerCapabilities> {
  throwIfAborted(signal);
  // 与 fetchCurrentUser / fetchServerInfo 共享同一次在途请求；
  // 解析失败时按原行为退化为空信息（网络错误仍向上抛出）。
  const payload = await fetchUserInfoPayload(serverUrl, signal);
  throwIfAborted(signal);
  const info = payload.parseError ? ({} as UserInfoResponse) : payload.data;

  const capabilities = await discoverGeneralServerCapabilities({
    version: info.sys?.version || '',
    findSampleBookId: () => findSampleBookId(serverUrl, signal),
    probeJsonEndpoint: (path) => probeJsonEndpoint(serverUrl, path, signal),
    // The current Talebook contract has no HEAD/limit endpoint for annotations.
    // Do not download and discard a sample book's complete annotation list here.
    // The detail panel's first useful data load doubles as its one-shot probe.
  });
  throwIfAborted(signal);
  return capabilities;
}

// Keep compatible HTTP auth challenges separate from successful JSON states.
// Talebook returns not_invited and not_installed with HTTP 200 (base.py:206-220 at
// d5d21dda160d65d29cc0c9ab8a13ae6b4deb69d2). Both identify the server; an
// incomplete installation must still fail checkSavedServer's welcome check.
// The 401/403 pairs below are compatibility for the user/info probe only.
const SERVER_CONNECTION_AUTH_HTTP_STATUS = new Map([
  ['user.need_login', 401],
  ['not_invited', 403],
]);
const SERVER_CONNECTION_STATES = new Set(['ok', 'not_installed', ...SERVER_CONNECTION_AUTH_HTTP_STATUS.keys()]);

export async function validateServerConnection(serverUrl: string, signal?: AbortSignal): Promise<{ err: string; msg?: string }> {
  // Each explicit connection attempt probes once; retry is a user action.
  let response: Response;

  try {
    response = await request(`${serverUrl}/api/user/info`, {
      credentials: 'include', signal,
    });
  } catch (e) {
    throwIfAborted(signal);
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error('[validateServerConnection] network error:', errorMsg);
    debugLog('error', 'validate', '连接失败', errorMsg);
    return {
      err: 'network.error',
      msg: `无法连接到服务器，请检查地址和网络 (${errorMsg})`,
    };
  }

  console.log('[validateServerConnection] status=%s content-type=%s', response.status, response.headers.get('content-type'));

  let data: UserInfoResponse;
  try {
    data = await readJsonResponse<UserInfoResponse>(response, '服务器返回内容无效，不像是可用的 Talebook 服务。');
  } catch (e) {
    throwIfAborted(signal);
    logHttpErrorMetadata('validateServerConnection invalid response', response.status, e);
    return {
      err: e instanceof MokeApiError ? e.code : 'server.invalid_response',
      msg: getErrorMessage(e, '服务器返回内容无效，不像是可用的 Talebook 服务。'),
    };
  }

  if (!response.ok && SERVER_CONNECTION_AUTH_HTTP_STATUS.get(data.err) !== response.status) {
    logHttpErrorMetadata('validateServerConnection', response.status, data);
    return {
      // A known JSON state cannot turn a transport failure into success.
      err: data.err && data.err !== 'ok' ? data.err : `http.${response.status}`,
      msg: data.msg || '服务器响应异常，请确认服务已正常启动',
    };
  }

  if (!SERVER_CONNECTION_STATES.has(data.err)) {
    console.error('[validateServerConnection] unexpected err=%s', getSafeErrorCode(data));
    return {
      err: data.err || 'server.invalid',
      msg: data.msg || '服务器校验失败，请确认这是 Talebook 服务',
    };
  }

  console.log('[validateServerConnection] OK err=%s', getSafeErrorCode(data));
  return { err: 'ok' };
}

export async function checkWelcomeRequirement(serverUrl: string, signal?: AbortSignal): Promise<{ err: string; msg?: string; needsAccessCode: boolean }> {
  let response: Response;

  try {
    response = await request(`${serverUrl}/api/welcome`, {
      credentials: 'include',
      signal,
    });
  } catch (e) {
    throwIfAborted(signal);
    console.error('[checkWelcomeRequirement] network error:', e);
    return {
      err: 'network.error',
      msg: '无法检查访问码状态，请检查服务器连接',
      needsAccessCode: false,
    };
  }

  let data: { err?: string; msg?: string; welcome?: string };

  try {
    data = await readJsonResponse(response, '服务器返回内容无效，无法确认访问码状态。');
  } catch (e) {
    throwIfAborted(signal);
    logHttpErrorMetadata('checkWelcomeRequirement invalid response', response.status, e);
    return {
      err: e instanceof MokeApiError ? e.code : 'server.invalid_response',
      msg: getErrorMessage(e, '服务器返回内容无效，无法确认访问码状态。'),
      needsAccessCode: false,
    };
  }

  if (!response.ok) {
    logHttpErrorMetadata('checkWelcomeRequirement', response.status, data);
    return {
      // Talebook's Welcome bypasses the invite gate and returns HTTP 200 ok/free
      // (user.py:467-477 at d5d21dda160d65d29cc0c9ab8a13ae6b4deb69d2).
      // Even not_invited cannot make a failed welcome request require a code.
      err: typeof data.err === 'string' && data.err !== 'ok' && data.err !== 'free' ? data.err : `http.${response.status}`,
      msg: data.msg || '访问码状态检查失败',
      needsAccessCode: false,
    };
  }

  console.log('[checkWelcomeRequirement] err=%s', getSafeErrorCode(data));

  return readConnectionWelcome(data);
}

export async function submitWelcomeCode(code: string, captchaData?: any, server?: string, signal?: AbortSignal): Promise<{ err: string; msg?: string }> {
  const serverUrl = server ?? (await import('@/lib/store/server')).useServerStore.getState().serverUrl;
  debugLog('info', 'submitCode', `读取到 serverUrl="${serverUrl}"`, { isEmpty: !serverUrl });
  const body = new URLSearchParams();
  body.append('invite_code', code);

  if (captchaData) {
    if (typeof captchaData === 'string') {
      body.append('captcha_code', captchaData);
    } else {
      Object.keys(captchaData).forEach(key => {
        body.append(key, captchaData[key]);
      });
    }
  }

  const response = await request(`${serverUrl}/api/welcome`, {
    method: 'POST',
    body,
    credentials: 'include', signal,
  });

  const result = await readJsonResponse<{ err: string; msg?: string }>(response);
  console.log('[submitWelcomeCode] err=%s', getSafeErrorCode(result));
  return result;
}

export async function downloadBookBlob(
  bookId: string | number,
  format = 'epub',
  options?: { onProgress?: (progress: number) => void; signal?: AbortSignal; serverUrl?: string },
): Promise<Blob> {
  const serverUrl = options?.serverUrl ?? (await import('@/lib/store/server')).useServerStore.getState().serverUrl;
  const url = `${serverUrl}/api/book/${bookId}.${format}`;

  try {
    const response = await request(url, {
      ...(isTauriApp
        ? ({
            method: 'GET',
            headers: buildTauriBinaryHeaders(),
            connectTimeout: 30_000,
            signal: options?.signal,
          } as any)
        : { credentials: 'include', signal: options?.signal }),
    });

    if (!response.ok) {
      throw new Error(`http.${response.status}`);
    }

    const total = Number(response.headers.get('content-length') || 0);
    const reader = response.body?.getReader();

    if (!reader) {
      const blob = await response.blob();
      options?.onProgress?.(99);
      return validateDownloadedBook(blob, format);
    }

    const chunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      if (!value) continue;

      chunks.push(value);
      received += value.length;

      if (total > 0) {
        options?.onProgress?.(Math.min(99, Math.round((received / total) * 100)));
      }
    }

    options?.onProgress?.(99);

    return validateDownloadedBook(new Blob(chunks as BlobPart[], {
      type: response.headers.get('content-type') || 'application/octet-stream',
    }), format);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    throw new Error(reason || 'network.error');
  }
}

const BOOK_TAIL_WINDOW = 22 + 0xffff + 4096;

function keepTailBytes(tail: Uint8Array, chunk: Uint8Array, windowSize: number): Uint8Array {
  const combinedLength = tail.length + chunk.length;
  if (combinedLength <= windowSize) {
    const combined = new Uint8Array(combinedLength);
    combined.set(tail, 0);
    combined.set(chunk, tail.length);
    return combined;
  }

  const result = new Uint8Array(windowSize);
  if (chunk.length >= windowSize) {
    result.set(chunk.subarray(chunk.length - windowSize));
    return result;
  }
  const tailKeep = windowSize - chunk.length;
  result.set(tail.subarray(tail.length - tailKeep), 0);
  result.set(chunk, tailKeep);
  return result;
}

/** 流式下载：把响应体逐块交给 write()，仅保留文件尾部用于 EPUB 校验，
 *  避免把整本书累积在内存中（大书/低内存设备 OOM）。 */
export async function streamBookDownload(
  bookId: string | number,
  format = 'epub',
  options: {
    write: (chunk: Uint8Array) => Promise<void>;
    onProgress?: (progress: number) => void;
    onTransfer?: (receivedBytes: number, totalBytes: number | null) => void;
    signal?: AbortSignal;
    serverUrl?: string;
    resumeFrom?: number;
    onRangeReset?: () => Promise<void>;
    /** Tauri validates the completed on-disk tail, including bytes from an earlier range. */
    validateEpub?: boolean;
  },
): Promise<{ mimeType: string; size: number; sourceSignature?: string; resumed: boolean }> {
  const serverUrl = options.serverUrl ?? (await import('@/lib/store/server')).useServerStore.getState().serverUrl;
  const url = `${serverUrl}/api/book/${bookId}.${format}`;
  const requestedOffset = Math.max(0, options.resumeFrom || 0);
  const headers = new Headers();
  if (requestedOffset > 0) headers.set('Range', `bytes=${requestedOffset}-`);

  const fetchDownload = (requestHeaders: Headers) => request(
    url,
    {
      ...(isTauriApp
        ? ({
            method: 'GET',
            headers: buildTauriBinaryHeaders(requestHeaders),
            connectTimeout: 30_000,
            signal: options.signal,
          } as any)
        : { credentials: 'include', signal: options.signal, headers: requestHeaders }),
    },
    requestHeaders.has('Range') ? { expectedStatuses: [416] } : undefined,
  );
  let response = await fetchDownload(headers);
  let contentRange = parseContentRange(response.headers.get('content-range'));
  let rangeMode = classifyOfflineRangeResponse(requestedOffset, response.status, contentRange);
  if (!response.ok && rangeMode !== 'retry-full') throw new Error(`http.${response.status}`);
  if (rangeMode === 'retry-full') {
    if (response.status === 416) {
      await drainResponseBodyQuietly(response);
    } else {
      await cancelResponseBodyQuietly(response);
    }
    await options.onRangeReset?.();
    response = await fetchDownload(new Headers());
    if (!response.ok) throw new Error(`http.${response.status}`);
    contentRange = parseContentRange(response.headers.get('content-range'));
    rangeMode = classifyOfflineRangeResponse(0, response.status, contentRange);
  }
  if (rangeMode === 'invalid') throw new Error('book.download.range.invalid');
  const resumed = rangeMode === 'resume';
  let received = resumed ? requestedOffset : 0;
  if (rangeMode === 'restart') await options.onRangeReset?.();
  const responseLength = Number(response.headers.get('content-length') || 0);
  const total = contentRange?.total ?? (responseLength > 0 ? received + responseLength : null);
  const sourceSignature = response.headers.get('etag') || response.headers.get('last-modified') || undefined;
  const reader = response.body?.getReader();

  if (!reader) {
    let blob: Blob;
    try {
      blob = await response.blob();
    } catch (error) {
      logBinaryTransferFailure(url, response, error, 0);
      throw new Error('book.download.transfer_failed');
    }

    try {
      await options.write(new Uint8Array(await blob.arrayBuffer()));
    } catch (error) {
      logOfflineWriteFailure(error, blob.size);
      throw new Error('book.download.storage_failed');
    }
    received += blob.size;
    options.onTransfer?.(received, total);
    options.onProgress?.(99);
    if (total != null && received !== total) throw new Error('book.download.incomplete');
    if (options.validateEpub !== false && format.toLowerCase() === 'epub' && !(await hasEpubCentralDirectory(blob))) {
      throw new Error('book.epub.invalid');
    }
    return { mimeType: response.headers.get('content-type') || 'application/octet-stream', size: received, sourceSignature, resumed };
  }

  let tail: Uint8Array = new Uint8Array(0);
  while (true) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch (error) {
      if (isRequestCancelled(error)) throw error;
      logBinaryTransferFailure(url, response, error, received);
      throw new Error('book.download.transfer_failed');
    }

    const { done, value } = result;
    if (done) break;
    if (!value) continue;

    try {
      await options.write(value);
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // 原始写入错误更有诊断价值，取消失败不覆盖它。
      }
      logOfflineWriteFailure(error, received);
      throw new Error('book.download.storage_failed');
    }
    received += value.length;
    tail = keepTailBytes(tail, value, BOOK_TAIL_WINDOW);
    options.onTransfer?.(received, total);
    if (total && total > 0) options.onProgress?.(Math.min(99, Math.round((received / total) * 100)));
  }
  options.onProgress?.(99);
  if (total != null && received !== total) throw new Error('book.download.incomplete');
  if (options.validateEpub !== false && format.toLowerCase() === 'epub' && !(await hasEpubCentralDirectory(new Blob([tail])))) {
    throw new Error('book.epub.invalid');
  }
  return {
    mimeType: response.headers.get('content-type') || 'application/octet-stream',
    size: received,
    sourceSignature,
    resumed,
  };
}
