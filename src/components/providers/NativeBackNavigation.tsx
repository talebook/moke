'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { APP_BACK_EVENT } from '@/lib/native-back';
import {
  NativeBackTransitionController,
  shouldAnimateNativeBack,
} from '@/lib/native-back-transition';

const BACK_TRANSITION_CLASS = 'moke-native-back-transition';

type NativeBackEvent = CustomEvent<{ target?: string }> | Event;

function requestedBackTarget(event: NativeBackEvent): string | undefined {
  return 'detail' in event ? event.detail?.target : undefined;
}

function shouldAnimateBack(): boolean {
  const root = document.documentElement;
  const runtimePlatform = root.dataset.mokeRuntimePlatform ?? '';
  const motionReduced = root.dataset.eink === 'true'
    || window.matchMedia(
      '(prefers-reduced-motion: reduce), (update: slow), (max-color: 1)',
    ).matches;
  return shouldAnimateNativeBack(
    runtimePlatform,
    motionReduced,
    Boolean(document.startViewTransition),
  );
}

/** Receives mobile native BACK events and serializes animated route changes. */
export function NativeBackNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const initialPathnameRef = useRef(pathname);
  const controllerRef = useRef<NativeBackTransitionController | null>(null);

  useEffect(() => {
    const controller = new NativeBackTransitionController(initialPathnameRef.current, {
      navigate: (target) => router.replace(target),
      canAnimate: shouldAnimateBack,
      startViewTransition: (update) => document.startViewTransition(update),
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
