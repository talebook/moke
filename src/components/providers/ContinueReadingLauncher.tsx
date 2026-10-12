'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { request } from '@/lib/api';
import {
  CONTINUE_READING_CHANGED_EVENT,
  CONTINUE_READING_NATIVE_EVENT,
  continueReadingHref,
  fetchContinueReadingFromHistory,
  getContinueReading,
  rememberContinueReading,
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
    let disposed = false;
    let activeController: AbortController | null = null;
    let activeTimeout: number | undefined;
    let matchesActiveContext: (() => boolean) | null = null;
    const cancelActive = () => {
      const controller = activeController;
      activeController = null;
      matchesActiveContext = null;
      openingRef.current = false;
      if (activeTimeout !== undefined) window.clearTimeout(activeTimeout);
      activeTimeout = undefined;
      controller?.abort();
    };
    const unsubscribe = useServerStore.subscribe(() => {
      if (matchesActiveContext && !matchesActiveContext()) cancelActive();
    });
    const openLatest = async () => {
      if (disposed || openingRef.current) return;
      openingRef.current = true;
      const controller = new AbortController();
      const captured = useServerStore.getState();
      const { serverUrl, offlineMode, connectionId, sessionId, candidate } = captured;
      const matchesContext = () => {
        const current = useServerStore.getState();
        return current.connectionId === connectionId && current.sessionId === sessionId
          && current.serverUrl === serverUrl && current.offlineMode === offlineMode
          && current.candidate === candidate && !candidate;
      };
      activeController = controller;
      matchesActiveContext = matchesContext;
      const isCurrent = () => !disposed && activeController === controller
        && !controller.signal.aborted && matchesContext();
      const timeout = window.setTimeout(() => {
        if (activeController === controller) cancelActive();
      }, 3_000);
      activeTimeout = timeout;
      try {
        if (!isCurrent()) return;
        if (!serverUrl && !offlineMode) {
          useToast.getState().show('请先连接 Talebook 服务器');
          router.push('/welcome');
          return;
        }
        let entry = getContinueReading(serverUrl, offlineMode ? 'offline' : 'online');
        if (!entry && !offlineMode) {
          entry = await fetchContinueReadingFromHistory(request, serverUrl, controller.signal);
          if (!isCurrent()) return;
          // The convenience resolver persists before returning. Confirm this
          // source/session first so an old account cannot replace its record.
          if (entry) rememberContinueReading(entry);
        }
        if (!isCurrent()) return;
        if (!entry) {
          useToast.getState().show('暂无可继续阅读的书籍');
          router.push('/shelf');
          return;
        }
        router.push(continueReadingHref(entry));
      } catch {
        if (!isCurrent()) return;
        useToast.getState().show('暂时无法读取最近阅读记录');
        router.push('/shelf');
      } finally {
        window.clearTimeout(timeout);
        if (activeController === controller) {
          activeController = null;
          matchesActiveContext = null;
          activeTimeout = undefined;
          openingRef.current = false;
        }
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
      disposed = true;
      unsubscribe();
      cancelActive();
      window.removeEventListener(CONTINUE_READING_NATIVE_EVENT, handleNativeRequest);
    };
  }, [router]);

  return <>{children}</>;
}
