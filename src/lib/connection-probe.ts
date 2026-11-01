import { readJsonResponse } from './api-core.ts';

export type ProbeRequest = (url: string, init: RequestInit) => Promise<Response>;
/** Candidate requests never mutate live state or accept an unverified redirect. */
export async function probeSavedServer(request: ProbeRequest, baseUrl: string, signal: AbortSignal) {
  const init = { credentials: 'include', redirect: 'error', signal, maxRedirections: 0 } as RequestInit;
  const info = await request(`${baseUrl}/api/user/info`, init);
  const data = await readJsonResponse<{ err?: string }>(info);
  if (!info.ok || !['ok', 'not_invited', 'user.need_login', 'not_installed'].includes(data.err ?? '')) {
    throw new Error('server.invalid_response');
  }
  const welcome = await request(`${baseUrl}/api/welcome`, init);
  const access = await readJsonResponse<{ err?: string }>(welcome);
  if (!welcome.ok || !['ok', 'not_invited', 'free'].includes(access.err ?? '')) {
    throw new Error('server.access_check_failed');
  }
  return { needsAccessCode: access.err !== 'free' };
}
