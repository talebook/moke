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

export async function request(url: string | URL, options?: RequestInit): Promise<Response> {
  if (isTauriApp) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return tauriFetch(url.toString(), options as any);
  }
  
  return fetch(url, options);
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
  let response: Response;

  try {
    response = await request(`${serverUrl}/api/user/info`, {
      credentials: 'include',
    });
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error('Network error detail:', errorMsg, e);
    return {
      err: 'network.error',
      msg: `无法连接到服务器，请检查地址和网络 (${errorMsg})`,
    };
  }

  let data: UserInfoResponse;

  try {
    data = await response.json();
  } catch {
    return {
      err: 'server.invalid_response',
      msg: '服务器返回内容无效，不像是可用的 Talebook 服务',
    };
  }

  if (!response.ok) {
    return {
      err: data.err || `http.${response.status}`,
      msg: data.msg || '服务器响应异常，请确认服务已正常启动',
    };
  }

  if (data.err !== 'ok' && data.err !== 'not_invited') {
    return {
      err: data.err || 'server.invalid',
      msg: data.msg || '服务器校验失败，请确认这是 Talebook 服务',
    };
  }

  return { err: 'ok' };
}

export async function checkWelcomeRequirement(serverUrl: string): Promise<{ err: string; msg?: string; needsAccessCode: boolean }> {
  let response: Response;

  try {
    response = await request(`${serverUrl}/api/welcome`, {
      credentials: 'include',
    });
  } catch {
    return {
      err: 'network.error',
      msg: '无法检查访问码状态，请检查服务器连接',
      needsAccessCode: false,
    };
  }

  let data: { err?: string; msg?: string; welcome?: string };

  try {
    data = await response.json();
  } catch {
    return {
      err: 'server.invalid_response',
      msg: '服务器返回内容无效，无法确认访问码状态',
      needsAccessCode: false,
    };
  }

  if (!response.ok) {
    return {
      err: data.err || `http.${response.status}`,
      msg: data.msg || '访问码状态检查失败',
      needsAccessCode: false,
    };
  }

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

export async function submitWelcomeCode(code: string): Promise<{ err: string; msg?: string }> {
  const { serverUrl } = (await import('@/lib/store/server')).useServerStore.getState();
  const body = new URLSearchParams();
  body.append('invite_code', code);

  const response = await request(`${serverUrl}/api/welcome`, {
    method: 'POST',
    body,
    credentials: 'include',
  });

  return response.json();
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

    const chunks: ArrayBuffer[] = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      if (!value) continue;

      chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
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
