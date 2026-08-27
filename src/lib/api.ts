import type { ServerCapabilities } from '@/lib/store/server';
import { debugLog } from '@/lib/debug-log';
import { getSafeErrorCode, logHttpErrorMetadata } from '@/lib/api-log';
import {
  attachSafeJsonReader,
  buildTauriBinaryHeaders,
  buildTauriRequestInit,
  cancelResponseBodyQuietly,
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
  readCurrentUserResponse,
  type CurrentUserResult,
  type UserInfoResponse,
} from '@/lib/server-session';
import { discoverGeneralServerCapabilities } from '@/lib/server-capabilities';
import {
  fetchCoverBytes,
  MAX_COVER_DIMENSION,
  MAX_COVER_PIXELS,
} from '@/lib/cover-image-core';
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

export async function request(url: string | URL, options?: RequestInit): Promise<Response> {
  const urlStr = url.toString();
  const method = (options?.method || 'GET').toUpperCase();

  // 关键检测：Tauri 桌面端必须使用绝对 URL（http(s)://...），
  // 否则没有"当前域名"可拼接，会直接网络异常。
  if (!isAbsoluteHttpUrl(urlStr)) {
    debugLog(
      'error',
      'request',
      `✗ ${method} ${urlStr} —— 缺少服务器地址前缀！serverUrl 为空`,
      '说明连接信息未正确保存。请回到欢迎页重新输入服务器地址再试。',
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
    if (isRequestCancelled(e)) {
      debugLog('info', 'request', `⊘ ${method} ${urlStr} 已取消 (${Date.now() - startedAt}ms)`);
      throw e;
    }
    debugLog('error', 'request', `✗ ${method} ${urlStr} 网络异常 (${Date.now() - startedAt}ms)`, errMsg);
    // 不在这里弹 toast：页面层各自 catch 后按业务文案提示，
    // 避免网络错误时页面 toast 与这里重复弹出两条。此处只记录日志。
    throw e;
  }

  const elapsed = Date.now() - startedAt;
  const level = response.ok ? 'success' : 'error';
  debugLog(level, 'request', `← ${response.status} ${method} ${urlStr} (${elapsed}ms)`, {
    status: response.status,
    contentType: response.headers.get('content-type'),
  });

  // 历史调用点仍有直接使用 response.json() 的情况。统一改为单次文本读取，
  // 使所有 JSON 入口都不再暴露底层流关闭/解析异常，且可保留纯文本网关原因。
  return attachSafeJsonReader(response);
}

export interface FetchImageObjectUrlOptions {
  /** Configured Talebook origin. Relative covers resolve against this URL. */
  serverUrl: string;
  /** Explicit policy switch for credential-free, publicly routed CDN/source covers. */
  allowPublicCrossOrigin?: boolean;
}

const COVER_TIMEOUT_MS = 12_000;
const COVER_FAILURE_COOLDOWN_MS = 30_000;
const coverLoads = new Map<string, Promise<Blob>>();
const coverFailureUntil = new Map<string, number>();

function binaryResponse(bytes: Uint8Array): Response {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Response(copy, { status: 200 });
}

function ipcBytes(value: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('image.body.invalid');
}

function coverLogUrl(value: string, serverUrl: string): string {
  try {
    const url = new URL(value, serverUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '[invalid cover URL]';
  }
}

async function verifyBrowserDecode(blob: Blob): Promise<void> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob).catch(() => {
      throw new Error('image.decode.invalid');
    });
    try {
      if (
        bitmap.width > MAX_COVER_DIMENSION ||
        bitmap.height > MAX_COVER_DIMENSION ||
        bitmap.width * bitmap.height > MAX_COVER_PIXELS
      ) {
        throw new Error('image.dimensions.exceeded');
      }
    } finally {
      bitmap.close();
    }
    return;
  }

  // Older WebViews do not expose createImageBitmap. Decode once through an
  // off-DOM image and revoke its short-lived URL on every completion path.
  if (typeof Image !== 'function') return;
  const decodeUrl = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        if (
          image.naturalWidth > MAX_COVER_DIMENSION ||
          image.naturalHeight > MAX_COVER_DIMENSION ||
          image.naturalWidth * image.naturalHeight > MAX_COVER_PIXELS
        ) {
          reject(new Error('image.dimensions.exceeded'));
          return;
        }
        resolve();
      };
      image.onerror = () => reject(new Error('image.decode.invalid'));
      image.src = decodeUrl;
    });
  } finally {
    URL.revokeObjectURL(decodeUrl);
  }
}

