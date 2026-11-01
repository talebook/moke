import { drainResponseBodyQuietly } from './api-core.ts';

interface Source { serverUrl: string; sessionRevision: number }
/** Explicit sign-out may clear only its original local source, even if its
 * HTTP/body completion arrives after another saved library was activated. */
export async function signOutSource(source: Source, request: (url: string, init: RequestInit) => Promise<Response>,
  current: () => Source, complete: () => void): Promise<boolean> {
  source = { ...source };
  try {
    if (source.serverUrl) {
      const response = await request(`${source.serverUrl}/api/user/sign_out`, { credentials: 'include' });
      await drainResponseBodyQuietly(response);
    }
  } catch { /* Explicit local sign-out remains available when its server fails. */ }
  const latest = current();
  if (latest.serverUrl !== source.serverUrl || latest.sessionRevision !== source.sessionRevision) return false;
  complete();
  return true;
}
