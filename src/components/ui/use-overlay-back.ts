'use client';

import { useEffect, useRef } from 'react';
import { APP_BACK_EVENT } from '@/lib/native-back';
import { OverlayBackStack } from '@/lib/overlay-back';

const stack = new OverlayBackStack();
const events = [
  APP_BACK_EVENT,
  'moke:predictive-back-start',
  'moke:predictive-back-progress',
  'moke:predictive-back-cancel',
];

/** Consume the whole gesture so an open overlay never previews its parent page. */
export function useOverlayBack(open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const entry = stack.register(() => close.current());
    const consume = (event: Event) => {
      if (entry.isTop()) stack.consume(event, event.type === APP_BACK_EVENT);
    };
    for (const name of events) window.addEventListener(name, consume, true);
    return () => {
      entry.remove();
      for (const name of events) window.removeEventListener(name, consume, true);
    };
  }, [open]);
}
