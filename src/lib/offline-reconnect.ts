import { useServerStore } from './store/server.ts';
import type { CurrentUserResult } from './server-session.ts';
import { throwIfAborted } from './abort-signal.ts';

interface ReconnectApi {
  checkAccess: (serverUrl: string, signal: AbortSignal) => Promise<{ err: string; needsAccessCode: boolean }>;
  fetchUser: (serverUrl: string, signal?: AbortSignal) => Promise<CurrentUserResult>;
}

export type OfflineReconnectResult =
  | { target: '/welcome' | '/shelf' | '/login?reconnect=1' | `/access?serverId=${string}&requestId=${number}` }
  | { cancelled: true };

/** Reconfirm the retained runtime session; a saved address or mirror never activates it. */
export async function reconnectOfflineServer(
  api: ReconnectApi,
  signal: AbortSignal,
  timeoutMs = 15_000,
): Promise<OfflineReconnectResult> {
  const before = useServerStore.getState();
  const isCurrent = () => {
    const current = useServerStore.getState();
    return !signal.aborted && current.offlineMode && !current.candidate
      && current.serverUrl === before.serverUrl && current.connectionId === before.connectionId
      && current.sessionId === before.sessionId;
  };
  if (!isCurrent()) return { cancelled: true };
  if (!before.serverUrl) {
    if (!await before.leaveOfflineMode(before, undefined, signal)) return { cancelled: true };
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
    const error = new Error('连接超时，请检查服务器和网络后重试。');
    rejectStopped(error);
    controller.abort(error);
  }, timeoutMs);

  try {
    const result = await Promise.race([
      (async () => {
        const access = await api.checkAccess(before.serverUrl, controller.signal);
        if (controller.signal.aborted || !isCurrent()) return null;
        if (access.err !== 'ok') throw new Error('无法确认服务器访问权限，请检查连接后重试。');
        if (access.needsAccessCode) return { needsAccessCode: true, user: null };
        const user = await api.fetchUser(before.serverUrl, controller.signal);
        if (controller.signal.aborted || !isCurrent()) return null;
        return { needsAccessCode: false, user };
      })(),
      stopped,
    ]);
    if (!result || !isCurrent()) return { cancelled: true };
    if (result.needsAccessCode) {
      // The access page owns a real saved identity and request, retaining the
      // offline account until that candidate has actually been confirmed.
      const candidate = useServerStore.getState().beginActiveAccessConfirmation();
      return candidate
        ? { target: `/access?serverId=${encodeURIComponent(candidate.id)}&requestId=${candidate.requestId}` }
        : { target: '/welcome' };
    }
    if (!await before.leaveOfflineMode(before, result.user?.user, controller.signal)) {
      throwIfAborted(controller.signal);
      return { cancelled: true };
    }
    return { target: before.user && !result.user?.isLogin ? '/login?reconnect=1' : '/shelf' };
  } catch (error) {
    if (!isCurrent()) return { cancelled: true };
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
  }
}
