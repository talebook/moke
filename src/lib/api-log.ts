type ErrorLogger = (message?: unknown, ...optionalParams: unknown[]) => void;

const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * 只从响应中提取格式受限的机器错误码，避免把任意服务端正文写入日志。
 */
export function getSafeErrorCode(data: unknown): string {
  if (!data || typeof data !== 'object') return 'unknown';

  const value = 'err' in data ? data.err : 'code' in data ? data.code : undefined;
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value) ? value : 'unknown';
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
