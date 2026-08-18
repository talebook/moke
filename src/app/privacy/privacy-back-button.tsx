'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function PrivacyBackButton() {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={() => router.back()}
      className="inline-flex h-10 items-center gap-2 rounded-2xl border border-amber-950/10 bg-white/60 px-4 text-sm text-foreground"
    >
      <ArrowLeft className="h-4 w-4" />
      返回
    </button>
  );
}
