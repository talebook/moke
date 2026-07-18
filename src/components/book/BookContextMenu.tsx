'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  /** Required for non-separator items. Separator items have no action. */
  onClick?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

interface BookContextMenuProps {
  /** Client coordinates (event.clientX / event.clientY, or the element's rect). */
  position: { x: number; y: number };
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Floating context menu shown on right-click / long-press of a book card.
 * - Renders into document.body via a portal so it isn't clipped by parent overflow.
 * - Adjusts position so it stays in the viewport (flips left/up when near edges).
 * - Closes on backdrop click, scroll, or Escape.
 */
export function BookContextMenu({ position, items, onClose }: BookContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Close on any scroll (the menu would otherwise float away from the card)
  useEffect(() => {
    const onScroll = () => onClose();
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [onClose]);

  // Clamp position into viewport after first paint so we can measure the menu size.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    let dx = 0;
    let dy = 0;
    if (rect.right > window.innerWidth - pad) {
      dx = window.innerWidth - pad - rect.right;
    }
    if (rect.bottom > window.innerHeight - pad) {
      // Flip above the trigger point if it would overflow below
      const flippedTop = position.y - rect.height - 8;
      if (flippedTop >= pad) {
        el.style.top = `${flippedTop}px`;
        dy = 0;
      } else {
        dy = window.innerHeight - pad - rect.bottom;
      }
    }
    if (rect.left < pad) dx = pad - rect.left;
    if (rect.top < pad) dy = pad - rect.top;
    if (dx !== 0 || dy !== 0) {
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  }, [position.x, position.y]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        ref={ref}
        role="menu"
        className="fixed z-50 min-w-[200px] rounded-xl border border-amber-950/10 bg-white/95 backdrop-blur shadow-[0_18px_45px_-20px_rgba(74,57,35,0.55)] overflow-hidden"
        style={{ left: position.x, top: position.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item, idx) => {
          if (item.separator) {
            return <div key={`sep-${idx}`} className="h-px bg-border/60 my-1" />;
          }
          return (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled || !item.onClick) return;
                onClose();
                item.onClick();
              }}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors',
                item.destructive
                  ? 'text-red-600 hover:bg-red-50'
                  : 'text-foreground hover:bg-amber-50/60',
                'disabled:opacity-50 disabled:hover:bg-transparent',
              )}
            >
              {item.icon && <span className="shrink-0 w-4 h-4 flex items-center justify-center">{item.icon}</span>}
              <span className="flex-1">{item.label}</span>
            </button>
          );
        })}
      </div>
    </>,
    document.body,
  );
}
