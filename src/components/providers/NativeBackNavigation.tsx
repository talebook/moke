'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { APP_BACK_EVENT, resolveNativeBackTarget, trackNativeRoute } from '@/lib/native-back';

const BACK_TRANSITION_CLASS = 'moke-native-back-transition';
const BACK_TRANSITION_TIMEOUT_MS = 1_000;

type PendingNavigation = {
  target: string;
  resolve: () => void;
  timeoutId: number;
};

function shouldReduceBackMotion(): boolean {
  const root = document.documentElement;
  return root.dataset.eink === 'true'
    || window.matchMedia('(prefers-reduced-motion: reduce), (update: slow), (max-color: 1)').matches;
}

/** Receives Android BACK events forwarded by MainActivity on nested pages. */
export function NativeBackNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const routeStackRef = useRef<string[]>([]);
  const pendingNavigationRef = useRef<PendingNavigation | null>(null);
  const transitionRunningRef = useRef(false);

  useEffect(() => {
    routeStackRef.current = trackNativeRoute(pathname, routeStackRef.current);

    const pending = pendingNavigationRef.current;
    if (pending && pending.target === pathname) {
      window.clearTimeout(pending.timeoutId);
      pendingNavigationRef.current = null;
      pending.resolve();
    }
  }, [pathname]);

  useEffect(() => {
    const handleNativeBack = (event: Event) => {
      if (transitionRunningRef.current) return;

      const requestedTarget = (event as CustomEvent<{ target?: string }>).detail?.target;
      const { target: stackTarget, nextStack } = resolveNativeBackTarget(pathname, routeStackRef.current);
      const target = requestedTarget ?? stackTarget;
      routeStackRef.current = nextStack;

      // Use a known app route instead of WebView/browser history. The latter
      // can contain full-document entries and reload the static Tauri page.
      const navigate = () => router.replace(target);
      if (shouldReduceBackMotion() || !document.startViewTransition) {
        navigate();
        return;
      }

      transitionRunningRef.current = true;
      document.documentElement.classList.add(BACK_TRANSITION_CLASS);

      const transition = document.startViewTransition(() => new Promise<void>((resolve) => {
        // Keep the transition callback pending until React has committed the
        // destination route. This lets the browser capture the real previous
        // and next pages instead of two snapshots of the current page.
        const timeoutId = window.setTimeout(resolve, BACK_TRANSITION_TIMEOUT_MS);
        pendingNavigationRef.current = { target, resolve, timeoutId };
        navigate();
      }));

      void transition.finished
        .catch(() => undefined)
        .then(() => {
          const pending = pendingNavigationRef.current;
          if (pending) {
            window.clearTimeout(pending.timeoutId);
            pendingNavigationRef.current = null;
            pending.resolve();
          }
          transitionRunningRef.current = false;
          document.documentElement.classList.remove(BACK_TRANSITION_CLASS);
        });
    };
    window.addEventListener(APP_BACK_EVENT, handleNativeBack);
    return () => window.removeEventListener(APP_BACK_EVENT, handleNativeBack);
  }, [pathname, router]);

  useEffect(() => () => {
    const pending = pendingNavigationRef.current;
    if (pending) {
      window.clearTimeout(pending.timeoutId);
      pending.resolve();
      pendingNavigationRef.current = null;
    }
    document.documentElement.classList.remove(BACK_TRANSITION_CLASS);
  }, []);

  return null;
}

declare global {
  interface WindowEventMap {
    'moke:native-back': Event;
  }
}
