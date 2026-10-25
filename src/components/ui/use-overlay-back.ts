'use client';

import { useLayoutEffect, useRef } from 'react';
import { APP_BACK_EVENT } from '@/lib/native-back';
import { overlayBackStack } from '@/lib/overlay-back';

/** Give the top open overlay ownership of native BACK instead of the route. */
export function useOverlayBack(open: boolean, onClose: () => void) {
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    if (!open) return;
    const entry = overlayBackStack.register(() => close.current());
    const consume = (event: Event) => {
      if (entry.isTop()) overlayBackStack.consume(event);
    };
    window.addEventListener(APP_BACK_EVENT, consume, true);
    return () => {
      entry.remove();
      window.removeEventListener(APP_BACK_EVENT, consume, true);
    };
  }, [open]);
}
