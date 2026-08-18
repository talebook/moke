'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { resolveNativeBackTarget } from '@/lib/native-back';

/** Receives Android BACK events forwarded by MainActivity on nested pages. */
export function NativeBackNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const routeStackRef = useRef<string[]>([]);

  useEffect(() => {
    if (routeStackRef.current.at(-1) !== pathname) {
      routeStackRef.current.push(pathname);
    }
  }, [pathname]);

  useEffect(() => {
    const handleNativeBack = () => {
      const { target, nextStack } = resolveNativeBackTarget(pathname, routeStackRef.current);
      routeStackRef.current = nextStack;
      // Use a known app route instead of WebView/browser history. The latter
      // can contain full-document entries and reload the static Tauri page.
      router.replace(target);
    };
    window.addEventListener('moke:native-back', handleNativeBack);
    return () => window.removeEventListener('moke:native-back', handleNativeBack);
  }, [pathname, router]);

  return null;
}

declare global {
  interface WindowEventMap {
    'moke:native-back': Event;
  }
}
