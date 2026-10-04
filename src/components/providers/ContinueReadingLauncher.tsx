'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { request } from '@/lib/api';
import {
  CONTINUE_READING_NATIVE_EVENT,
  continueReadingHref,
  getContinueReading,
  resolveContinueReading,
} from '@/lib/continue-reading';
import { useServerStore } from '@/lib/store/server';
import { useToast } from '@/lib/toast';

export function ContinueReadingLauncher({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const openingRef = useRef(false);

  useEffect(() => {
    const openLatest = async () => {
      if (openingRef.current) return;
      openingRef.current = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 3_000);
      try {
        const { serverUrl, offlineMode } = useServerStore.getState();
        if (!serverUrl && !offlineMode) {
          useToast.getState().show('请先连接 Talebook 服务器');
          router.push('/welcome');
          return;
        }
        const entry = getContinueReading(serverUrl, offlineMode ? 'offline' : 'online')
          ?? (!offlineMode ? await resolveContinueReading(request, serverUrl, controller.signal) : null);
        if (!entry) {
          useToast.getState().show('暂无可继续阅读的书籍');
          router.push('/shelf');
          return;
        }
        router.push(continueReadingHref(entry));
      } catch {
        useToast.getState().show('暂时无法读取最近阅读记录');
        router.push('/shelf');
      } finally {
        window.clearTimeout(timeout);
        openingRef.current = false;
      }
    };

    const consumeNativeRequest = () => {
      try {
        return window.MokeWindowMode?.consumeContinueReadingLaunch?.() === true;
      } catch {
        return false;
      }
    };
    const handleNativeRequest = () => {
      consumeNativeRequest();
      void openLatest();
    };
    window.addEventListener(CONTINUE_READING_NATIVE_EVENT, handleNativeRequest);

    try {
      if (consumeNativeRequest()) {
        void openLatest();
      }
    } catch {
      // Older Android builds do not expose the shortcut bridge.
    }

    return () => {
      window.removeEventListener(CONTINUE_READING_NATIVE_EVENT, handleNativeRequest);
    };
  }, [router]);

  return <>{children}</>;
}
