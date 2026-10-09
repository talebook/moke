'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { request } from '@/lib/api';
import {
  CONTINUE_READING_CHANGED_EVENT,
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
  const shortcutEnabledRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    const syncShortcut = () => {
      const bridge = window.MokeWindowMode;
      if (!bridge?.setContinueReadingShortcutEnabled) return;
      const { serverUrl, offlineMode, hasHydrated } = useServerStore.getState();
      if (!hasHydrated) return;
      const enabled = getContinueReading(serverUrl, offlineMode ? 'offline' : 'online') !== null;
      // Progress events can be frequent; only publish a changed availability.
      if (enabled === shortcutEnabledRef.current) return;
      try {
        bridge.setContinueReadingShortcutEnabled(enabled);
        shortcutEnabledRef.current = enabled;
      } catch {
        // Older builds or an unavailable launcher must not block reading.
      }
    };
    const unsubscribe = useServerStore.subscribe(syncShortcut);
    window.addEventListener(CONTINUE_READING_CHANGED_EVENT, syncShortcut);
    window.addEventListener('storage', syncShortcut);
    syncShortcut();
    return () => {
      unsubscribe();
      window.removeEventListener(CONTINUE_READING_CHANGED_EVENT, syncShortcut);
      window.removeEventListener('storage', syncShortcut);
    };
  }, []);

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
        // Notify Home as well: its default startup redirect must yield to the
        // same explicit request used by warm launches.
        window.dispatchEvent(new Event(CONTINUE_READING_NATIVE_EVENT));
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
