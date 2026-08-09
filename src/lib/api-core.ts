export type AppPlatform = 'tauri' | 'web';

type ApiEnvelope = {
  err?: string;
  msg?: string;
};

export type TauriRequestInit = RequestInit & {
  maxRedirections: number;
  connectTimeout?: number;
  danger: {
    acceptInvalidCerts: boolean;
    acceptInvalidHostnames: boolean;
  };
};

export class MokeApiError extends Error {
  code: string;
  status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'MokeApiError';
    this.code = code;
    this.status = status;
  }
}

export function resolveAppPlatform(value: string | undefined): AppPlatform {
  return value === 'tauri' ? 'tauri' : 'web';
}

export function isAbsoluteHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function buildTauriRequestInit(options?: RequestInit): TauriRequestInit {
  const init = { ...(options ?? {}) } as TauriRequestInit;
  init.maxRedirections = 5;
  init.danger = {
    acceptInvalidCerts: true,
    acceptInvalidHostnames: true,
  };
  // 默认 8 秒连接超时：服务器不可达时 reqwest 默认 TCP 超时长达 30 秒+，
  // 会让"连接书库"等操作长时间卡在等待。显式传入的 connectTimeout
  // （如下载）不会被覆盖。
  if (!init.connectTimeout) init.connectTimeout = 8_000;
  return init;
}

export function getErrorMessage(error: unknown, fallback = '操作失败，请稍后重试。') {
  if (error instanceof MokeApiError) return error.message || fallback;
  if (error instanceof Error) {
    if (error.message === 'server.url.missing') return '服务器地址丢失，请重新连接书库。';
    if (error.message === 'image.url.invalid') return '图片地址无效。';
    if (error.message.startsWith('image.http.')) return '封面加载失败。';
    if (error.message.startsWith('http.')) return `服务器返回 ${error.message.replace('http.', '')}。`;
    // 未知 Error：不把原始（可能是英文/内部）报错文本直接暴露给用户，
    // 统一走调用方传入的兜底文案。
    return fallback;
  }
  return fallback;
}

export async function readApiJson<T extends ApiEnvelope>(
  response: Response,
  fallbackMessage = '服务器返回内容无效。',
  okErrs: string[] = ['ok'],
): Promise<T> {
  let data: T;

  try {
    data = await response.json();
  } catch {
    throw new MokeApiError(fallbackMessage, 'server.invalid_response', response.status);
  }

  if (!response.ok) {
    throw new MokeApiError(
      String(data.msg || `服务器返回 ${response.status}。`),
      String(data.err || `http.${response.status}`),
      response.status,
    );
  }

  if (data.err && !okErrs.includes(data.err)) {
    throw new MokeApiError(String(data.msg || '接口请求失败。'), String(data.err), response.status);
  }

  return data;
}
