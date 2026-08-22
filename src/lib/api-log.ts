type ErrorLogger = (message?: unknown, ...optionalParams: unknown[]) => void;

const SAFE_ERROR_CODES = new Set([
  'ok',
  'free',
  'not_invited',
  'not_installed',
  'captcha.expired',
  'captcha.invalid',
  'captcha.required',
  'network.error',
  'params.invalid',
  'permission.denied',
  'permission.not_permit',
  'server.invalid',
  'server.invalid_response',
  'server.response_read_failed',
  'user.need_login',
  'user.private.not_valid',
]);
const HTTP_ERROR_CODE_PATTERN = /^http\.[1-5][0-9]{2}$/;

function isSafeErrorCode(value: unknown): value is string {
  return typeof value === 'string'
    && (SAFE_ERROR_CODES.has(value) || HTTP_ERROR_CODE_PATTERN.test(value));
}

/**
 * 只放行客户端明确识别的机器错误码。不能仅按字符形状过滤：token 同样可能只含
 * 字母、数字、点、下划线和连字符。未识别的服务器值统一记为 unknown。
 */
export function getSafeErrorCode(data: unknown): string {
  if (!data || typeof data !== 'object') return 'unknown';

  const record = data as Record<string, unknown>;
  for (const key of ['err', 'code']) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
    const value = record[key];
    if (isSafeErrorCode(value)) return value;
  }
  return 'unknown';
}

/** 记录失败结果时只输出错误码，不展开可能含服务器正文的结果对象。 */
export function logErrorMetadata(
  context: string,
  data: unknown,
  logger: ErrorLogger = console.error,
): void {
  logger(`[${context}] err=%s`, getSafeErrorCode(data));
}

/**
 * HTTP 失败日志在开发和生产环境都只记录必要元数据，不输出或展开响应正文。
 */
export function logHttpErrorMetadata(
  context: string,
  status: number,
  data: unknown,
  logger: ErrorLogger = console.error,
): void {
  logger(`[${context}] HTTP status=%d err=%s`, status, getSafeErrorCode(data));
}