async function fetchImageBlob(
  imageUrl: string,
  { serverUrl, allowPublicCrossOrigin = false }: FetchImageObjectUrlOptions,
): Promise<Blob> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COVER_TIMEOUT_MS);
  const startedAt = Date.now();
  debugLog('info', 'image', `→ GET ${coverLogUrl(imageUrl, serverUrl)}`);

  try {
    const result = await fetchCoverBytes(
      { imageUrl, libraryUrl: serverUrl, allowPublicCrossOrigin },
      {
        fetchLibrary: (url) => request(url, {
          credentials: 'include',
          redirect: 'manual',
          signal: controller.signal,
          // Consumed by plugin-http; native fetch safely ignores the extra key.
          maxRedirections: 0,
        } as RequestInit & { maxRedirections: number }),
        fetchPublic: async (url) => {
          if (isTauriApp) {
            const { invoke } = await import('@tauri-apps/api/core');
            const value = await invoke<ArrayBuffer | Uint8Array | number[]>('moke_fetch_public_cover', {
              imageUrl: url,
            });
            return binaryResponse(ipcBytes(value));
          }
          return fetch(url, {
            credentials: 'omit',
            redirect: 'manual',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
            headers: { Accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.8' },
          });
        },
      },
    );
    const blob = new Blob([result.bytes], { type: result.contentType });
    await verifyBrowserDecode(blob);
    debugLog('success', 'image', `← 图片加载成功 ${coverLogUrl(result.finalUrl, serverUrl)} (${Date.now() - startedAt}ms)`, {
      type: blob.type,
      size: blob.size,
      width: result.info.width,
      height: result.info.height,
    });
    return blob;
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    debugLog('error', 'image', `✗ 图片加载异常 ${coverLogUrl(imageUrl, serverUrl)}`, detail);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Load every book cover through one bounded policy gate and return an object
 * URL. Same-library requests may use the session cookie; explicitly allowed
 * cross-origin requests are credential-free and, on Tauri, DNS-pinned by the
 * native public-cover command. Callers own and must revoke the returned URL.
 * Concurrent mounts share one download and failures cool down briefly to
 * avoid virtualized-list/remount retry storms.
 */
export async function fetchImageObjectUrl(
  imageUrl: string,
  options: FetchImageObjectUrlOptions,
): Promise<string> {
  const key = `${options.serverUrl}\n${options.allowPublicCrossOrigin === true ? 'public' : 'same'}\n${imageUrl}`;
  const blockedUntil = coverFailureUntil.get(key) ?? 0;
  if (blockedUntil > Date.now()) throw new Error('image.retry_later');
  if (blockedUntil) coverFailureUntil.delete(key);

  let load = coverLoads.get(key);
  if (!load) {
    load = fetchImageBlob(imageUrl, options);
    coverLoads.set(key, load);
    void load.then(
      () => coverFailureUntil.delete(key),
      () => {
        coverFailureUntil.set(key, Date.now() + COVER_FAILURE_COOLDOWN_MS);
        if (coverFailureUntil.size > 256) {
          coverFailureUntil.delete(coverFailureUntil.keys().next().value ?? key);
        }
      },
    ).finally(() => coverLoads.delete(key));
  }
  const blob = await load;
  return URL.createObjectURL(blob);
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

export async function fetchCurrentUser(): Promise<CurrentUserResult> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const response = await request(`${serverUrl}/api/user/info`, {
    credentials: 'include',
  });
  return readCurrentUserResponse(response);
}

export async function fetchServerInfo(): Promise<{ err: string; msg?: string; title: string; version: string }> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  if (!serverUrl) {
    // 未连接服务器时直接返回空信息，避免发起无前缀 URL 的请求
    return { err: 'no_server', title: '', version: '' };
  }
  const response = await request(`${serverUrl}/api/user/info`, {
    credentials: 'include',
  });
  const data = await readJsonResponse<UserInfoResponse>(response);

  return {
    err: data.err,
    msg: data.msg,
    title: data.sys?.title || '',
    version: data.sys?.version || '',
  };
}

async function probeJsonEndpoint(serverUrl: string, path: string): Promise<boolean> {
  try {
    const response = await request(`${serverUrl}${path}`, {
      credentials: 'include',
    });

    if (response.status === 404 || response.status === 405) return false;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) return response.ok;

    const data = await readJsonResponse<any>(response).catch(() => null);
    const err = typeof data?.err === 'string' ? data.err : '';

    if (!err) return response.ok;
    if (err === 'page.not_found' || err === 'handler.not_found' || err === 'api.not_found') return false;
    return true;
  } catch (error) {
    debugLog('warn', 'capabilities', `能力探测失败: ${path}`, getErrorMessage(error));
    return false;
  }
}

async function findSampleBookId(serverUrl: string): Promise<string | null> {
  const candidates = ['/api/shelf', '/api/library?num=1', '/api/library?page=1&num=1'];

  for (const path of candidates) {
    try {
      const response = await request(`${serverUrl}${path}`, { credentials: 'include' });
      if (!response.ok) continue;

      const data = await readJsonResponse<any>(response).catch(() => null);
      const books = data?.books || data?.items || data?.data?.books || data?.data?.items;
      if (Array.isArray(books) && books.length > 0 && books[0]?.id != null) {
        return String(books[0].id);
      }
    } catch (error) {
      debugLog('warn', 'capabilities', `样本书籍探测失败: ${path}`, getErrorMessage(error));
    }
  }

  return null;
}

