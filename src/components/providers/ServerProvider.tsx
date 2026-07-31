'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { fetchCurrentUser, fetchServerInfo, checkWelcomeRequirement, discoverServerCapabilities } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { serverUrl, hasHydrated, setServerTitle, setUser, setServerCapabilities } = useServerStore();

  const publicPaths = ['/welcome', '/login', '/register', '/access', '/settings/developer'];

  // 拓展管理页面是本地功能，不需要连接服务器
  const isExtensionPath = pathname.startsWith('/extensions');
  const isEmbeddedReaderPath = pathname.startsWith('/readest');

  useEffect(() => {
    if (!hasHydrated) return;
    if (publicPaths.includes(pathname) || isExtensionPath || isEmbeddedReaderPath) return;
    if (!serverUrl) {
      router.replace('/welcome');
    }
  }, [hasHydrated, isEmbeddedReaderPath, pathname, serverUrl, router]);

  useEffect(() => {
    if (!hasHydrated) return;
    if (publicPaths.includes(pathname) || isExtensionPath || isEmbeddedReaderPath) return;
    if (!serverUrl) return;

    let cancelled = false;

    const checkAccess = async () => {
      try {
        const welcome = await checkWelcomeRequirement(serverUrl);
        if (!cancelled && welcome.needsAccessCode) {
          console.log('[ServerProvider] needs access code, redirecting to /access');
          router.replace('/access');
          return;
        }

        const [userData, serverData, capabilities] = await Promise.all([
          fetchCurrentUser(),
          fetchServerInfo(),
          discoverServerCapabilities(serverUrl),
        ]);
        if (!cancelled) {
          setUser(userData.user);
          setServerTitle(serverData.title || '');
          setServerCapabilities(capabilities);
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
  }, [hasHydrated, isEmbeddedReaderPath, pathname, serverUrl, setServerCapabilities, setServerTitle, setUser]);

  return <>{children}</>;
}
