'use client';

import { Grid3X3, List, Rows3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ViewMode } from '@/lib/store/view-prefs';

export type { ViewMode };

interface ViewModeToggleProps {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  className?: string;
  showRows?: boolean;
}

const BASE = 'flex items-center justify-center w-7 h-7 rounded-md transition-all eink:!bg-black eink:!text-white';
const ACTIVE = 'bg-background text-foreground shadow-sm';
const INACTIVE = 'text-muted-foreground hover:text-foreground';

export function ViewModeToggle({ value, onChange, className, showRows = true }: ViewModeToggleProps) {
  return (
    <div className={cn('flex items-center rounded-lg p-1 shrink-0 border border-amber-950/10 bg-white/65 eink-bordered shadow-sm', className)}>
      <button
        type="button"
        onClick={() => onChange('grid')}
        aria-label="网格视图"
        title="网格视图"
        className={cn(BASE, value === 'grid' ? ACTIVE : INACTIVE)}
      >
        <Grid3X3 className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        aria-label="列表视图"
        title="列表视图"
        className={cn(BASE, value === 'list' ? ACTIVE : INACTIVE)}
      >
        <List className="w-4 h-4" />
      </button>
      {showRows && (
        <button
          type="button"
          onClick={() => onChange('rows')}
          aria-label="纯列表（表格）视图"
          title="纯列表（表格）视图"
          className={cn(BASE, value === 'rows' ? ACTIVE : INACTIVE)}
        >
          <Rows3 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
