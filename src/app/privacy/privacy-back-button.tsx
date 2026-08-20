'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ShieldX } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  hasAcceptedCurrentPrivacyPolicy,
  revokeCurrentPrivacyPolicy,
} from '@/lib/privacy-consent';

export function PrivacyBackButton() {
  const router = useRouter();
  const [canRevoke, setCanRevoke] = useState(false);

  useEffect(() => {
    setCanRevoke(hasAcceptedCurrentPrivacyPolicy());
  }, []);

  const handleRevoke = () => {
    revokeCurrentPrivacyPolicy();
    router.replace('/welcome');
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <button
        type="button"
        onClick={() => router.back()}
        className="inline-flex h-11 items-center gap-2 rounded-2xl border border-amber-950/10 bg-white/60 px-4 text-sm text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        返回
      </button>
      {canRevoke && (
        <button
          type="button"
          onClick={handleRevoke}
          className="inline-flex min-h-11 items-center gap-2 rounded-2xl px-4 text-sm text-muted-foreground transition hover:bg-destructive/5 hover:text-destructive"
        >
          <ShieldX className="h-4 w-4" />
          撤回同意
        </button>
      )}
    </div>
  );
}
