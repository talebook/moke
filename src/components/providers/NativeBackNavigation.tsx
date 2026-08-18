'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Receives Android BACK events forwarded by MainActivity on nested pages. */
export function NativeBackNavigation() {
  const router = useRouter();

  useEffect(() => {
    const handleNativeBack = () => router.back();
    window.addEventListener('moke:native-back', handleNativeBack);
    return () => window.removeEventListener('moke:native-back', handleNativeBack);
  }, [router]);

  return null;
}

declare global {
  interface WindowEventMap {
    'moke:native-back': Event;
  }
}
