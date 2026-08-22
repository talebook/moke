import type { ServerCapabilities } from '@/lib/store/server';
import { debugLog } from '@/lib/debug-log';
import { getSafeErrorCode, logHttpErrorMetadata } from '@/lib/api-log';
import {
  attachSafeJsonReader,
  buildTauriBinaryHeaders,
  buildTauriRequestInit,
  getErrorMessage,
  isAbsoluteHttpUrl,
  MokeApiError,
  readApiJson,
  readJsonResponse,
  resolveAppPlatform,
} from '@/lib/api-core';
import { hasEpubCentralDirectory } from '@/lib/offline-book-core';
import {
  readCurrentUserResponse,
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

/**
 * 通过带认证的 request 获取图片资源，返回可直接用于 <img src> 的 object URL。
 *
 * 为什么需要它：在 Tauri 桌面端，前端运行在自定义协议（tauri://localhost），
 * 与 http(s):// 服务器跨源。<img src> 由 WebView 直接发起，绕过 tauriFetch 插件，
 * 也拿不到登录后由 Rust 侧 cookie jar 维护的 session，因此会 401。
 * 这里改为用 request()（Tauri 下走 tauriFetch、自动带认证）拉取字节再转 blob。
 *
 * 调用方负责在不再使用时 URL.revokeObjectURL 释放。
 */
export async function fetchImageObjectUrl(imageUrl: string): Promise<string> {
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error('image.url.invalid');
  }
  const startedAt = Date.now();
  debugLog('info', 'image', `→ GET ${imageUrl}`);
  try {
    const response = await request(imageUrl, { credentials: 'include' });
    if (!response.ok) {
      debugLog(
        'error',
        'image',
        `✗ ${response.status} 封面/图片加载失败 ${imageUrl} (${Date.now() - startedAt}ms)`,
        response.status === 401 ? '未授权：登录会话可能未携带或已失效' : `HTTP ${response.status}`,
      );
      throw new Error(`image.http.${response.status}`);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    debugLog(
      'success',
      'image',
      `← 图片加载成功 ${imageUrl} (${Date.now() - startedAt}ms)`,
      { type: blob.type, size: blob.size },
    );
    return objectUrl;
  } catch (e) {
    const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    debugLog('error', 'image', `✗ 图片加载异常 ${imageUrl}`, errMsg);
    throw e;
  }
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
    signal?: AbortSignal;
  },
): Promise<{ mimeType: string; size: number }> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const url = `${serverUrl}/api/book/${bookId}.${format}`;

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
    let blob: Blob;
    try {
      blob = await response.blob();
    } catch (error) {
      logBinaryTransferFailure(url, response, error, 0);
      throw new Error('book.download.transfer_failed');
    }

    options.onProgress?.(99);
    try {
      await options.write(new Uint8Array(await blob.arrayBuffer()));
    } catch (error) {
      logOfflineWriteFailure(error, blob.size);
      throw new Error('book.download.storage_failed');
    }
    if (format.toLowerCase() === 'epub' && !(await hasEpubCentralDirectory(blob))) {
      throw new Error('book.epub.invalid');
    }
    return {
      mimeType: response.headers.get('content-type') || 'application/octet-stream',
      size: blob.size,
    };
  }

  let tail: Uint8Array = new Uint8Array(0);
  let received = 0;

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

    if (total > 0) {
      options.onProgress?.(Math.min(99, Math.round((received / total) * 100)));
    }
  }

  options.onProgress?.(99);

  if (format.toLowerCase() === 'epub' && !(await hasEpubCentralDirectory(new Blob([tail])))) {
    throw new Error('book.epub.invalid');
  }

  return {
    mimeType: response.headers.get('content-type') || 'application/octet-stream',
    size: received,
  };
}
