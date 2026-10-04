'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useServerStore } from '@/lib/store/server';
import { useSettingsStore } from '@/lib/store/settings';
import { navigateFullDocument } from '@/lib/moke-reader';
import { request } from '@/lib/api';
import {
  continueReadingHref,
  getContinueReading,
  resolveContinueReading,
} from '@/lib/continue-reading';

export default function HomePage() {
  const router = useRouter();
  const { serverUrl, offlineMode, hasHydrated } = useServerStore();
  const continueReadingOnLaunch = useSettingsStore((state) => state.continueReadingOnLaunch);

  useEffect(() => {
    if (!hasHydrated) return;
    let cancelled = false;
    const controller = new AbortController();
    let navigationTimer: number | undefined;
    const historyTimeout = window.setTimeout(() => controller.abort(), 3_000);

    const navigate = (target: string) => {
      if (cancelled) return;
      // On single-WebView runtimes (OHOS/Android), App Router's RSC navigation
      // over the custom scheme can leave this page stuck on its spinner.
      void navigateFullDocument(target, router.replace);
      navigationTimer = window.setTimeout(() => router.replace(target), 1_500);
    };

    void (async () => {
      const fallback = serverUrl || offlineMode ? '/shelf' : '/welcome';
      if (!continueReadingOnLaunch || (!serverUrl && !offlineMode)) {
        navigate(fallback);
        return;
      }

      try {
        const entry = getContinueReading(serverUrl, offlineMode ? 'offline' : 'online')
          ?? (!offlineMode ? await resolveContinueReading(request, serverUrl, controller.signal) : null);
        navigate(entry ? continueReadingHref(entry) : fallback);
      } catch {
        navigate(fallback);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(historyTimeout);
      if (navigationTimer !== undefined) window.clearTimeout(navigationTimer);
    };
  }, [continueReadingOnLaunch, hasHydrated, offlineMode, serverUrl, router]);

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
    </div>
  );
}
