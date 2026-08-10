'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, Check, Download } from 'lucide-react';
import { useServerStore } from '@/lib/store/server';
import { useLongPressRegistry } from '@/lib/long-press';
import { resolveServerAssetUrl } from '@/lib/utils';
import { AuthImage } from '@/components/ui/AuthImage';

export interface BookRow {
  id: string | number;
  title: string;
  authors?: Array<{ name: string }>;
  author?: string;
  publisher?: string;
  pubdate?: string;
  img?: string;
  thumb?: string;
  files?: Array<{ format: string; size?: number }>;
  timestamp?: number;
  state?: {
    wants?: boolean;
    download?: number;
  };
  /** Network-library book identity — lets rows link to `/network-book` instead of `/detail?id=`. */
  source_id?: number;
  book_url?: string;
}

interface BookTableProps {
  books: BookRow[];
  showStatus?: boolean;
  linkable?: boolean;
  batchMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
  /** Right-click / long-press: open the context menu at (x, y) for this book. */
  onContextAction?: (id: string, x: number, y: number) => void;
  /**
   * 当前列表是分页加载（每页只取部分数据，客户端排序只作用于当前页）时设为 true，
   * 会在排序生效时显示「仅当前页」提示，避免用户误以为排序作用于全量数据。
   */
  paged?: boolean;
  /** 排序变化回调：分页场景下父组件可用它把页码重置回第 1 页。 */
  onSortChange?: (sort: SortState | null) => void;
  /**
   * Per-row href override (e.g. network books link to `/network-book` instead of
   * `/detail?id=`). Falls back to `/detail?id=${id}` when omitted.
   */
  getRowHref?: (row: BookRow) => string;
}

type SortKey = 'title' | 'author' | 'publisher' | 'format' | 'size' | 'added' | 'wants' | 'download';
type SortDir = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

function formatSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  const fixed = v < 10 && u > 0 ? 1 : 0;
  return `${v.toFixed(fixed)} ${units[u]}`;
}

function formatDate(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function authorOf(row: BookRow): string {
  if (row.author) return row.author;
  if (row.authors && row.authors.length) return row.authors.map((a) => a.name).filter(Boolean).join(', ');
  return '';
}

function valueForSort(row: BookRow, key: SortKey): string | number {
  switch (key) {
    case 'title': return (row.title || '').toLowerCase();
    case 'author': return authorOf(row).toLowerCase();
    case 'publisher': return (row.publisher || '').toLowerCase();
    case 'format': return (row.files?.[0]?.format || '').toLowerCase();
    case 'size': return row.files?.[0]?.size ?? -1;
    case 'added': return row.timestamp ?? 0;
    case 'wants': return row.state?.wants ? 1 : 0;
    case 'download': return row.state?.download ? 1 : 0;
  }
}

function compareValues(a: string | number, b: string | number, dir: SortDir): number {
  let cmp: number;
  if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b;
  } else {
    const sa = String(a);
    const sb = String(b);
    cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
  }
  // Empty/unknown values always sink to the bottom regardless of direction.
  const aMissing = (typeof a === 'number' && a < 0) || a === '';
  const bMissing = (typeof b === 'number' && b < 0) || b === '';
  if (aMissing && !bMissing) return 1;
  if (!aMissing && bMissing) return -1;
  return dir === 'asc' ? cmp : -cmp;
}

function TinyCover({ title, src }: { title: string; src: string }) {
  const initial = (title || '?').charAt(0);
  const fallback = (
    <div className="w-6 h-9 rounded-sm bg-gradient-to-br from-slate-200 to-slate-300 shrink-0 flex items-center justify-center text-foreground/30 text-[10px] font-bold font-serif">
      {initial}
    </div>
  );
  if (!src) return fallback;
  return (
    <AuthImage
      src={src}
      alt={title}
      className="w-6 h-9 rounded-sm object-cover shrink-0"
      loading="lazy"
      fallback={fallback}
    />
  );
}

function MobileCover({ title, src }: { title: string; src: string }) {
  const fallback = (
    <div className="flex h-[72px] w-12 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-slate-200 to-slate-300 text-sm font-bold text-foreground/30">
      {(title || '?').charAt(0)}
    </div>
  );
  if (!src) return fallback;
  return (
    <AuthImage
      src={src}
      alt={title}
      className="h-[72px] w-12 shrink-0 rounded-md object-cover shadow-sm"
      loading="lazy"
      fallback={fallback}
    />
  );
}

interface SortHeaderProps {
  label: string;
  sortKey: SortKey;
  sort: SortState | null;
  onChange: (next: SortState | null) => void;
  className?: string;
  align?: 'left' | 'right' | 'center';
  title?: string;
}

