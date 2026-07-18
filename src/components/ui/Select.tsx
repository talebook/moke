'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Shown as the trigger label when `value` doesn't match any option (e.g. empty). */
  placeholder?: string;
  /** Show a spinner + label instead of the trigger (use for "loading…" affordance). */
  loading?: boolean;
  loadingText?: string;
  /** Disabled state. */
  disabled?: boolean;
  /** Classes applied to the trigger. */
  className?: string;
  /** Minimum width for the dropdown panel (defaults to 130 so labels like "请选择书源" fit). */
  minPanelWidth?: number;
  /** Optional id for the trigger (for aria-labelledby patterns). */
  id?: string;
  /** aria-label for the trigger. */
  'aria-label'?: string;
}

/**
 * Custom Select styled to match the right-click context menu
 * (border-amber-950/10, white/95, soft shadow, amber-50/60 hover).
 * Anchored to the trigger; flips up if there's no room below.
 * Closes on Esc / outside click / scroll / option select.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  loading,
  loadingText = '加载中...',
  disabled,
  className,
  minPanelWidth,
  id,
  ...rest
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Close on scroll (any ancestor; native <select> behaves similarly)
  useEffect(() => {
    if (!open) return;
    const onScroll = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open]);

  // Position the panel after open so we can measure trigger + viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.max(rect.width, minPanelWidth ?? 130);
    let left = rect.left;
    // Keep panel within viewport horizontally
    const pad = 8;
    if (left + width > window.innerWidth - pad) {
      left = Math.max(pad, window.innerWidth - pad - width);
    }
    setPos({ left, top: rect.bottom + 6, width });
  }, [open, minPanelWidth]);

  // Flip up if no room below
  useLayoutEffect(() => {
    if (!open || !pos || !panelRef.current) return;
    const rect = panelRef.current.getBoundingClientRect();
    const pad = 8;
    if (rect.bottom > window.innerHeight - pad) {
      const trigger = triggerRef.current;
      if (trigger) {
        const tr = trigger.getBoundingClientRect();
        const flipped = tr.top - rect.height - 6;
        if (flipped >= pad) {
          setPos({ ...pos, top: flipped });
        }
      }
    }
  }, [open, pos]);

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? '';
  const showPlaceholder = !selected;

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={rest['aria-label']}
        disabled={disabled || loading}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center justify-between gap-2 text-sm pl-3 pr-2.5 py-1.5 rounded-2xl border border-amber-950/10 bg-white/70 text-foreground shadow-sm outline-none transition-colors',
          'hover:border-amber-950/20 hover:bg-white',
          'focus:border-primary/60 focus:bg-white',
          (disabled || loading) && 'opacity-60 cursor-not-allowed',
          !disabled && !loading && 'cursor-pointer',
          className,
        )}
      >
        {loading ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{loadingText}</span>
          </span>
        ) : (
          <>
            <span className={cn('truncate', showPlaceholder && 'text-muted-foreground')}>{label}</span>
            <ChevronDown
              className={cn(
                'w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
                open && 'rotate-180',
              )}
            />
          </>
        )}
      </button>

      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          className="fixed z-50 max-h-[60vh] overflow-y-auto rounded-xl border border-amber-950/10 bg-white/95 backdrop-blur shadow-[0_18px_45px_-20px_rgba(74,57,35,0.55)] no-scrollbar"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {options.length === 0 ? (
            <div className="px-3 py-2.5 text-sm text-muted-foreground">无选项</div>
          ) : options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors',
                  'text-foreground hover:bg-amber-50/70',
                  isSelected && 'bg-amber-50/40',
                )}
              >
                <span className="flex-1 whitespace-nowrap">{opt.label}</span>
                {isSelected && <Check className="w-3.5 h-3.5 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
