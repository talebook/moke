'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useServerStore } from '@/lib/store/server';
import { useSettingsStore } from '@/lib/store/settings';
import { navigateFullDocument } from '@/lib/moke-reader';
import { request } from '@/lib/api';
import { AppStartupScreen } from '@/components/ui/AppStartupScreen';
import { APP_BACK_EVENT } from '@/lib/native-back';
import {
  CONTINUE_READING_NATIVE_EVENT,
  continueReadingHref,
  getContinueReading,
  resolveContinueReading,
} from '@/lib/continue-reading';

export default function HomePage() {
  const router = useRouter();
  const serverUrl = useServerStore((state) => state.serverUrl);
  const offlineMode = useServerStore((state) => state.offlineMode);
  const hasHydrated = useServerStore((state) => state.hasHydrated);
  const storageBusy = useServerStore((state) => state.storageBusy);
  const continueReadingOnLaunch = useSettingsStore((state) => state.continueReadingOnLaunch);
  const [message, setMessage] = useState('正在打开墨客…');
  const nativeShortcutHandledRef = useRef(false);

  useEffect(() => {
    if (!hasHydrated || storageBusy || nativeShortcutHandledRef.current) return;
    let cancelled = false;
    const controller = new AbortController();
    // The history request timeout must not invalidate a legitimate navigation.
    const navigationController = new AbortController();
    let navigationTimer: number | undefined;
    const historyTimeout = window.setTimeout(() => controller.abort(), 3_000);
    const cancelLaunch = () => {
      cancelled = true;
      controller.abort();
      navigationController.abort();
      window.clearTimeout(historyTimeout);
      if (navigationTimer !== undefined) window.clearTimeout(navigationTimer);
    };
    const handleNativeShortcut = () => {
      // The launcher owns this explicit request. Cancel the default startup
      // navigation before it can overwrite the shortcut's detail/reader route.
      // Retain that decision through React's development effect replay.
      nativeShortcutHandledRef.current = true;
      cancelLaunch();
    };
    // BACK may start a slow route transition while Home is still mounted.
    // Invalidate the launch immediately, before its safety timer can win.
    window.addEventListener(APP_BACK_EVENT, cancelLaunch);
    window.addEventListener('pagehide', cancelLaunch);
    window.addEventListener(CONTINUE_READING_NATIVE_EVENT, handleNativeShortcut);

    const navigate = (target: string) => {
      // Let an effect cleanup cancel a stale launch before issuing native
      // navigation, including React's development setup/cleanup cycle.
      queueMicrotask(() => {
        if (cancelled) return;
        setMessage(target.startsWith('/detail?') ? '正在打开上次阅读的书籍…' : '正在进入墨客…');
        // On single-WebView runtimes (OHOS/Android), App Router's RSC navigation
        // over the custom scheme can leave this page stuck on its spinner.
        void navigateFullDocument(target, router.replace, undefined, navigationController.signal);
        navigationTimer = window.setTimeout(() => {
          if (!navigationController.signal.aborted) router.replace(target);
        }, 1_500);
      });
    };

    void (async () => {
      const fallback = serverUrl || offlineMode ? '/shelf' : '/welcome';
      if (!continueReadingOnLaunch || (!serverUrl && !offlineMode)) {
        navigate(fallback);
        return;
      }

      try {
        if (!cancelled) setMessage('正在读取阅读记录…');
        const entry = getContinueReading(serverUrl, offlineMode ? 'offline' : 'online')
          ?? (!offlineMode ? await resolveContinueReading(request, serverUrl, controller.signal) : null);
        navigate(entry ? continueReadingHref(entry) : fallback);
      } catch {
        navigate(fallback);
      }
    })();

    return () => {
      cancelLaunch();
      window.removeEventListener(APP_BACK_EVENT, cancelLaunch);
      window.removeEventListener('pagehide', cancelLaunch);
      window.removeEventListener(CONTINUE_READING_NATIVE_EVENT, handleNativeShortcut);
    };
  }, [continueReadingOnLaunch, hasHydrated, storageBusy, offlineMode, serverUrl, router]);

  return <AppStartupScreen message={message} />;
}
