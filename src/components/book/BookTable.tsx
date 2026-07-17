'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, Check, Download } from 'lucide-react';
import { useServerStore } from '@/lib/store/server';
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
}

interface BookTableProps {
  books: BookRow[];
  showStatus?: boolean;
  linkable?: boolean;
}

type SortKey = 'title' | 'author' | 'publisher' | 'format' | 'size' | 'added' | 'wants' | 'download';
type SortDir = 'asc' | 'desc';

interface SortState {
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

export function BookTable({ books, showStatus = false, linkable = true }: BookTableProps) {
  const { serverUrl } = useServerStore();
  const [sort, setSort] = useState<SortState | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return books;
    const arr = [...books];
    arr.sort((a, b) => compareValues(valueForSort(a, sort.key), valueForSort(b, sort.key), sort.dir));
    return arr;
  }, [books, sort]);

  if (books.length === 0) return null;

  return (
    <div className="rounded-[24px] app-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse table-fixed min-w-[640px]">
          {/* colgroup must contain only <col> children — no whitespace or comments between, or HTML hydration errors. */}
          <colgroup><col /><col className="w-[180px]" /><col className="w-[160px]" /><col className="w-[72px]" /><col className="w-[84px]" /><col className="w-[108px]" />{showStatus && <col className="w-[64px]" />}{showStatus && <col className="w-[72px]" />}</colgroup>
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide border-b border-amber-950/10 bg-white/40">
              <SortHeader label="标题" sortKey="title" sort={sort} onChange={setSort} />
              <SortHeader label="作者" sortKey="author" sort={sort} onChange={setSort} />
              <SortHeader label="出版商" sortKey="publisher" sort={sort} onChange={setSort} className="hidden md:table-cell" />
              <SortHeader label="格式" sortKey="format" sort={sort} onChange={setSort} className="hidden sm:table-cell" />
              <SortHeader label="大小" sortKey="size" sort={sort} onChange={setSort} className="hidden lg:table-cell" align="right" />
              <SortHeader label="添加" sortKey="added" sort={sort} onChange={setSort} className="hidden lg:table-cell" />
              {showStatus && (
                <SortHeader label="在架" sortKey="wants" sort={sort} onChange={setSort} className="hidden sm:table-cell" align="center" title="在架" />
              )}
              {showStatus && (
                <SortHeader label="下载" sortKey="download" sort={sort} onChange={setSort} className="hidden sm:table-cell" align="center" title="已下载" />
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
              return (
                <tr
                  key={id}
                  className="border-b border-amber-950/5 last:border-b-0 hover:bg-amber-50/40 transition-colors"
                >
                  <td className="px-4 py-2 align-middle">
                    {linkable ? (
                      <Link
                        href={`/detail?id=${id}`}
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
  );
}
