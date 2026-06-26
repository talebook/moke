'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useServerStore } from '@/lib/store/server';

export default function HomePage() {
  const router = useRouter();
  const { serverUrl, hasHydrated } = useServerStore();

  useEffect(() => {
    if (!hasHydrated) return;
    if (!serverUrl) {
      router.replace('/welcome');
    } else {
      router.replace('/shelf');
    }
  }, [hasHydrated, serverUrl, router]);

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
    </div>
  );
}