function SortHeader({ label, sortKey, sort, onChange, className, align = 'left', title }: SortHeaderProps) {
  const isActive = sort?.key === sortKey;
  const icon = isActive
    ? (sort?.dir === 'asc' ? ArrowUp : ArrowDown)
    : ArrowUpDown;
  const Icon = icon;
  const alignClass = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  return (
    <th className={`px-4 py-2.5 font-medium ${className ?? ''}`}>
      <button
        type="button"
        title={title ?? label}
        onClick={() => {
          if (!isActive) {
            onChange({ key: sortKey, dir: 'asc' });
          } else if (sort?.dir === 'asc') {
            onChange({ key: sortKey, dir: 'desc' });
          } else {
            onChange(null);
          }
        }}
        className={`inline-flex items-center gap-1 ${alignClass} w-full select-none transition-colors hover:text-foreground ${
          isActive ? 'text-foreground' : 'text-muted-foreground/80'
        }`}
      >
        <span>{label}</span>
        <Icon className={`w-3 h-3 ${isActive ? 'opacity-100' : 'opacity-40'}`} />
      </button>
    </th>
  );
}

export function BookTable({
  books,
  showStatus = false,
  linkable = true,
  batchMode = false,
  selectedIds,
  onToggleSelect,
  onContextAction,
  paged = false,
  onSortChange,
  getRowHref,
}: BookTableProps) {
  const { serverUrl } = useServerStore();
  const [sort, setSort] = useState<SortState | null>(null);
  const { makeHandlers: makeLongPressHandlers } = useLongPressRegistry();
  const selectable = Boolean(batchMode && selectedIds && onToggleSelect);
  const contextual = Boolean(!batchMode && onContextAction);

  const applySort = (next: SortState | null) => {
    setSort(next);
    onSortChange?.(next);
  };

  const sorted = useMemo(() => {
    if (!sort) return books;
    const arr = [...books];
    arr.sort((a, b) => compareValues(valueForSort(a, sort.key), valueForSort(b, sort.key), sort.dir));
    return arr;
  }, [books, sort]);

  if (books.length === 0) return null;

  // Long-press / right-click handler factory
  function makeRowHandlers(id: string) {
    if (batchMode) {
      const toggle = (mods: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) =>
        onToggleSelect!(id, mods);
      return {
        onClick: (e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          toggle({ shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
        },
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          toggle({ shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
        },
      };
    }
    if (contextual) {
      return makeLongPressHandlers(id, onContextAction!);
    }
    return {};
  }

  return (
    <>
      {paged && sort && (
        <p className="mb-2 text-xs text-muted-foreground/80">
          排序仅作用于当前页，翻页后按新页内容重新排序。
        </p>
      )}
      <div className="overflow-hidden rounded-[22px] app-card md:hidden">
        {sorted.map((row) => {
          const id = String(row.id);
          const coverUrl = resolveServerAssetUrl(serverUrl, row.img || row.thumb);
          const author = authorOf(row);
          const fmt = row.files?.[0]?.format?.toUpperCase();
          const size = formatSize(row.files?.[0]?.size);
          const isSelected = selectedIds?.has(id) ?? false;
          const rowHref = getRowHref ? getRowHref(row) : `/detail?id=${id}`;
          const content = (
            <>
              {selectable && (
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-all ${isSelected ? 'bg-primary text-primary-foreground' : 'border-2 border-muted-foreground/30'}`}>
                  {isSelected && <Check className="h-3 w-3" />}
                </span>
              )}
              <MobileCover title={row.title} src={coverUrl} />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-sm font-semibold leading-5 text-foreground">{row.title || '—'}</span>
                {author && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{author}</span>}
                <span className="mt-2 flex flex-wrap items-center gap-1.5">
                  {fmt && <span className="rounded-md border border-border/40 bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">{fmt}</span>}
                  {size !== '—' && <span className="text-[10px] text-muted-foreground/80">{size}</span>}
                  {showStatus && row.state?.wants && <span className="text-[10px] font-medium text-primary">在书架</span>}
                  {showStatus && row.state?.download ? <span className="text-[10px] text-emerald-600">已下载</span> : null}
                </span>
              </span>
            </>
          );

          return (
            <div
              key={id}
              {...makeRowHandlers(id)}
              className={`border-b border-amber-950/5 last:border-b-0 ${isSelected ? 'bg-amber-100/70 ring-1 ring-inset ring-primary/40' : 'active:bg-amber-50/60'}`}
            >
              {linkable && !batchMode && rowHref ? (
                <Link href={rowHref} className="flex min-w-0 items-center gap-3 px-3 py-3.5">
                  {content}
                </Link>
              ) : (
                <div className="flex min-w-0 items-center gap-3 px-3 py-3.5">{content}</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="hidden overflow-hidden rounded-[24px] app-card md:block">
        <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse table-fixed min-w-[640px]">
          {/* colgroup must contain only <col> children — no whitespace or comments between, or HTML hydration errors. */}
          <colgroup><col className={`overflow-hidden transition-[width] duration-200 ease-out ${selectable ? 'w-[40px]' : 'w-0'}`} /><col /><col className="w-[180px]" /><col className="w-[160px]" /><col className="w-[72px]" /><col className="w-[84px]" /><col className="w-[108px]" />{showStatus && <col className="w-[64px]" />}{showStatus && <col className="w-[72px]" />}</colgroup>
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide border-b border-amber-950/10 bg-white/40">
              <th className={`overflow-hidden text-center text-primary transition-all duration-200 ease-out ${selectable ? 'w-[40px] px-3 py-2.5 opacity-100' : 'w-0 p-0 opacity-0'}`}>已选</th>
              <SortHeader label="标题" sortKey="title" sort={sort} onChange={applySort} />
              <SortHeader label="作者" sortKey="author" sort={sort} onChange={applySort} />
              <SortHeader label="出版商" sortKey="publisher" sort={sort} onChange={applySort} className="hidden md:table-cell" />
              <SortHeader label="格式" sortKey="format" sort={sort} onChange={applySort} className="hidden sm:table-cell" />
              <SortHeader label="大小" sortKey="size" sort={sort} onChange={applySort} className="hidden lg:table-cell" align="right" />
              <SortHeader label="添加" sortKey="added" sort={sort} onChange={applySort} className="hidden lg:table-cell" />
              {showStatus && (
                <SortHeader label="在架" sortKey="wants" sort={sort} onChange={applySort} className="hidden sm:table-cell" align="center" title="在架" />
              )}
              {showStatus && (
                <SortHeader label="下载" sortKey="download" sort={sort} onChange={applySort} className="hidden sm:table-cell" align="center" title="已下载" />
              )}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const id = String(row.id);
              const coverUrl = resolveServerAssetUrl(serverUrl, row.img || row.thumb);
              const author = authorOf(row);
              const fmt = row.files?.[0]?.format?.toUpperCase();
              const size = formatSize(row.files?.[0]?.size);
              const added = formatDate(row.timestamp);
              const inShelf = Boolean(row.state?.wants);
              const downloaded = Boolean(row.state?.download);
              const isSelected = selectedIds?.has(id) ?? false;
              const rowHref = getRowHref ? getRowHref(row) : `/detail?id=${id}`;
              return (
                <tr
                  key={id}
                  {...makeRowHandlers(id)}
                  className={`border-b border-amber-950/5 last:border-b-0 transition-colors cursor-${batchMode || contextual ? 'pointer' : 'default'} ${selectable && isSelected ? 'bg-amber-100/70 ring-1 ring-inset ring-primary/40' : batchMode ? 'hover:bg-amber-50/60' : 'hover:bg-amber-50/40'}`}
                >
                  <td className={`overflow-hidden align-middle text-center transition-all duration-200 ease-out ${selectable ? 'w-[40px] px-3 py-2 opacity-100' : 'w-0 p-0 opacity-0'}`}>
                    <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full transition-all duration-150 ${isSelected ? 'bg-primary text-primary-foreground scale-100' : 'border-2 border-muted-foreground/30 scale-90'}`}>
                      {isSelected && <span className="text-[10px] font-bold">✓</span>}
                    </span>
                  </td>
                  <td className="px-4 py-2 align-middle">
                    {linkable && !batchMode && rowHref ? (
                      <Link
                        href={rowHref}
                        className="flex items-center gap-3 min-w-0 group"
                      >
                        <TinyCover title={row.title} src={coverUrl} />
                        <span className="truncate text-foreground group-hover:text-primary transition-colors font-medium">
                          {row.title || '—'}
                        </span>
                      </Link>
                    ) : (
                      <div className="flex items-center gap-3 min-w-0">
                        <TinyCover title={row.title} src={coverUrl} />
                        <span className="truncate text-foreground font-medium">
                          {row.title || '—'}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 align-middle text-muted-foreground truncate">
                    {author || <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2 align-middle text-muted-foreground hidden md:table-cell truncate">
                    {row.publisher || <span className="text-muted-foreground/40">—</span>}
                  </td>
                  <td className="px-4 py-2 align-middle text-muted-foreground hidden sm:table-cell">
                    {fmt ? (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 bg-muted rounded border border-border/40">
                        {fmt}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 align-middle text-muted-foreground hidden lg:table-cell text-right tabular-nums">
                    {size}
                  </td>
                  <td className="px-4 py-2 align-middle text-muted-foreground hidden lg:table-cell tabular-nums">
                    {added}
                  </td>
                  {showStatus && (
                    <td className="px-4 py-2 align-middle text-center hidden sm:table-cell">
                      {inShelf ? (
                        <Bookmark className="w-3.5 h-3.5 text-primary inline" fill="currentColor" />
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                  )}
                  {showStatus && (
                    <td className="px-4 py-2 align-middle text-center hidden sm:table-cell">
                      {downloaded ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600 inline" />
                      ) : (
                        <Download className="w-3.5 h-3.5 text-muted-foreground/40 inline" />
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
    </>
  );
}
