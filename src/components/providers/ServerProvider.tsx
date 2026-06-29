'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { fetchCurrentUser, fetchServerInfo, checkWelcomeRequirement } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';

export function ServerProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { serverUrl, hasHydrated, setServerTitle, setUser } = useServerStore();

  const publicPaths = ['/welcome', '/login', '/register', '/access'];

  useEffect(() => {
    if (!hasHydrated) return;
    if (publicPaths.includes(pathname)) return;
    if (!serverUrl) {
      router.replace('/welcome');
    }
  }, [hasHydrated, pathname, serverUrl, router]);

  useEffect(() => {
    if (!hasHydrated) return;
    if (publicPaths.includes(pathname)) return;
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

        const [userData, serverData] = await Promise.all([fetchCurrentUser(), fetchServerInfo()]);
        if (!cancelled) {
          setUser(userData.user);
          setServerTitle(serverData.title || '');
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
  }, [hasHydrated, pathname, serverUrl, setServerTitle, setUser]);

  return <>{children}</>;
}
