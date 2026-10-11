import { logErrorMetadata } from './api-log.ts';

export interface JoinedServer {
  protocol: 'http' | 'https';
  host: string;
  port: string;
  origin: string;
  needsAccessCode: boolean;
}

export function parseJoinServerAddress(value: string): Omit<JoinedServer, 'needsAccessCode'> {
  const input = value.trim();
  if (!input) throw new Error('请输入服务器地址');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`);
  } catch {
    throw new Error('请输入有效的 Talebook 服务器地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('服务器地址须使用 HTTP 或 HTTPS');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('请填写服务器根地址，不要包含账号、路径、查询参数或片段');
  }
  return {
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    host: url.hostname,
    port: url.port,
    origin: url.origin,
  };
}

/** Talebook uses `ok` for a code prompt and `free` for unrestricted/already invited access. */
export function readJoinWelcomeResult(value: unknown) {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const msg = typeof data.msg === 'string' ? data.msg : undefined;
  const welcome = typeof data.welcome === 'string' ? data.welcome : undefined;
  if (data.err === 'ok') return { err: 'ok', msg: welcome || msg, needsAccessCode: true };
  if (data.err === 'free') return { err: 'ok', msg, needsAccessCode: false };
  return { err: typeof data.err === 'string' && data.err ? data.err : 'server.invalid_response', msg: msg || '无法确认访问码状态，请重试', needsAccessCode: false };
}

type JoinChecks = {
  validate: (url: string, signal?: AbortSignal) => Promise<{ err: string; msg?: string }>;
  welcome: (url: string, signal?: AbortSignal) => Promise<{ err: string; msg?: string; needsAccessCode: boolean }>;
};

/** Keep configuration untouched until both checks finish; ignore late responses after cancellation. */
export async function prepareServerJoin(value: string, checks: JoinChecks, signal: AbortSignal): Promise<JoinedServer> {
  const server = parseJoinServerAddress(value);
  signal.throwIfAborted();
  const validation = await checks.validate(server.origin, signal);
  signal.throwIfAborted();
  if (validation.err !== 'ok') {
    logErrorMetadata('JoinServer validateServerConnection failed', validation);
    throw new Error(validation.msg || '无法加入，请检查服务器地址和网络后重试');
  }
  const welcome = await checks.welcome(server.origin, signal);
  signal.throwIfAborted();
  if (welcome.err !== 'ok') {
    logErrorMetadata('JoinServer checkWelcomeRequirement failed', welcome);
    throw new Error(welcome.msg || '访问码状态检查失败，请重试');
  }
  return { ...server, needsAccessCode: welcome.needsAccessCode };
}
