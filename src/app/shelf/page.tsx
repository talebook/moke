'use client';

import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import { useServerStore } from '@/lib/store/server';
import { useRouter } from 'next/navigation';
import { BookOpen, History, Search } from 'lucide-react';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { getErrorMessage, readApiJson, request } from '@/lib/api';
import { cn, resolveServerAssetUrl } from '@/lib/utils';
import { AuthImage } from '@/components/ui/AuthImage';
import { BookTable, type BookRow } from '@/components/book/BookTable';
import { ViewModeToggle } from '@/components/book/ViewModeToggle';
import { BatchActionBar, type BatchAction } from '@/components/book/BatchActionBar';
import { BookContextMenu, type ContextMenuItem } from '@/components/book/BookContextMenu';
import { useViewPrefsStore } from '@/lib/store/view-prefs';
import {
  beginOfflineDownload,
  downloadAndSaveOfflineBook,
  endOfflineDownload,
} from '@/lib/offline-download';
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
  state?: {
    wants?: boolean;
    download?: number;
  };
}

function BookCard({
  book,
  viewGrid = true,
  priority = false,
  batchMode = false,
  selected = false,
  onToggleSelect,
  onContextAction,
}: {
  book: BookItem;
  viewGrid?: boolean;
  priority?: boolean;
  batchMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string, mods: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => void;
  /** Right-click / long-press: open the context menu at (x, y) for this book. */
  onContextAction?: (id: string, x: number, y: number) => void;
}) {
  const { serverUrl } = useServerStore();
  const authorName = book.author || book.authors?.[0]?.name || '';
  const bookId = String(book.id);
  const coverUrl = resolveServerAssetUrl(serverUrl, book.img || book.thumb);
  const colors = [
    'from-emerald-800/20 via-teal-700/15 to-cyan-700/20',
    'from-amber-700/20 via-yellow-600/15 to-orange-700/20',
    'from-slate-700/20 via-gray-600/15 to-zinc-700/20',
    'from-rose-700/20 via-red-600/15 to-pink-700/20',
    'from-indigo-700/20 via-blue-600/15 to-purple-700/20',
  ];
  const ci = Math.abs(bookId.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % colors.length;

  // Build the interaction props based on mode.
  // - batchMode=true: any click (incl. right-click / long-press) toggles selection.
  // - batchMode=false & onContextAction: right-click + long-press open a context menu;
  //   left-click is left to the Link (navigation).
  function makeHandlers() {
    if (batchMode) {
      const toggle = (mods: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) =>
        onToggleSelect?.(bookId, mods);
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
    if (onContextAction) {
      let pressTimer: number | null = null;
      let didLongPress = false;
      let touchX = 0;
      let touchY = 0;
      return {
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          onContextAction(bookId, e.clientX, e.clientY);
        },
        onTouchStart: (e: React.TouchEvent) => {
          didLongPress = false;
          const t = e.touches[0];
          touchX = t?.clientX ?? 0;
          touchY = t?.clientY ?? 0;
          pressTimer = window.setTimeout(() => {
            didLongPress = true;
            if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(50);
            onContextAction(bookId, touchX, touchY);
          }, 500);
        },
        onTouchEnd: () => {
          if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        },
        onTouchMove: () => {
          if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
        },
        onClick: (e: React.MouseEvent) => {
          if (didLongPress) { e.preventDefault(); e.stopPropagation(); }
        },
      };
    }
    return {};
  }
  const handlers = makeHandlers();

  if (viewGrid) {
    return (
      <Link href={`/detail?id=${bookId}`}
        {...handlers}
        className={`book-card-motion group relative flex flex-col gap-3 cursor-pointer rounded-[22px] p-2.5 transition-all duration-300 hover:bg-white/65 hover:shadow-[0_18px_45px_-30px_rgba(74,57,35,0.65)] ${selected ? 'ring-2 ring-primary/60 bg-white/70' : batchMode ? 'cursor-pointer' : ''}`}
      >
        <div className="book-cover-motion relative w-full overflow-hidden rounded-[18px] bg-white book-cover-shadow ring-1 ring-black/5 transition-all duration-300 ease-out group-hover:-translate-y-1.5"
          style={{ aspectRatio: '2/3' }}>
          {coverUrl ? (
            <AuthImage
              src={coverUrl}
              alt={book.title}
              className="book-cover-media w-full h-full object-cover transition-transform duration-500 ease-out group-hover:scale-105"
              loading={priority ? 'eager' : 'lazy'}
              fetchPriority={priority ? 'high' : 'auto'}
              fallback={
                <div className={cn('book-cover-media w-full h-full flex items-center justify-center bg-gradient-to-br transition-transform duration-500 ease-out group-hover:scale-105', colors[ci])}>
                  <span className="text-white/75 text-lg font-bold font-serif px-3 text-center leading-tight drop-shadow-sm">
                    {book.title.length > 4 ? book.title.slice(0, 4) : book.title}
                  </span>
                </div>
              }
            />
          ) : (
            <div className={cn('book-cover-media w-full h-full flex items-center justify-center bg-gradient-to-br transition-transform duration-500 ease-out group-hover:scale-105', colors[ci])}>
              <span className="text-white/75 text-lg font-bold font-serif px-3 text-center leading-tight drop-shadow-sm">
                {book.title.length > 4 ? book.title.slice(0, 4) : book.title}
              </span>
            </div>
          )}
          <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-white/18 to-transparent opacity-80" />
          <div className="absolute inset-y-0 left-0 w-[10%] bg-gradient-to-r from-black/18 via-black/4 to-transparent mix-blend-multiply" />
          <div className="absolute inset-0 bg-black/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
          {/* Selection badge: always rendered, fades in/out + scales so the badge itself
              animates smoothly when batch mode toggles. It's absolute-positioned, so it
              doesn't push the title/author — the grid view layout is unaffected. */}
          <div className={`absolute top-2 right-2 z-10 w-5 h-5 rounded-full flex items-center justify-center shadow-sm transition-all duration-200 ease-out ${batchMode ? 'opacity-100' : 'opacity-0 scale-50 pointer-events-none'}`}>
            <span className={`flex items-center justify-center w-5 h-5 rounded-full transition-all duration-150 ${selected ? 'bg-primary text-primary-foreground scale-100' : 'bg-white/70 border-2 border-muted-foreground/30 scale-90'}`}>
              {selected && <span className="text-[10px] font-bold">✓</span>}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1 px-1">
          <span className="book-title-motion text-[13px] font-semibold leading-snug truncate text-foreground group-hover:text-primary transition-colors duration-200">{book.title}</span>
          {authorName && <span className="text-[11px] truncate text-muted-foreground/85">{authorName}</span>}
        </div>
      </Link>
    );
  }

  return (
      <Link href={`/detail?id=${bookId}`}
      {...handlers}
      className={`book-list-motion flex min-w-0 items-center gap-3 rounded-2xl border border-transparent px-2 py-3 transition-all duration-200 hover:bg-muted/70 hover:border-border/60 hover:shadow-xs group sm:gap-4 sm:px-3 sm:py-4 ${selected ? 'bg-white/70 ring-1 ring-primary/40' : batchMode ? 'cursor-pointer' : ''}`}>
      {/* Selection indicator wrapper: width animates 0 → 20px so the cover/title
          smoothly slides right when entering batch mode, instead of jumping. */}
      <div className={`overflow-hidden shrink-0 transition-[width,opacity] duration-200 ease-out ${batchMode ? 'w-5 opacity-100' : 'w-0 opacity-0'}`}>
        <div className={`w-5 h-5 rounded-full flex items-center justify-center transition-all duration-150 ${selected ? 'bg-primary text-primary-foreground scale-100' : 'border-2 border-muted-foreground/30 scale-90'}`}>
          {selected && <span className="text-[10px] font-bold">✓</span>}
        </div>
      </div>
      <div className="book-list-cover-motion h-[72px] w-12 rounded-lg overflow-hidden shadow-sm shrink-0 flex items-center justify-center relative transition-transform duration-300 group-hover:scale-[1.03] sm:h-[84px] sm:w-14">
        {coverUrl ? (
          <AuthImage
            src={coverUrl}
            alt={book.title}
            className="w-full h-full object-cover"
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : 'auto'}
            fallback={
              <div className={cn('w-full h-full flex items-center justify-center bg-gradient-to-br', colors[ci])}>
                <span className="text-white/70 text-xs font-bold font-serif px-1 text-center leading-tight">
                  {book.title.length > 2 ? book.title.slice(0, 2) : book.title}
                </span>
              </div>
            }
          />
        ) : (
          <div className={cn('w-full h-full flex items-center justify-center bg-gradient-to-br', colors[ci])}>
            <span className="text-white/70 text-xs font-bold font-serif px-1 text-center leading-tight">
              {book.title.length > 2 ? book.title.slice(0, 2) : book.title}
            </span>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="book-title-motion line-clamp-2 text-sm font-semibold leading-5 text-foreground group-hover:text-primary transition-colors duration-200">{book.title}</p>
        {authorName && <p className="text-xs text-muted-foreground truncate">{authorName}</p>}
      </div>
      <span className="text-[11px] font-semibold text-muted-foreground shrink-0 px-2 py-0.5 bg-muted rounded-md border border-border/30">
        {(book as any).files?.[0]?.format?.toUpperCase() || 'EPUB'}
      </span>
    </Link>
  );
}

export default function ShelfPage() {
  const { serverUrl } = useServerStore();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';
  const [books, setBooks] = useState<BookItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [shelfSearchQ, setShelfSearchQ] = useState('');
  const viewMode = useViewPrefsStore((s) => s.shelfViewMode);
  const setViewMode = useViewPrefsStore((s) => s.setShelfViewMode);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const lastSelectedIdRef = useRef<string | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; bookId: string } | null>(null);

  // Clear selection whenever the underlying book list changes (server change, reload, etc.)
  useEffect(() => {
    setSelectedIds(new Set());
    lastSelectedIdRef.current = null;
  }, [books.length, serverUrl]);

  useEffect(() => {
    loadBooks();
  }, [serverUrl]);

  const loadBooks = async () => {
    setLoading(true);
    setRequiresLogin(false);
    try {
      const res = await request(`${serverUrl}/api/shelf`, { credentials: 'include' });
      const data = await readApiJson<{ err?: string; msg?: string; books?: BookItem[] }>(res, '书架列表解析失败。', ['ok', 'user.need_login']);

      if (data.err === 'user.need_login') {
        setBooks([]);
        setRequiresLogin(true);
        return;
      }

      setBooks(data.books || []);
    } catch (error) {
      setBooks([]);
      toast(getErrorMessage(error, '书架加载失败，请检查服务器连接。'));
    } finally { setLoading(false); }
  };

  // ── Selection ────────────────────────────────────────────────────────────
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
      const orderedIds = books.map((b) => String(b.id));
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
    setSelectedIds(new Set(books.map((b) => String(b.id))));
  };

  const deselectAll = () => {
    setSelectedIds(new Set());
    lastSelectedIdRef.current = null;
  };

  // Deselecting everything should also exit batch mode (nothing to act on).
  useEffect(() => {
    if (!batchMode) return;
    if (selectedIds.size === 0) setBatchMode(false);
  }, [selectedIds, batchMode]);

  // ── Single-item actions (from right-click / long-press menu) ────────────
  const removeFromShelf = async (id: string) => {
    const book = books.find((b) => String(b.id) === id);
    if (!book) return;
    try {
      const res = await request(`${serverUrl}/api/book/${id}/shelf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ shelf: false }),
      });
      const data = await res.json();
      if (data.err === 'ok') {
        toast(`已移出《${book.title}》`);
        await loadBooks();
      } else {
        toast(data.msg || '移出失败');
      }
    } catch {
      toast('移出失败，请检查网络');
    }
  };

  const downloadOne = async (id: string) => {
    const book = books.find((b) => String(b.id) === id);
    if (!book) return;
    if (!beginOfflineDownload(serverUrl, id)) {
      toast(`《${book.title}》正在下载中`);
      return;
    }
    const format = (book.files?.[0]?.format || 'epub').toLowerCase();
    try {
      await downloadAndSaveOfflineBook({
        serverUrl,
        bookId: id,
        title: book.title,
        format,
      });
      toast(`《${book.title}》已下载`);
    } catch {
      toast('下载失败');
    } finally {
      endOfflineDownload(serverUrl, id);
    }
  };

  // ── Context menu items for a given book ─────────────────────────────────
  const buildMenuItems = (book: BookItem): ContextMenuItem[] => [
    {
      key: 'remove',
      label: '移出书架',
      icon: <Check className="w-3.5 h-3.5" />,
      onClick: () => removeFromShelf(String(book.id)),
    },
    ...(isTauriApp
      ? [{
          key: 'download',
          label: '下载',
          icon: <Download className="w-3.5 h-3.5" />,
          onClick: () => downloadOne(String(book.id)),
        }]
      : []),
    { key: 'sep-1', label: '', separator: true },
    {
      key: 'select-many',
      label: '选择多本',
      icon: <ListChecks className="w-3.5 h-3.5" />,
      onClick: () => enterBatchMode(String(book.id)),
    },
  ];

  const openContextMenu = (bookId: string, clientX: number, clientY: number) => {
    setContextMenu({ x: clientX, y: clientY, bookId });
  };

  // ── Batch actions ────────────────────────────────────────────────────────
  const runBatch = async (action: BatchAction): Promise<{ ok: number; fail: number }> => {
    if (selectedIds.size === 0) return { ok: 0, fail: 0 };
    const ids = Array.from(selectedIds);
    let ok = 0;
    let fail = 0;

    if (action === 'remove-shelf') {
      const results = await Promise.allSettled(
        ids.map((id) => request(`${serverUrl}/api/book/${id}/shelf`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ shelf: false }),
        }).then((r) => r.json())),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value?.err === 'ok') ok++;
        else fail++;
      }
      // Refresh shelf list to reflect the removals
      await loadBooks();
      exitBatchMode();
      if (ok > 0) toast(`已移出 ${ok} 本`);
      if (fail > 0) toast(`${fail} 本移出失败`);
    } else if (action === 'download') {
      let skipped = 0;
      for (const id of ids) {
        const book = books.find((b) => String(b.id) === id);
        if (!book) { fail++; continue; }
        if (!beginOfflineDownload(serverUrl, id)) { skipped++; continue; }
        const format = (book.files?.[0]?.format || 'epub').toLowerCase();
        try {
          await downloadAndSaveOfflineBook({
            serverUrl,
            bookId: id,
            title: book.title,
            format,
          });
          ok++;
        } catch { fail++; }
        finally { endOfflineDownload(serverUrl, id); }
      }
      exitBatchMode();
      if (ok > 0) toast(`已下载 ${ok} 本`);
      if (fail > 0) toast(`${fail} 本下载失败`);
      if (skipped > 0) toast(`${skipped} 本正在下载中，已跳过`);
    }
    return { ok, fail };
  };

  const submitShelfSearch = () => {
    const query = shelfSearchQ.trim();
    if (!query) return;
    router.push(`/search?q=${encodeURIComponent(query)}`);
  };

  return (
    <DesktopLayout>
      <div className="moke-shelf-bg flex min-h-screen flex-col bg-[radial-gradient(circle_at_top_left,rgba(184,149,106,0.18),transparent_32%),linear-gradient(180deg,#fffdf8_0%,#fbf9f2_44%,#f6f0e6_100%)]">
        <header className="sticky top-0 z-10 shrink-0 border-b border-amber-950/10 bg-[#fffdf8]/80 px-4 py-4 backdrop-blur-xl sm:px-6 md:px-8 md:py-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
            <div>
              <div className="mb-1 flex items-center gap-2 text-xs font-medium text-primary/80">
                <BookOpen className="h-3.5 w-3.5" />
                <span>{books.length > 0 ? `${books.length} 本藏书` : '私人阅读空间'}</span>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">我的书架</h1>
            </div>
            <div className="flex w-full flex-col gap-3 md:w-auto md:flex-row md:items-center">
              <div className="flex min-w-0 flex-1 items-center gap-2 md:w-[390px] md:flex-none">
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <input
                    type="search"
                    placeholder="搜索书籍"
                    value={shelfSearchQ}
                    onChange={(e) => setShelfSearchQ(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitShelfSearch(); }}
                    className="w-full h-10 pl-10 pr-3 text-sm rounded-2xl border border-amber-950/10 bg-white/70 text-foreground shadow-sm outline-none transition focus:border-primary/60 focus:bg-white focus:shadow-[0_8px_24px_-18px_rgba(74,57,35,0.55)]"
                  />
                </div>
                <button
                  type="button"
                  onClick={submitShelfSearch}
                  disabled={!shelfSearchQ.trim()}
                  className="h-10 shrink-0 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                >
                    搜索
                </button>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Link
                  href="/user/history"
                  aria-label="查看历史记录"
                  title="查看历史记录"
                  className="shrink-0 flex items-center justify-center w-10 h-10 rounded-2xl border border-amber-950/10 bg-white/70 eink-bordered text-muted-foreground eink:text-black shadow-sm transition hover:text-foreground hover:bg-white hover:shadow-[0_8px_24px_-18px_rgba(74,57,35,0.55)]"
                >
                  <History className="w-4 h-4" />
                </Link>
                <ViewModeToggle value={viewMode} onChange={setViewMode} />
              </div>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto no-scrollbar">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
            </div>
          ) : books.length === 0 ? (
            <div className="flex min-h-[420px] items-center justify-center px-4 py-16 text-center sm:px-8 md:min-h-[520px] md:py-24">
              <div className="relative w-full max-w-md overflow-hidden rounded-[28px] border border-amber-950/10 bg-white/65 eink-bordered px-5 py-10 shadow-[0_24px_70px_-45px_rgba(74,57,35,0.65)] backdrop-blur sm:rounded-[32px] sm:px-8 sm:py-12">
                <div className="absolute -right-16 -top-16 h-40 w-40 rounded-full bg-primary/10 blur-2xl" />
                <div className="relative mx-auto mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-primary/15 to-amber-200/40 text-primary shadow-inner eink:!bg-white eink:!shadow-[inset_0_0_0_1px_#000]">
                  <Search className="w-10 h-10 eink:!text-black" />
                </div>
                <p className="relative text-lg font-semibold mb-2 text-foreground">{requiresLogin ? '登录后查看你的书架' : '书架还是空的'}</p>
                <p className="relative text-sm leading-6 max-w-xs mx-auto text-muted-foreground">
                  {requiresLogin ? '当前服务器已连接，但书架状态属于个人数据，请先登录后查看书架。' : '去书库挑几本书，开始你的阅读之旅。'}
                </p>
              </div>
            </div>
          ) : (
            <div className="px-4 py-5 sm:px-6 md:px-8 md:py-8">
              {viewMode === 'rows' ? (
                <BookTable
                  books={books as BookRow[]}
                  showStatus
                  batchMode={batchMode}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  onContextAction={openContextMenu}
                />
              ) : (
                <div className={cn('rounded-[24px] border border-amber-950/10 bg-white/35 eink-bordered p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)] backdrop-blur-sm sm:rounded-[30px] sm:p-4', viewMode === 'grid' ? 'grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-7 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' : 'grid grid-cols-1 gap-1 lg:grid-cols-2 lg:gap-4')}>
                  {books.map((book, index) => (
                    <BookCard
                      key={String(book.id)}
                      book={book}
                      priority={index === 0}
                      viewGrid={viewMode === 'grid'}
                      batchMode={batchMode}
                      selected={selectedIds.has(String(book.id))}
                      onToggleSelect={batchMode ? toggleSelect : undefined}
                      onContextAction={batchMode ? undefined : openContextMenu}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <BatchActionBar
        batchMode={batchMode}
        selectedCount={selectedIds.size}
        totalCount={books.length}
        canAddShelf={false}
        canRemoveShelf
        canDownload={isTauriApp}
        onAction={runBatch}
        onClear={deselectAll}
        onSelectAll={selectAll}
        onExitBatchMode={exitBatchMode}
      />
      {contextMenu && (() => {
        const book = books.find((b) => String(b.id) === contextMenu.bookId);
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

