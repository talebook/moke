'use client';

import { Fragment, useEffect, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { fetchCurrentUser, fetchServerInfo, checkWelcomeRequirement, discoverServerCapabilities } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';
import { getServerDiscoveryInputs } from '@/lib/server-capabilities';
import { navigateFullDocument } from '@/lib/moke-reader';
import { isServerCapabilitiesFresh, resolveUserAfterSync } from '@/lib/server-session';

const PUBLIC_PATHS = ['/welcome', '/login', '/register', '/access', '/privacy', '/settings/developer'];

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { serverUrl, offlineMode, hasHydrated, readerReturnTo, capabilities, connectionId, sessionId, loadServers, setServerTitle, setUser, setServerCapabilities } = useServerStore();
  const previousPath = useRef(pathname);
  useEffect(() => {
    const previous = previousPath.current;
    previousPath.current = pathname;
    // Route transitions, rather than component cleanup, also work with Strict
    // Mode effect replay and Next's cached Activity pages.
    if ((previous === '/access' && pathname !== '/access')
      || (previous === '/welcome' && pathname !== '/welcome' && pathname !== '/access')) {
      useServerStore.getState().cancelConnection();
    }
  }, [pathname]);
  const [discoveryServerUrl, capabilitiesCheckedAt] = getServerDiscoveryInputs(serverUrl, capabilities);

  useEffect(() => { if (!useServerStore.getState().hasHydrated) void loadServers(); }, [loadServers]);

  useEffect(() => {
    if (!hasHydrated || !readerReturnTo) return;
    if (pathname === readerReturnTo) useServerStore.setState({ readerReturnTo: null });
    else router.replace(readerReturnTo);
  }, [hasHydrated, pathname, readerReturnTo, router]);

  // 拓展管理页面是本地功能，不需要连接服务器
  const isExtensionPath = pathname.startsWith('/extensions');
  const isEmbeddedReaderPath = pathname.startsWith('/readest');

  useEffect(() => {
    if (!hasHydrated) return;
    if (PUBLIC_PATHS.includes(pathname) || isExtensionPath || isEmbeddedReaderPath) return;
    if (!serverUrl && !offlineMode) {
      // Use full-document navigation on single-WebView runtimes (OHOS) to avoid
      // getting stuck on the blank loading screen when RSC navigation fails.
      navigateFullDocument('/welcome', router.replace);
    }
  }, [hasHydrated, isEmbeddedReaderPath, isExtensionPath, offlineMode, pathname, serverUrl, router]);

  useEffect(() => {
    if (!hasHydrated) return;
    if (offlineMode) return;
    if (PUBLIC_PATHS.includes(pathname) || isExtensionPath || isEmbeddedReaderPath) return;
    if (!discoveryServerUrl) return;

    // 能力探测整轮（checkWelcomeRequirement + fetchCurrentUser + fetchServerInfo
    // + discoverServerCapabilities）较重，结果带 checkedAt 缓存：5 分钟内路由
    // 切换不再整轮重跑。serverUrl 变化时 setServer 会重置 capabilities
    // （checkedAt=null），因此会自然失效重探；user/title 同步随之节流。
    if (isServerCapabilitiesFresh(capabilitiesCheckedAt)) return;

    let cancelled = false;
    const abort = new AbortController();
    const isCurrent = () => !cancelled && useServerStore.getState().connectionId === connectionId
      && useServerStore.getState().sessionId === sessionId;

    const checkAccess = async () => {
      const userAtSyncStart = useServerStore.getState().user;

      try {
        const welcome = await checkWelcomeRequirement(discoveryServerUrl, abort.signal);
        if (!isCurrent()) return;
        if (welcome.err !== 'ok') throw new Error(welcome.msg || '访问码状态检查失败');
        if (welcome.needsAccessCode) {
          console.log('[ServerProvider] needs access code, redirecting to /access');
          const state = useServerStore.getState();
          const candidate = state.activeServerId ? state.beginConnection(state.activeServerId) : null;
          if (candidate) {
            state.requireAccess(candidate.requestId);
            router.replace(`/access?serverId=${candidate.id}&requestId=${candidate.requestId}`);
          } else router.replace('/welcome');
          return;
        }

        const [userResult, serverResult, capabilitiesResult] = await Promise.allSettled([
          fetchCurrentUser(discoveryServerUrl, abort.signal),
          fetchServerInfo(discoveryServerUrl, abort.signal),
          discoverServerCapabilities(discoveryServerUrl),
        ]);
        if (!isCurrent()) return;

        const currentState = useServerStore.getState();
        if (currentState.serverUrl !== discoveryServerUrl) return;
        const currentUser = currentState.user;
        const syncStillCurrent = currentUser === userAtSyncStart;
        const syncedUser = resolveUserAfterSync(userAtSyncStart, currentUser, userResult);

        if (serverResult.status === 'fulfilled') {
          setServerTitle(serverResult.value.title || '');
        } else {
          console.warn('[ServerProvider] server info sync failed:', serverResult.reason);
        }

        if (userResult.status === 'fulfilled' && syncStillCurrent) {
          // Only a confirmed guest response may clear the cached user. A
          // rejected request says nothing about whether the cookie is valid.
          setUser(syncedUser);
        } else if (userResult.status === 'fulfilled') {
          console.warn('[ServerProvider] stale user sync ignored after session change');
        } else {
          console.warn('[ServerProvider] user sync failed:', userResult.reason);
        }

        if (capabilitiesResult.status === 'fulfilled' && userResult.status === 'fulfilled' && syncStillCurrent) {
          // Global discovery intentionally does not download annotation data.
          // Commit the matching user first so a real session transition clears
          // the panel-owned result, then preserve that post-transition state.
          const currentCapabilities = useServerStore.getState().capabilities;
          setServerCapabilities({
            ...capabilitiesResult.value,
            annotationApiStatus: currentCapabilities.annotationApiStatus,
            annotationApiCheckedAt: currentCapabilities.annotationApiCheckedAt,
          });
        } else if (capabilitiesResult.status === 'rejected') {
          console.warn('[ServerProvider] capabilities sync failed:', capabilitiesResult.reason);
        }
      } catch (e) {
        // Welcome/network failures are transient. Preserve the last confirmed
        // user, title, and capability snapshot for the next sync attempt.
        if (isCurrent()) console.warn('[ServerProvider] sync error:', e);
      }
    };

    checkAccess();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [capabilitiesCheckedAt, connectionId, sessionId, discoveryServerUrl, hasHydrated, isEmbeddedReaderPath, isExtensionPath, offlineMode, pathname, router, setServerCapabilities, setServerTitle, setUser]);

  // Protected pages must not start requests while loading or redirecting an
  // absent runtime connection (including return from a full-document reader).
  if (!PUBLIC_PATHS.includes(pathname) && !isExtensionPath && !isEmbeddedReaderPath
    && (!hasHydrated || (readerReturnTo && pathname !== readerReturnTo) || (!serverUrl && !offlineMode))) {
    return <div role="status" className="flex min-h-screen items-center justify-center">正在加载连接信息…</div>;
  }
  return <Fragment key={`${connectionId}:${sessionId}:${offlineMode}`}>{children}</Fragment>;
}
