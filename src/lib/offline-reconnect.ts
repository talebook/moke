import { useServerStore } from './store/server.ts';
import type { CurrentUserResult } from './server-session.ts';

interface ReconnectApi {
  checkAccess: (serverUrl: string, signal: AbortSignal) => Promise<{ err: string; needsAccessCode: boolean }>;
  fetchUser: (serverUrl: string) => Promise<CurrentUserResult>;
}

export type OfflineReconnectResult =
  | { target: '/welcome' | '/shelf' | '/login?reconnect=1' | `/access?server=${string}` }
  | { cancelled: true };

/** Restore the retained server/session; never call setServer (which clears auth). */
export async function reconnectOfflineServer(
  api: ReconnectApi,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<OfflineReconnectResult> {
  const before = useServerStore.getState();
  const isCurrent = () => {
    const current = useServerStore.getState();
    return !signal.aborted && current.offlineMode
      && current.serverUrl === before.serverUrl
      && current.sessionRevision === before.sessionRevision;
  };
  if (!isCurrent()) return { cancelled: true };
  if (!before.serverUrl) {
    before.leaveOfflineMode();
    return { target: '/welcome' };
  }

  const controller = new AbortController();
  let rejectStopped: (reason: unknown) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const cancel = () => {
    rejectStopped(new DOMException('Reconnect cancelled', 'AbortError'));
    controller.abort();
  };
  signal.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    rejectStopped(new Error('连接超时，请检查服务器和网络后重试。'));
    controller.abort();
  }, timeoutMs);

  try {
    const result = await Promise.race([
      (async () => {
        const access = await api.checkAccess(before.serverUrl, controller.signal);
        if (controller.signal.aborted || !isCurrent()) return null;
        if (access.err !== 'ok') throw new Error('无法确认服务器访问权限，请检查连接后重试。');
        if (access.needsAccessCode) return { needsAccessCode: true, user: null };
        const user = await api.fetchUser(before.serverUrl);
        return { needsAccessCode: false, user };
      })(),
      stopped,
    ]);
    if (!result || !isCurrent()) return { cancelled: true };

    // No mutation from the in-flight work: late replies after timeout or a
    // server/session change cannot bring the app online or replace its user.
    before.leaveOfflineMode();
    if (result.needsAccessCode) {
      return { target: `/access?server=${encodeURIComponent(before.serverUrl)}` };
    }
    if (result.user) useServerStore.getState().setUser(result.user.user);
    return { target: before.user && !result.user?.isLogin ? '/login?reconnect=1' : '/shelf' };
  } catch (error) {
    if (!isCurrent()) return { cancelled: true };
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
