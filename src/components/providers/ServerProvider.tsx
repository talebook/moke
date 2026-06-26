'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { fetchCurrentUser, fetchServerInfo } from '@/lib/api';
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
    if (!serverUrl) {
      setServerTitle('');
      setUser(null);
      return;
    }

    let cancelled = false;

    const syncUser = async () => {
      try {
        const [userData, serverData] = await Promise.all([fetchCurrentUser(), fetchServerInfo()]);
        if (!cancelled) {
          setUser(userData.user);
          setServerTitle(serverData.title || '');
        }
      } catch {
        if (!cancelled) {
          setUser(null);
          setServerTitle('');
        }
      }
    };

    syncUser();

    return () => {
      cancelled = true;
    };
  }, [hasHydrated, serverUrl, setServerTitle, setUser]);

  return <>{children}</>;
}
