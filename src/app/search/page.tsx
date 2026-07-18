'use client';

import { Suspense, useState, useEffect, useRef } from 'react';
import { useServerStore } from '@/lib/store/server';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { request } from '@/lib/api';
import { cn, resolveServerAssetUrl } from '@/lib/utils';
import { AuthImage } from '@/components/ui/AuthImage';
import { BookTable, type BookRow } from '@/components/book/BookTable';
import { ViewModeToggle, type ViewMode } from '@/components/book/ViewModeToggle';
import { BatchActionBar, type BatchAction } from '@/components/book/BatchActionBar';
import { BookContextMenu, type ContextMenuItem } from '@/components/book/BookContextMenu';
import { useViewPrefsStore } from '@/lib/store/view-prefs';
import { downloadBookBlob } from '@/lib/api';
import { saveOfflineBook } from '@/lib/offline-books';
import { useToast } from '@/lib/toast';
import { Check, Download, ListChecks } from 'lucide-react';

interface BookItem {
  id: string | number;
  title: string;
  authors?: Array<{ name: string }>;
  author?: string;
  img?: string;
  thumb?: string;
  publisher?: string;
  pubdate?: string;
  files?: Array<{ format: string; size?: number }>;
  timestamp?: number;
}

function SearchContent() {
  const searchParams = useSearchParams();
  const { serverUrl } = useServerStore();
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [results, setResults] = useState<BookItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [activeFilter, setActiveFilter] = useState('全部');
  const viewMode = useViewPrefsStore((s) => s.searchViewMode);
  const setViewMode = useViewPrefsStore((s) => s.setSearchViewMode);
  const toast = useToast((s) => s.show);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; bookId: string } | null>(null);
  const lastSelectedIdRef = useRef<string | null>(null);

  // Clear selection when results change
  useEffect(() => {
    setSelectedIds(new Set());
    setBatchMode(false);
    setContextMenu(null);
    lastSelectedIdRef.current = null;
  }, [results, query]);

  useEffect(() => {
    const q = searchParams.get('q');
    if (q) {
      setQuery(q);
      handleSearch(q);
    }
  }, [searchParams]);

  const handleSearch = async (q?: string) => {
    const term = (q || query).trim();
    if (!term) return;
    setLoading(true);
    setSearched(true);
    try {
      const res = await request(`${serverUrl}/api/search?name=${encodeURIComponent(term)}`, { credentials: 'include' });
      const data = await res.json();
      if (data.err === 'ok') setResults(data.books || data.items || []);
    } finally { setLoading(false); }
  };

  // ── Selection ─────────────────────────────────────────────────────────────
  const enterBatchMode = (firstId?: string) => {
    setBatchMode(true);
    if (firstId) {
      setSelectedIds(new Set([firstId]));
      lastSelectedIdRef.current = firstId;
    }
  };

  const exitBatchMode = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
    lastSelectedIdRef.current = null;
  };

  const toggleSelect = (id: string, mods: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (!batchMode) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const orderedIds = results.map((b) => String(b.id));
      const anchor = lastSelectedIdRef.current;
      if (mods.shiftKey && anchor && orderedIds.includes(anchor)) {
        const a = orderedIds.indexOf(anchor);
        const b = orderedIds.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const shouldSelect = !prev.has(id);
          for (let i = lo; i <= hi; i++) next.add(orderedIds[i]);
          if (!shouldSelect) for (let i = lo; i <= hi; i++) next.delete(orderedIds[i]);
        }
      } else {
        if (next.has(id)) next.delete(id);
        else next.add(id);
        lastSelectedIdRef.current = id;
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(results.map((b) => String(b.id))));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
    lastSelectedIdRef.current = null;
  };

  // ── Single-item actions (from right-click / long-press menu) ────────────
  const addToShelf = async (id: string) => {
    const book = results.find((b) => String(b.id) === id);
    if (!book) return;
    try {
      const res = await request(`${serverUrl}/api/book/${id}/shelf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ shelf: true }),
      });
      const data = await res.json();
      if (data.err === 'ok') toast(`《${book.title}》已加入书架`);
      else toast(data.msg || '加入失败');
    } catch {
      toast('加入失败，请检查网络');
    }
  };

  const downloadOne = async (id: string) => {
    const book = results.find((b) => String(b.id) === id);
    if (!book) return;
    const format = (book.files?.[0]?.format || 'epub').toLowerCase();
    try {
      const blob = await downloadBookBlob(id, format);
      await saveOfflineBook({
        serverUrl,
        bookId: id,
        title: book.title,
        fileName: `${book.title}.${format}`,
        mimeType: blob.type || 'application/octet-stream',
        blob,
      });
      toast(`《${book.title}》已下载`);
    } catch {
      toast('下载失败');
    }
  };

  const buildMenuItems = (book: BookItem): ContextMenuItem[] => {
    const inShelf = Boolean((book as any).state?.wants);
    return [
      {
        key: inShelf ? 'remove' : 'add',
        label: inShelf ? '移出书架' : '加入书架',
        icon: <Check className="w-3.5 h-3.5" />,
        onClick: () => addToShelf(String(book.id)),
      },
      {
        key: 'download',
        label: '下载',
        icon: <Download className="w-3.5 h-3.5" />,
        onClick: () => downloadOne(String(book.id)),
      },
      { key: 'sep-1', label: '', separator: true },
      {
        key: 'select-many',
        label: '选择多本',
        icon: <ListChecks className="w-3.5 h-3.5" />,
        onClick: () => enterBatchMode(String(book.id)),
      },
    ];
  };

  const openContextMenu = (bookId: string, x: number, y: number) => {
    setContextMenu({ x, y, bookId });
  };

  useEffect(() => {
    if (!batchMode) return;
    if (selectedIds.size === 0) setBatchMode(false);
  }, [selectedIds, batchMode]);

  // ── Batch actions ─────────────────────────────────────────────────────────
  const runBatch = async (action: BatchAction): Promise<{ ok: number; fail: number }> => {
    if (selectedIds.size === 0) return { ok: 0, fail: 0 };
    const ids = Array.from(selectedIds);
    let ok = 0;
    let fail = 0;

    if (action === 'add-shelf') {
      const results = await Promise.allSettled(
        ids.map((id) => request(`${serverUrl}/api/book/${id}/shelf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ shelf: true }),
        }).then((r) => r.json())),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value?.err === 'ok') ok++;
        else fail++;
      }
      exitBatchMode();
      if (ok > 0) toast(`已加入 ${ok} 本到书架`);
      if (fail > 0) toast(`${fail} 本加入失败`);
    } else if (action === 'download') {
      for (const id of ids) {
        const book = results.find((b) => String(b.id) === id);
        if (!book) { fail++; continue; }
        const format = (book.files?.[0]?.format || 'epub').toLowerCase();
        try {
          const blob = await downloadBookBlob(id, format);
          await saveOfflineBook({
            serverUrl,
            bookId: id,
            title: book.title,
            fileName: `${book.title}.${format}`,
            mimeType: blob.type || 'application/octet-stream',
            blob,
          });
          ok++;
        } catch { fail++; }
      }
      exitBatchMode();
      if (ok > 0) toast(`已下载 ${ok} 本`);
      if (fail > 0) toast(`${fail} 本下载失败`);
    }
    return { ok, fail };
  };

  return (
    <DesktopLayout>
      <div className="px-8 py-8 h-full overflow-y-auto" style={{ maxWidth: '1400px' }}>
        <div className="mb-6">
          <p className="text-xs font-medium text-primary/80">探索书库</p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">搜索</h1>
        </div>
        <div className="flex items-center gap-3 mb-8 rounded-[28px] app-card p-3">
          <div className="relative flex-1 max-w-xl">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
            <input type="text" placeholder="搜索书名、作者、标签..."
              value={query} onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
              className="w-full h-12 pl-11 pr-4 rounded-2xl bg-white/70 border border-amber-950/10 shadow-sm text-foreground text-base outline-none transition-colors focus:border-primary focus:bg-background" />
          </div>
          <button onClick={() => handleSearch()} disabled={loading || !query.trim()}
            className="h-11 px-6 rounded-2xl bg-primary shadow-lg shadow-primary/15 text-primary-foreground text-sm font-semibold transition hover:opacity-90 disabled:opacity-50">
            {loading ? '搜索中...' : '搜索'}
          </button>
        </div>

        <div className="flex items-center gap-3 mb-6 justify-between rounded-3xl app-card px-4 py-3">
          <div className="flex gap-3">
            {['全部', 'EPUB', 'PDF', 'MOBI', 'TXT'].map((f) => (
              <button key={f} onClick={() => setActiveFilter(f)}
                className={`text-xs px-3 py-1.5 rounded-2xl border transition-colors ${activeFilter === f ? 'border-foreground text-foreground bg-muted' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                {f}
              </button>
            ))}
          </div>
          
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
          </div>
        ) : searched && results.length === 0 ? (
          <div className="rounded-[32px] app-glass px-8 py-16 text-center text-muted-foreground">
            <p className="text-lg font-semibold text-foreground">未找到相关书籍</p>
            <p className="text-sm mt-2">尝试使用不同的关键词搜索</p>
          </div>
        ) : results.length > 0 ? (
          <div>
            <p className="text-sm text-muted-foreground mb-5">找到 {results.length} 本书</p>
            {viewMode === 'rows' ? (
              <BookTable
                books={results as BookRow[]}
                batchMode={batchMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onContextAction={openContextMenu}
              />
            ) : (
              <div className={cn('rounded-[30px] app-card p-4 gap-x-4 gap-y-7', viewMode === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' : 'grid grid-cols-1 lg:grid-cols-2 gap-4')}>
                {results.map((book) => {
                  const bookId = String(book.id);
                  const coverUrl = resolveServerAssetUrl(serverUrl, book.img || book.thumb);
                  const authorName = book.author || book.authors?.[0]?.name || '';
                  const selected = selectedIds.has(bookId);
                  const pressTimerRef = { current: null as number | null };
                  const didLongPressRef = { current: false };
                  let touchX = 0;
                  let touchY = 0;
                  const cardHandlers = batchMode
                    ? {
                        onClick: (e: React.MouseEvent) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleSelect(bookId, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
                        },
                        onContextMenu: (e: React.MouseEvent) => {
                          e.preventDefault();
                          toggleSelect(bookId, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
                        },
                      }
                    : {
                        onContextMenu: (e: React.MouseEvent) => {
                          e.preventDefault();
                          openContextMenu(bookId, e.clientX, e.clientY);
                        },
                        onTouchStart: (e: React.TouchEvent) => {
                          didLongPressRef.current = false;
                          const t = e.touches[0];
                          touchX = t?.clientX ?? 0;
                          touchY = t?.clientY ?? 0;
                          pressTimerRef.current = window.setTimeout(() => {
                            didLongPressRef.current = true;
                            if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(50);
                            openContextMenu(bookId, touchX, touchY);
                          }, 500);
                        },
                        onTouchEnd: () => {
                          if (pressTimerRef.current) { clearTimeout(pressTimerRef.current); pressTimerRef.current = null; }
                        },
                        onTouchMove: () => {
                          if (pressTimerRef.current) { clearTimeout(pressTimerRef.current); pressTimerRef.current = null; }
                        },
                        onClick: (e: React.MouseEvent) => {
                          if (didLongPressRef.current) { e.preventDefault(); e.stopPropagation(); }
                        },
                      };

                  if (viewMode === 'grid') {
                  return (
                    <Link key={bookId} href={`/detail?id=${bookId}`} {...cardHandlers} className={`book-card-motion group relative flex flex-col gap-3 rounded-[22px] p-2.5 transition-all duration-300 hover:bg-white/65 hover:shadow-[0_18px_45px_-30px_rgba(74,57,35,0.65)] ${selected ? 'ring-2 ring-primary/60 bg-white/70' : batchMode ? 'cursor-pointer' : ''}`}>
                      <div className="book-cover-motion relative w-full overflow-hidden rounded-[18px] bg-white book-cover-shadow ring-1 ring-black/5 transition-all duration-300 ease-out group-hover:-translate-y-1.5"
                        style={{ aspectRatio: '2/3' }}>
                        {coverUrl ? (
                          <AuthImage
                            src={coverUrl}
                            alt={book.title}
                            className="book-cover-media w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                            loading="lazy"
                            fallback={
                              <div className="book-cover-media w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                                <span className="text-foreground/25 text-xl font-bold font-serif">{book.title[0]}</span>
                              </div>
                            }
                          />
                        ) : (
                          <div className="book-cover-media w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                            <span className="text-foreground/25 text-xl font-bold font-serif">{book.title[0]}</span>
                          </div>
                        )}
                        <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-white/18 to-transparent opacity-80" />
                        <div className="absolute inset-y-0 left-0 w-[10%] bg-gradient-to-r from-black/18 via-black/4 to-transparent mix-blend-multiply" />
                        <div className={`absolute top-2 right-2 z-10 w-5 h-5 rounded-full flex items-center justify-center shadow-sm transition-all duration-200 ease-out ${batchMode ? 'opacity-100' : 'opacity-0 scale-50 pointer-events-none'}`}>
                          <span className={`flex items-center justify-center w-5 h-5 rounded-full transition-all duration-150 ${selected ? 'bg-primary text-primary-foreground scale-100' : 'bg-white/70 border-2 border-muted-foreground/30 scale-90'}`}>
                            {selected && <span className="text-[10px] font-bold">✓</span>}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-col gap-0.5 px-0.5">
                        <span className="book-title-motion text-sm font-medium truncate text-foreground">{book.title}</span>
                        {authorName && <span className="text-xs truncate text-muted-foreground">{authorName}</span>}
                      </div>
                    </Link>
                  );
                }

                return (
                  <Link key={bookId} href={`/detail?id=${bookId}`} {...cardHandlers}
                    className={`book-list-motion group flex items-center gap-4 pl-1 pr-4 py-4 rounded-2xl transition-all hover:bg-white/70 border border-transparent hover:border-amber-950/10 hover:shadow-sm ${selected ? 'bg-white/70 ring-1 ring-primary/40' : batchMode ? 'cursor-pointer' : ''}`}>
                    <div className={`overflow-hidden shrink-0 transition-[width,opacity] duration-200 ease-out ${batchMode ? 'w-5 opacity-100' : 'w-0 opacity-0'}`}>
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center transition-all duration-150 ${selected ? 'bg-primary text-primary-foreground scale-100' : 'border-2 border-muted-foreground/30 scale-90'}`}>
                        {selected && <span className="text-[10px] font-bold">✓</span>}
                      </div>
                    </div>
                    <div className="book-list-cover-motion w-14 h-[84px] rounded overflow-hidden shadow-card shrink-0 flex items-center justify-center relative">
                      {coverUrl ? (
                        <AuthImage
                          src={coverUrl}
                          alt={book.title}
                          className="w-full h-full object-cover"
                          loading="lazy"
                          fallback={
                            <div className="w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                              <span className="text-foreground/30 text-xs font-bold font-serif">{book.title[0]}</span>
                            </div>
                          }
                        />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center">
                          <span className="text-foreground/30 text-xs font-bold font-serif">{book.title[0]}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="book-title-motion text-sm font-medium truncate text-foreground">{book.title}</p>
                      {authorName && <p className="text-xs text-muted-foreground truncate">{authorName}</p>}
                    </div>
                  </Link>
                );
              })}
              </div>
            )}
          </div>
        ) : null}
      </div>
      <BatchActionBar
        batchMode={batchMode}
        selectedCount={selectedIds.size}
        totalCount={results.length}
        canAddShelf
        canRemoveShelf={false}
        canDownload
        onAction={runBatch}
        onClear={deselectAll}
        onSelectAll={selectAll}
        onExitBatchMode={exitBatchMode}
      />
      {contextMenu && (() => {
        const book = results.find((b) => String(b.id) === contextMenu.bookId);
        if (!book) return null;
        return (
          <BookContextMenu
            position={{ x: contextMenu.x, y: contextMenu.y }}
            items={buildMenuItems(book)}
            onClose={() => setContextMenu(null)}
          />
        );
      })()}
    </DesktopLayout>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={
      <DesktopLayout>
        <div className="px-8 py-16 flex items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
        </div>
      </DesktopLayout>
    }>
      <SearchContent />
    </Suspense>
  );
}
