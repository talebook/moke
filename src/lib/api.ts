import type { ReaderInfo } from '@/lib/store/server';
import { debugLog } from '@/lib/debug-log';

interface UserInfoResponse {
  err: string;
  msg?: string;
  sys?: {
    title?: string;
    version?: string;
  };
  user?: {
    id?: string | number;
    username?: string;
    nickname?: string;
    name?: string;
    email?: string;
    avatar?: string;
    is_login?: boolean;
    is_admin?: boolean;
    admin?: boolean;
    permission?: string;
  };
}

const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

async function interceptNotInvited(response: Response): Promise<void> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return;
  try {
    const data = await response.clone().json();
    if (data?.err === 'not_invited') {
      // 注意：这里绝不能用 window.location.href 做整页跳转！
      // 在 Tauri 静态导出环境下，整页导航会重载 WebView、清空所有内存状态
      // （zustand store 归零、localStorage origin 切换），导致 serverUrl 丢失。
      // not_invited 的跳转应由各页面用 router.push 处理，这里仅记录。
      debugLog('warn', 'request', 'not_invited：服务器要求访问码（由页面自行处理跳转）');
    }
  } catch {
    // ignore parse errors
  }
}

export async function request(url: string | URL, options?: RequestInit): Promise<Response> {
  const urlStr = url.toString();
  const method = (options?.method || 'GET').toUpperCase();

  // 关键检测：Tauri 桌面端必须使用绝对 URL（http(s)://...），
  // 否则没有"当前域名"可拼接，会直接网络异常。
  if (!/^https?:\/\//i.test(urlStr)) {
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
      response = await tauriFetch(urlStr, {
        ...(options as any),
        maxRedirections: 5,
        danger: {
          acceptInvalidCerts: true,
          acceptInvalidHostnames: true,
        },
      } as any);
    } else {
      response = await fetch(url, options);
    }
  } catch (e) {
    const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    debugLog('error', 'request', `✗ ${method} ${urlStr} 网络异常 (${Date.now() - startedAt}ms)`, errMsg);
    throw e;
  }

  const elapsed = Date.now() - startedAt;
  const level = response.ok ? 'success' : 'error';
  debugLog(level, 'request', `← ${response.status} ${method} ${urlStr} (${elapsed}ms)`, {
    status: response.status,
    contentType: response.headers.get('content-type'),
  });

  interceptNotInvited(response);
  return response;
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
  return response.json();
}

export async function fetchCurrentUser(): Promise<{ err: string; msg?: string; user: ReaderInfo | null; isLogin: boolean }> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const response = await request(`${serverUrl}/api/user/info`, {
    credentials: 'include',
  });
  const data: UserInfoResponse = await response.json();
  const info = data.user || {};
  const isLogin = Boolean(info.is_login);

  if (data.err !== 'ok' || !isLogin) {
    return {
      err: data.err,
      msg: data.msg,
      user: null,
      isLogin: false,
    };
  }

  return {
    err: data.err,
    msg: data.msg,
    isLogin: true,
    user: {
      id: info.id ?? info.username ?? '',
      username: info.username ?? '',
      name: info.nickname ?? info.name ?? info.username ?? '',
      email: info.email ?? '',
      avatar: info.avatar ?? '',
      admin: Boolean(info.is_admin ?? info.admin),
      permission: info.permission ?? '',
    },
  };
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
  const data: UserInfoResponse = await response.json();

  return {
    err: data.err,
    msg: data.msg,
    title: data.sys?.title || '',
    version: data.sys?.version || '',
  };
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

    const rawText = await response.text();
    console.log('[validateServerConnection] raw (first 500):', rawText.substring(0, 500));
    debugLog('info', 'validate', `服务器返回正文 (${rawText.length} 字节)`, rawText.substring(0, 800));

    let data: UserInfoResponse;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('[validateServerConnection] not JSON, attempt=%d', attempt, e);
      if (attempt < maxRetries) continue;
      return {
        err: 'server.invalid_response',
        msg: '服务器返回内容无效，不像是可用的 Talebook 服务',
      };
    }

    if (!response.ok) {
      console.error(`[validateServerConnection] HTTP ${response.status}:`, data);
      if (attempt < maxRetries) continue;
      return {
        err: data.err || `http.${response.status}`,
        msg: data.msg || '服务器响应异常，请确认服务已正常启动',
      };
    }

    if (data.err !== 'ok' && data.err !== 'not_invited' && data.err !== 'user.need_login' && data.err !== 'not_installed') {
      console.error('[validateServerConnection] unexpected err=%s', data.err);
      if (attempt < maxRetries) continue;
      return {
        err: data.err || 'server.invalid',
        msg: data.msg || '服务器校验失败，请确认这是 Talebook 服务',
      };
    }

    console.log('[validateServerConnection] OK err=%s', data.err);
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
    data = await response.json();
  } catch (e) {
    console.error('[checkWelcomeRequirement] JSON parse error:', e);
    return {
      err: 'server.invalid_response',
      msg: '服务器返回内容无效，无法确认访问码状态',
      needsAccessCode: false,
    };
  }

  if (!response.ok) {
    console.error(`[checkWelcomeRequirement] HTTP ${response.status}:`, data);
    return {
      err: data.err || `http.${response.status}`,
      msg: data.msg || '访问码状态检查失败',
      needsAccessCode: false,
    };
  }

  console.log('[checkWelcomeRequirement]', data.err, data);

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

  const result = await response.json();
  console.log('[submitWelcomeCode]', result);
  return result;
}

export async function downloadBookBlob(
  bookId: string | number,
  format = 'epub',
  options?: { onProgress?: (progress: number) => void },
): Promise<Blob> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const url = `${serverUrl}/api/book/${bookId}.${format}`;

  if (isTauriApp) {
    const response = await request(url, {
      method: 'GET',
      connectTimeout: 30_000,
    } as any);

    if (!response.ok) {
      throw new Error(`http.${response.status}`);
    }

    options?.onProgress?.(100);
    return response.blob();
  }

  try {
    const response = await request(url, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`http.${response.status}`);
    }

    const total = Number(response.headers.get('content-length') || 0);
    const reader = response.body?.getReader();

    if (!reader) {
      options?.onProgress?.(100);
      return response.blob();
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
        options?.onProgress?.(Math.min(100, Math.round((received / total) * 100)));
      }
    }

    if (total === 0) {
      options?.onProgress?.(100);
    }

    return new Blob(chunks as BlobPart[], {
      type: response.headers.get('content-type') || 'application/octet-stream',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    throw new Error(reason || 'network.error');
  }
}
