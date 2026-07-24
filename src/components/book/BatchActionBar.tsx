'use client';

import { useEffect, useState } from 'react';
import { Check, Download, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type BatchAction = 'add-shelf' | 'remove-shelf' | 'download';

interface BatchActionBarProps {
  /** When true, the bar always shows (with 全选 + 退出), regardless of selection. */
  batchMode: boolean;
  selectedCount: number;
  totalCount?: number;
  canAddShelf?: boolean;
  canRemoveShelf?: boolean;
  canDownload?: boolean;
  onAction: (action: BatchAction) => Promise<{ ok: number; fail: number }>;
  onClear: () => void;
  onSelectAll: () => void;
  onExitBatchMode: () => void;
}

export function BatchActionBar({
  batchMode,
  selectedCount,
  totalCount = 0,
  canAddShelf = true,
  canRemoveShelf = true,
  canDownload = true,
  onAction,
  onClear,
  onSelectAll,
  onExitBatchMode,
}: BatchActionBarProps) {
  const [running, setRunning] = useState<BatchAction | null>(null);
  const [result, setResult] = useState<{ ok: number; fail: number; action: BatchAction } | null>(null);

  // Esc to exit batch mode when active
  useEffect(() => {
    if (!batchMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExitBatchMode();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [batchMode, onExitBatchMode]);

  if (!batchMode) return null;

  const handle = async (action: BatchAction) => {
    if (selectedCount === 0) return;
    setRunning(action);
    setResult(null);
    try {
      const r = await onAction(action);
      setResult({ ...r, action });
    } finally {
      setRunning(null);
    }
  };

  const isRunning = running !== null;
  const allSelected = totalCount > 0 && selectedCount === totalCount;

  return (
    <div className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))] left-1/2 z-40 max-w-[calc(100vw-1rem)] -translate-x-1/2 overflow-x-auto md:bottom-4 md:max-w-[calc(100vw-2rem)]">
      <div className="flex w-max items-center gap-2 rounded-2xl border border-amber-950/10 bg-white/95 backdrop-blur px-3 py-2 shadow-[0_18px_45px_-20px_rgba(74,57,35,0.5)]">
        <button
          type="button"
          onClick={onExitBatchMode}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="退出选区模式 (Esc)"
        >
          <X className="w-3.5 h-3.5" />
          <span>退出</span>
        </button>
        <div className="h-5 w-px bg-border" />
        <button
          type="button"
          onClick={onSelectAll}
          disabled={isRunning}
          className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
        >
          <Check className="w-3.5 h-3.5" />
          <span>{allSelected ? '取消全选' : '全选'}</span>
        </button>
        <span className="text-sm font-medium text-foreground px-2">
          已选 <span className="text-primary">{selectedCount}</span> 本
        </span>
        <div className="h-5 w-px bg-border" />
        {canAddShelf && (
          <BatchButton
            icon={Check}
            label="加入书架"
            tone="primary"
            onClick={() => handle('add-shelf')}
            disabled={isRunning || selectedCount === 0}
            isCurrent={running === 'add-shelf'}
          />
        )}
        {canRemoveShelf && (
          <BatchButton
            icon={Check}
            label="移出书架"
            tone="ghost"
            onClick={() => handle('remove-shelf')}
            disabled={isRunning || selectedCount === 0}
            isCurrent={running === 'remove-shelf'}
          />
        )}
        {canDownload && (
          <BatchButton
            icon={Download}
            label="下载"
            tone="ghost"
            onClick={() => handle('download')}
            disabled={isRunning || selectedCount === 0}
            isCurrent={running === 'download'}
          />
        )}
        <div className="h-5 w-px bg-border" />
        <button
          type="button"
          onClick={onClear}
          disabled={isRunning}
          aria-label="清空选择"
          title="清空选择"
          className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {result && (
        <div className="mt-2 mx-auto w-fit max-w-full rounded-xl border border-amber-950/10 bg-white/95 backdrop-blur px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
          {result.fail > 0
            ? <span>完成 {result.ok}，失败 {result.fail}</span>
            : <span className="text-emerald-600">全部 {result.ok} 本完成 ✓</span>}
        </div>
      )}
    </div>
  );
}

interface BatchButtonProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tone: 'primary' | 'ghost';
  onClick: () => void;
  disabled?: boolean;
  isCurrent?: boolean;
}

function BatchButton({ icon: Icon, label, tone, onClick, disabled, isCurrent }: BatchButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center gap-1.5 h-7 px-3 rounded-md text-xs font-medium transition-colors disabled:opacity-50',
        tone === 'primary'
          ? 'bg-primary text-primary-foreground hover:opacity-90'
          : 'text-foreground hover:bg-muted',
        isCurrent && 'opacity-90',
      )}
    >
      {isCurrent ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      <span>{label}</span>
    </button>
  );
}
