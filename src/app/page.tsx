'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useServerStore } from '@/lib/store/server';
import { navigateFullDocument } from '@/lib/moke-reader';

export default function HomePage() {
  const router = useRouter();
  const { serverUrl, hasHydrated } = useServerStore();

  useEffect(() => {
    if (!hasHydrated) return;
    const target = serverUrl ? '/shelf' : '/welcome';
    // On single-WebView runtimes (OHOS), App Router's RSC navigation over the
    // custom scheme can leave this page stuck on its blank loading spinner.
    // Use the native full-document navigation there; fall back to the router.
    // A timeout guard guarantees the spinner never persists even if the
    // native navigation hangs (e.g. IPC never settling in dev mode).
    navigateFullDocument(target, router.replace);
    const timer = window.setTimeout(() => {
      router.replace(target);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [hasHydrated, serverUrl, router]);

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
    </div>
  );
}
