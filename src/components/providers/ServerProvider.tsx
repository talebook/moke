'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { fetchCurrentUser, fetchServerInfo, checkWelcomeRequirement, discoverServerCapabilities } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';
import { getServerDiscoveryInputs } from '@/lib/server-capabilities';
import { navigateFullDocument } from '@/lib/moke-reader';

/** 能力探测结果的有效期：期限内路由切换不再整轮重跑（约 7+ 个请求） */
const SYNC_CAPABILITIES_TTL_MS = 5 * 60 * 1000;
const PUBLIC_PATHS = ['/welcome', '/login', '/register', '/access', '/privacy', '/settings/developer'];

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { serverUrl, hasHydrated, capabilities, setServerTitle, setUser, setServerCapabilities } = useServerStore();
  const [discoveryServerUrl, capabilitiesCheckedAt] = getServerDiscoveryInputs(serverUrl, capabilities);

  // 拓展管理页面是本地功能，不需要连接服务器
  const isExtensionPath = pathname.startsWith('/extensions');
  const isEmbeddedReaderPath = pathname.startsWith('/readest');

  useEffect(() => {
    if (!hasHydrated) return;
    if (PUBLIC_PATHS.includes(pathname) || isExtensionPath || isEmbeddedReaderPath) return;
    if (!serverUrl) {
      // Use full-document navigation on single-WebView runtimes (OHOS) to avoid
      // getting stuck on the blank loading screen when RSC navigation fails.
      navigateFullDocument('/welcome', router.replace);
    }
  }, [hasHydrated, isEmbeddedReaderPath, isExtensionPath, pathname, serverUrl, router]);

  useEffect(() => {
    if (!hasHydrated) return;
    if (PUBLIC_PATHS.includes(pathname) || isExtensionPath || isEmbeddedReaderPath) return;
    if (!discoveryServerUrl) return;

    // 能力探测整轮（checkWelcomeRequirement + fetchCurrentUser + fetchServerInfo
    // + discoverServerCapabilities）较重，结果带 checkedAt 缓存：5 分钟内路由
    // 切换不再整轮重跑。serverUrl 变化时 setServer 会重置 capabilities
    // （checkedAt=null），因此会自然失效重探；user/title 同步随之节流。
    const capabilitiesFresh = capabilitiesCheckedAt != null
      && Date.now() - capabilitiesCheckedAt < SYNC_CAPABILITIES_TTL_MS;
    if (capabilitiesFresh) return;

    let cancelled = false;

    const checkAccess = async () => {
      try {
        const welcome = await checkWelcomeRequirement(discoveryServerUrl);
        if (!cancelled && welcome.needsAccessCode) {
          console.log('[ServerProvider] needs access code, redirecting to /access');
          router.replace('/access');
          return;
        }

        const [userData, serverData, discoveredCapabilities] = await Promise.all([
          fetchCurrentUser(),
          fetchServerInfo(),
          discoverServerCapabilities(discoveryServerUrl),
        ]);
        if (!cancelled) {
          const currentState = useServerStore.getState();
          if (currentState.serverUrl !== discoveryServerUrl) return;
          // Global discovery intentionally does not download annotation data.
          // Preserve the panel-owned result across the general five-minute TTL.
          const currentCapabilities = currentState.capabilities;
          setUser(userData.user);
          setServerTitle(serverData.title || '');
          setServerCapabilities({
            ...discoveredCapabilities,
            annotationApiStatus: currentCapabilities.annotationApiStatus,
            annotationApiCheckedAt: currentCapabilities.annotationApiCheckedAt,
          });
        }
      } catch (e) {
        console.error('[ServerProvider] sync error:', e);
        if (!cancelled) {
          setUser(null);
          setServerTitle('');
        }
      }
    };

    checkAccess();

    return () => {
      cancelled = true;
    };
  }, [capabilitiesCheckedAt, discoveryServerUrl, hasHydrated, isEmbeddedReaderPath, isExtensionPath, pathname, router, setServerCapabilities, setServerTitle, setUser]);

  return <>{children}</>;
}
