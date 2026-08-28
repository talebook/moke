import { cn } from '@/lib/utils';

const COVER_COLORS = [
  'bg-gradient-to-br from-slate-200 to-slate-300',
  'bg-gradient-to-br from-stone-200 to-stone-300',
  'bg-gradient-to-br from-zinc-200 to-zinc-300',
  'bg-gradient-to-br from-gray-200 to-gray-300',
  'bg-gradient-to-br from-neutral-200 to-neutral-300',
];

export function BookCoverFallback({
  title,
  seed,
  className,
  textClassName,
}: {
  title: string;
  seed: string | number;
  className?: string;
  textClassName?: string;
}) {
  const value = String(seed);
  const colorIndex = Math.abs(value.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0)) % COVER_COLORS.length;
  return (
    <div className={cn('flex h-full w-full items-center justify-center', COVER_COLORS[colorIndex], className)}>
      <span className={cn('font-serif font-bold text-foreground/25', textClassName)}>
        {(title || '?').charAt(0)}
      </span>
    </div>
  );
}
