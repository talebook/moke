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

/**
 * Tauri plugin-http 会在请求带 Range 时自动补 `Accept-Encoding: identity`。
 * 二进制响应禁用透明压缩，可避免部分 NAS/反向代理返回 200 后在正文解压阶段
 * 中断；`bytes=0-` 仍请求完整文件，支持 Range 的服务器返回 206，不支持的会忽略。
 */
export function buildTauriBinaryHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  if (!result.has('range')) result.set('Range', 'bytes=0-');
  return result;
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

function responseTextDetail(rawText: string): string {
  const normalized = rawText
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 网关的纯文本原因（如 Cloudflare `error code: 1033`）对排障很重要；
  // HTML 错误页可能很长且夹带脚本，不直接展示给用户。
  if (!normalized || /<\/?(?:html|head|body|script|style)\b/i.test(normalized)) return '';
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function withoutTrailingPunctuation(message: string): string {
  return message.replace(/[.。！!]\s*$/, '');
}

/**
 * 读取一次响应体并解析 JSON。
 *
 * 不使用 `Response.json()` 是为了在解析失败时仍能保留网关返回的
 * 纯文本错误，同时避免对 Tauri plugin-http 的流式响应做克隆/并发读取。
 */
export async function readJsonResponse<T>(
  response: Response,
  fallbackMessage = '服务器返回内容无效。',
): Promise<T> {
  let rawText: string;

  try {
    rawText = await response.text();
  } catch {
    throw new MokeApiError('服务器响应读取失败，请稍后重试。', 'server.response_read_failed', response.status);
  }

  try {
    return JSON.parse(rawText) as T;
  } catch {
    const detail = responseTextDetail(rawText);
    const message = response.ok
      ? detail
        ? `${withoutTrailingPunctuation(fallbackMessage)}：${detail}`
        : fallbackMessage
      : detail
        ? `服务器返回 ${response.status}：${detail}`
        : `服务器返回 ${response.status}，且响应内容无效。`;

    throw new MokeApiError(
      message,
      response.ok ? 'server.invalid_response' : `http.${response.status}`,
      response.status,
    );
  }
}

/** 让尚未迁移到 `readApiJson` 的调用点也共享同一套安全解析与错误信息。 */
export function attachSafeJsonReader(response: Response): Response {
  Object.defineProperty(response, 'json', {
    configurable: true,
    value: <T>() => readJsonResponse<T>(response),
  });
  return response;
}

export async function readApiJson<T extends ApiEnvelope>(
  response: Response,
  fallbackMessage = '服务器返回内容无效。',
  okErrs: string[] = ['ok'],
): Promise<T> {
  const data = await readJsonResponse<T>(response, fallbackMessage);

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
