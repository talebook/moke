'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { fetchCurrentUser, fetchServerInfo, checkWelcomeRequirement, discoverServerCapabilities } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';
import { navigateFullDocument } from '@/lib/moke-reader';
import { isServerCapabilitiesFresh, resolveUserAfterSync } from '@/lib/server-session';

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { serverUrl, hasHydrated, capabilities, setServerTitle, setUser, setServerCapabilities } = useServerStore();

  const publicPaths = ['/welcome', '/login', '/register', '/access', '/privacy', '/settings/developer'];

  // 拓展管理页面是本地功能，不需要连接服务器
  const isExtensionPath = pathname.startsWith('/extensions');
  const isEmbeddedReaderPath = pathname.startsWith('/readest');

  useEffect(() => {
    if (!hasHydrated) return;
    if (publicPaths.includes(pathname) || isExtensionPath || isEmbeddedReaderPath) return;
    if (!serverUrl) {
      // Use full-document navigation on single-WebView runtimes (OHOS) to avoid
      // getting stuck on the blank loading screen when RSC navigation fails.
      navigateFullDocument('/welcome', router.replace);
    }
  }, [hasHydrated, isEmbeddedReaderPath, pathname, serverUrl, router]);

  useEffect(() => {
    if (!hasHydrated) return;
    if (publicPaths.includes(pathname) || isExtensionPath || isEmbeddedReaderPath) return;
    if (!serverUrl) return;

    // 能力探测整轮（checkWelcomeRequirement + fetchCurrentUser + fetchServerInfo
    // + discoverServerCapabilities）较重，结果带 checkedAt 缓存：5 分钟内路由
    // 切换不再整轮重跑。serverUrl 变化时 setServer 会重置 capabilities
    // （checkedAt=null），因此会自然失效重探；user/title 同步随之节流。
    if (isServerCapabilitiesFresh(capabilities.checkedAt)) return;

    let cancelled = false;

    const checkAccess = async () => {
      const userAtSyncStart = useServerStore.getState().user;

      try {
        const welcome = await checkWelcomeRequirement(serverUrl);
        if (!cancelled && welcome.needsAccessCode) {
          console.log('[ServerProvider] needs access code, redirecting to /access');
          router.replace('/access');
          return;
        }

        const [userResult, serverResult, capabilitiesResult] = await Promise.allSettled([
          fetchCurrentUser(),
          fetchServerInfo(),
          discoverServerCapabilities(serverUrl),
        ]);
        if (cancelled) return;

        const currentUser = useServerStore.getState().user;
        const syncStillCurrent = currentUser === userAtSyncStart;
        const syncedUser = resolveUserAfterSync(userAtSyncStart, currentUser, userResult);

        if (serverResult.status === 'fulfilled') {
          setServerTitle(serverResult.value.title || '');
        } else {
          console.warn('[ServerProvider] server info sync failed:', serverResult.reason);
        }

        if (capabilitiesResult.status === 'fulfilled' && userResult.status === 'fulfilled' && syncStillCurrent) {
          // Store the snapshot before the matching user. If the confirmed
          // session changed, setUser invalidates checkedAt again so a probe
          // made under the old auth state cannot become a fresh cache.
          setServerCapabilities(capabilitiesResult.value);
        } else if (capabilitiesResult.status === 'rejected') {
          console.warn('[ServerProvider] capabilities sync failed:', capabilitiesResult.reason);
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
      } catch (e) {
        // Welcome/network failures are transient. Preserve the last confirmed
        // user, title, and capability snapshot for the next sync attempt.
        console.error('[ServerProvider] sync error:', e);
      }
    };

    checkAccess();

    return () => {
      cancelled = true;
    };
  }, [hasHydrated, isEmbeddedReaderPath, pathname, serverUrl, capabilities, setServerCapabilities, setServerTitle, setUser]);

  return <>{children}</>;
}
