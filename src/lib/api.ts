import type { ReaderInfo } from '@/lib/store/server';

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
      console.log('[request] not_invited detected, redirecting to /access');
      if (typeof window !== 'undefined') {
        window.location.href = '/access';
      }
    }
  } catch {
    // ignore parse errors
  }
}

export async function request(url: string | URL, options?: RequestInit): Promise<Response> {
  let response: Response;
  if (isTauriApp) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    response = await tauriFetch(url.toString(), options as any);
  } else {
    response = await fetch(url, options);
  }
  interceptNotInvited(response);
  return response;
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
      if (attempt < maxRetries) continue;
      return {
        err: 'network.error',
        msg: `无法连接到服务器，请检查地址和网络 (${errorMsg})`,
      };
    }

    console.log('[validateServerConnection] status=%s content-type=%s', response.status, response.headers.get('content-type'));

    const rawText = await response.text();
    console.log('[validateServerConnection] raw (first 500):', rawText.substring(0, 500));

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

    return new Blob(chunks, {
      type: response.headers.get('content-type') || 'application/octet-stream',
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    throw new Error(reason || 'network.error');
  }
}
