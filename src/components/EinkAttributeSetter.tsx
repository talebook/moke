'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/lib/store/settings';

/**
 * Mirrors the e-ink toggle onto `<html data-eink="true">`, the same signal the
 * embedded readest reader uses so Moke + the reader share one convention.
 *
 * This lives in a client child component instead of the root layout because the
 * App Router requires `app/layout.tsx` (which renders the `<html>`/`<body>`
 * shell) to be a Server Component. Auto e-ink styling is applied via CSS media
 * queries regardless of this attribute.
 */
export function EinkAttributeSetter() {
  const eink = useSettingsStore((s) => s.eink);

  useEffect(() => {
    document.documentElement.setAttribute('data-eink', eink.toString());
  }, [eink]);

  return null;
}
