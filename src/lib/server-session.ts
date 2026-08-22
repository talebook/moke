// These relative `.ts` imports are intentional: this module and the server
// store are exercised directly by Node's strip-types test runner, which does
// not resolve the application's `@/` alias.
import { MokeApiError, readJsonResponse } from './api-core.ts';

export const SERVER_CAPABILITIES_TTL_MS = 5 * 60 * 1000;

export interface ReaderInfo {
  id: string | number;
  username: string;
  name: string;
  email: string;
  avatar: string;
  admin: boolean;
  permission: string;
}

export interface UserInfoResponse {
  err: string;
  msg?: string;
  sys?: {
    title?: string;
    version?: string;
  };
  user?: {
    id?: string | number;
    username?: string;
    nickname?: string;
    name?: string;
    email?: string;
    avatar?: string;
    is_login?: boolean;
    is_admin?: boolean;
    admin?: boolean;
    permission?: string;
  };
}

export interface CurrentUserResult {
  err: string;
  msg?: string;
  user: ReaderInfo | null;
  isLogin: boolean;
}

/**
 * An explicit Talebook guest response confirms logout. Transport, unrelated
 * HTTP errors, and unexpected application failures throw so callers can retain
 * their last confirmed user.
 */
export async function readCurrentUserResponse(response: Response): Promise<CurrentUserResult> {
  const data = await readJsonResponse<UserInfoResponse>(response, '登录状态响应无效。');

  const info = data.user || {};
  const isLogin = Boolean(info.is_login);
  const isConfirmedGuest = data.err === 'user.need_login'
    || (response.ok && data.err === 'ok' && !isLogin);

  if (isConfirmedGuest) {
    return {
      err: data.err || 'user.need_login',
      msg: data.msg,
      user: null,
      isLogin: false,
    };
  }

  if (!response.ok) {
    throw new MokeApiError(
      String(data.msg || `服务器返回 ${response.status}。`),
      String(data.err || `http.${response.status}`),
      response.status,
    );
  }

  if (data.err !== 'ok') {
    throw new MokeApiError(
      String(data.msg || '登录状态同步失败。'),
      String(data.err || 'server.user_sync_failed'),
      response.status,
    );
  }

  return {
    err: data.err,
    msg: data.msg,
    isLogin: true,
    user: {
      id: info.id ?? info.username ?? '',
      username: info.username ?? '',
      name: info.nickname ?? info.name ?? info.username ?? '',
      email: info.email ?? '',
      avatar: info.avatar ?? '',
      admin: Boolean(info.is_admin ?? info.admin),
      permission: info.permission ?? '',
    },
  };
}

export function isServerCapabilitiesFresh(
  checkedAt: number | null | undefined,
  now = Date.now(),
  ttlMs = SERVER_CAPABILITIES_TTL_MS,
): boolean {
  return checkedAt != null && now - checkedAt < ttlMs;
}

export function invalidateServerCapabilities<T extends { checkedAt: number | null }>(capabilities: T): T {
  if (capabilities.checkedAt === null) return capabilities;
  return { ...capabilities, checkedAt: null };
}

export function didServerSessionChange(
  previousUser: Pick<ReaderInfo, 'id'> | null,
  nextUser: Pick<ReaderInfo, 'id'> | null,
): boolean {
  if (previousUser === null || nextUser === null) return previousUser !== nextUser;
  return String(previousUser.id) !== String(nextUser.id);
}

/**
 * A rejected sync is unknown, not a confirmed logout. If the store's user
 * reference changed while the request was in flight, its result belongs to an
 * older session and must not overwrite the newer state (including a re-login
 * to the same account).
 */
export function resolveUserAfterSync<T>(
  userAtSyncStart: T | null,
  currentUser: T | null,
  result: PromiseSettledResult<{ user: T | null }>,
): T | null {
  if (currentUser !== userAtSyncStart) return currentUser;
  return result.status === 'fulfilled' ? result.value.user : currentUser;
}
