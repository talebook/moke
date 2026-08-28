'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { APP_BACK_EVENT } from '@/lib/native-back';
import {
  NativeBackTransitionController,
  shouldAnimateNativeBack,
} from '@/lib/native-back-transition';

const BACK_TRANSITION_CLASS = 'moke-native-back-transition';
const DESKTOP_PLATFORMS = new Set(['windows', 'macos', 'linux', 'desktop']);

type NativeBackEvent = CustomEvent<{ target?: string }> | Event;

function requestedBackTarget(event: NativeBackEvent): string | undefined {
  return 'detail' in event ? event.detail?.target : undefined;
}

function runtimePlatform(): string {
  const root = document.documentElement;
  let persistedRuntimePlatform = '';
  try {
    persistedRuntimePlatform = window.sessionStorage.getItem('moke-runtime-platform') ?? '';
  } catch {
    // Storage can be unavailable during restricted/custom-scheme startup.
  }
  return root.dataset.mokeRuntimePlatform
    || persistedRuntimePlatform
    || (process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri' ? 'desktop' : 'web');
}

function shouldAnimateBack(): boolean {
  const platform = runtimePlatform();
  const root = document.documentElement;
  const motionReduced = root.dataset.eink === 'true'
    || window.matchMedia(
      '(prefers-reduced-motion: reduce), (update: slow), (max-color: 1)',
    ).matches;
  return shouldAnimateNativeBack(
    platform,
    motionReduced,
    DESKTOP_PLATFORMS.has(platform) || Boolean(document.startViewTransition),
  );
}

function startDesktopBackTransition(update: () => Promise<void>) {
  const updateCallbackDone = update();
  let cancelled = false;
  let animation: Animation | undefined;
  const finished = updateCallbackDone.then(() => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      if (cancelled) {
        resolve();
        return;
      }
      const content = document.querySelector<HTMLElement>('.moke-route-content');
      if (!content) {
        resolve();
        return;
      }
      // Animate the newly committed page. The previous route's DesktopLayout
      // is unmounted during navigation, so animating it would be cancelled
      // before the first frame is painted.
      animation = content.animate(
        [
          { transform: 'translateX(-12%)', opacity: 0.68 },
          { transform: 'translateX(0)', opacity: 1 },
        ],
        { duration: 260, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      );
      void animation.finished.catch(() => undefined).then(() => resolve());
    });
  }));
  return {
    finished,
    updateCallbackDone,
    skipTransition: () => {
      cancelled = true;
      animation?.cancel();
    },
  };
}

/** Receives page/native BACK requests and serializes animated route changes. */
export function NativeBackNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  const controllerRef = useRef<NativeBackTransitionController | null>(null);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    // DOM methods must retain their Document receiver. Some WebView/Turbopack
    // combinations otherwise throw "Illegal invocation" when the callback runs.
    const startViewTransition = document.startViewTransition?.bind(document);
    // `router` can receive a new identity after navigation. If that recreates
    // this controller, seed it from the latest route rather than the route on
    // which the provider first mounted.
    const controller = new NativeBackTransitionController(pathnameRef.current, {
      navigate: (target) => router.replace(target),
      canAnimate: shouldAnimateBack,
      startViewTransition: (update) => DESKTOP_PLATFORMS.has(runtimePlatform())
        ? startDesktopBackTransition(update)
        : startViewTransition!(update),
      setTransitionActive: (active) => {
        document.documentElement.classList.toggle(BACK_TRANSITION_CLASS, active);
      },
    });
    controllerRef.current = controller;

    const handleNativeBack = (event: NativeBackEvent) => {
      controller.requestBack(requestedBackTarget(event));
    };
    window.addEventListener(APP_BACK_EVENT, handleNativeBack);
    return () => {
      window.removeEventListener(APP_BACK_EVENT, handleNativeBack);
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [router]);

  useEffect(() => {
    controllerRef.current?.pathnameChanged(pathname);
  }, [pathname]);

  return null;
}

declare global {
  interface WindowEventMap {
    'moke:native-back': CustomEvent<{ target?: string }> | Event;
  }
}
