import { logErrorMetadata } from './api-log.ts';

export function readConnectionWelcome(value: unknown): { err: string; msg?: string; needsAccessCode: boolean } {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const msg = typeof data.msg === 'string' ? data.msg : undefined;
  if (data.err === 'ok') return { err: 'ok', msg, needsAccessCode: true };
  if (data.err === 'free') return { err: 'ok', msg, needsAccessCode: false };
  return { err: typeof data.err === 'string' ? data.err : 'server.invalid_response',
    msg: msg || '无法确认访问码状态，请重试', needsAccessCode: false };
}

/** Checks cannot commit configuration. Abort and request identity guard every await. */
export async function checkSavedServer(
  url: string,
  checks: {
    validate: (url: string, signal: AbortSignal) => Promise<{ err: string; msg?: string }>;
    welcome: (url: string, signal: AbortSignal) => Promise<{ err: string; msg?: string; needsAccessCode: boolean }>;
  },
  signal: AbortSignal,
): Promise<{ needsAccessCode: boolean }> {
  signal.throwIfAborted();
  const validation = await abortable(checks.validate(url, signal), signal);
  signal.throwIfAborted();
  if (validation.err !== 'ok') {
    logErrorMetadata('ServerConnection validation failed', validation);
    throw new Error(validation.msg || '连接失败，请检查服务器地址和网络');
  }
  const welcome = await abortable(checks.welcome(url, signal), signal);
  signal.throwIfAborted();
  if (welcome.err !== 'ok') {
    logErrorMetadata('ServerConnection welcome failed', welcome);
    throw new Error(welcome.msg || '访问码状态检查失败');
  }
  return welcome;
}

/** Some native transports reject cancellation only after their response arrives. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('连接已取消', 'AbortError'));
    if (signal.aborted) { void operation.catch(() => undefined); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