export async function discoverServerCapabilities(serverUrl: string): Promise<ServerCapabilities> {
  const infoResponse = await request(`${serverUrl}/api/user/info`, {
    credentials: 'include',
  });
  const info = await readJsonResponse<UserInfoResponse>(infoResponse).catch(() => ({} as UserInfoResponse));

  return discoverGeneralServerCapabilities({
    version: info.sys?.version || '',
    findSampleBookId: () => findSampleBookId(serverUrl),
    probeJsonEndpoint: (path) => probeJsonEndpoint(serverUrl, path),
    // The current Talebook contract has no HEAD/limit endpoint for annotations.
    // Do not download and discard a sample book's complete annotation list here.
    // The detail panel's first useful data load doubles as its one-shot probe.
  });
}

export async function validateServerConnection(serverUrl: string): Promise<{ err: string; msg?: string }> {
  const maxRetries = 1;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.log('[validateServerConnection] retry attempt', attempt);
      await new Promise(r => setTimeout(r, 1500));
    }

    let response: Response;

    try {
      response = await request(`${serverUrl}/api/user/info`, {
        credentials: 'include',
      });
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error('[validateServerConnection] network error:', errorMsg);
      debugLog('error', 'validate', `连接失败 (尝试 ${attempt + 1}/${maxRetries + 1})`, errorMsg);
      if (attempt < maxRetries) continue;
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
      logHttpErrorMetadata('validateServerConnection invalid response', response.status, e);
      if (attempt < maxRetries) continue;
      return {
        err: e instanceof MokeApiError ? e.code : 'server.invalid_response',
        msg: getErrorMessage(e, '服务器返回内容无效，不像是可用的 Talebook 服务。'),
      };
    }

    if (!response.ok) {
      logHttpErrorMetadata('validateServerConnection', response.status, data);
      if (attempt < maxRetries) continue;
      return {
        err: data.err || `http.${response.status}`,
        msg: data.msg || '服务器响应异常，请确认服务已正常启动',
      };
    }

    if (data.err !== 'ok' && data.err !== 'not_invited' && data.err !== 'user.need_login' && data.err !== 'not_installed') {
      console.error('[validateServerConnection] unexpected err=%s', getSafeErrorCode(data));
      if (attempt < maxRetries) continue;
      return {
        err: data.err || 'server.invalid',
        msg: data.msg || '服务器校验失败，请确认这是 Talebook 服务',
      };
    }

    console.log('[validateServerConnection] OK err=%s', getSafeErrorCode(data));
    return { err: 'ok' };
  }

  return { err: 'server.invalid_response', msg: '服务器校验失败' };
}

export async function checkWelcomeRequirement(serverUrl: string): Promise<{ err: string; msg?: string; needsAccessCode: boolean }> {
  let response: Response;

  try {
    response = await request(`${serverUrl}/api/welcome`, {
      credentials: 'include',
    });
  } catch (e) {
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
      err: data.err || `http.${response.status}`,
      msg: data.msg || '访问码状态检查失败',
      needsAccessCode: false,
    };
  }

  console.log('[checkWelcomeRequirement] err=%s', getSafeErrorCode(data));

  if (data.err === 'ok') {
    return {
      err: 'ok',
      msg: data.welcome || data.msg,
      needsAccessCode: true,
    };
  }

  return {
    err: 'ok',
    msg: data.msg,
    needsAccessCode: false,
  };
}

export async function submitWelcomeCode(code: string, captchaData?: any): Promise<{ err: string; msg?: string }> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
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
    credentials: 'include',
  });

  const result = await readJsonResponse<{ err: string; msg?: string }>(response);
  console.log('[submitWelcomeCode] err=%s', getSafeErrorCode(result));
  return result;
}

export async function downloadBookBlob(
  bookId: string | number,
  format = 'epub',
  options?: { onProgress?: (progress: number) => void; signal?: AbortSignal },
): Promise<Blob> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
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
    resumeFrom?: number;
    onRangeReset?: () => Promise<void>;
    /** Tauri validates the completed on-disk tail, including bytes from an earlier range. */
    validateEpub?: boolean;
  },
): Promise<{ mimeType: string; size: number; sourceSignature?: string; resumed: boolean }> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const url = `${serverUrl}/api/book/${bookId}.${format}`;
  const requestedOffset = Math.max(0, options.resumeFrom || 0);
  const headers = new Headers();
  if (requestedOffset > 0) headers.set('Range', `bytes=${requestedOffset}-`);

  const fetchDownload = (requestHeaders: Headers) => request(url, {
    ...(isTauriApp
      ? ({
          method: 'GET',
          headers: buildTauriBinaryHeaders(requestHeaders),
          connectTimeout: 30_000,
          signal: options.signal,
        } as any)
      : { credentials: 'include', signal: options.signal, headers: requestHeaders }),
  });
  let response = await fetchDownload(headers);
  if (!response.ok) throw new Error(`http.${response.status}`);

  let contentRange = parseContentRange(response.headers.get('content-range'));
  let rangeMode = classifyOfflineRangeResponse(requestedOffset, response.status, contentRange);
  if (rangeMode === 'retry-full') {
    await cancelResponseBodyQuietly(response);
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
