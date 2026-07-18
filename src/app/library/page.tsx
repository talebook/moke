'use client';

import Link from 'next/link';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ArrowLeft, Loader2 } from 'lucide-react';
import { useServerStore } from '@/lib/store/server';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { request } from '@/lib/api';
import { cn, resolveServerAssetUrl } from '@/lib/utils';
import { AuthImage } from '@/components/ui/AuthImage';
import { BookTable, type BookRow } from '@/components/book/BookTable';
import { ViewModeToggle, type ViewMode } from '@/components/book/ViewModeToggle';
import { BatchActionBar, type BatchAction } from '@/components/book/BatchActionBar';
import { BookContextMenu, type ContextMenuItem } from '@/components/book/BookContextMenu';
import { Select } from '@/components/ui/Select';
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

interface NavTag {
  name: string;
  count: number;
}

interface NavGroup {
  legend: string;
  tags?: NavTag[];
}

interface NetworkSource {
  id: number;
  name: string;
  group?: string;
}

interface NetworkCategory {
  name: string;
  url: string;
}

interface NetworkBook {
  title?: string;
  name?: string;
  author?: string;
  authors?: string | Array<{ name: string }>;
  book_url: string;
  cover_url?: string;
  img?: string;
  thumb?: string;
}

const colors = [
  'bg-gradient-to-br from-slate-200 to-slate-300',
  'bg-gradient-to-br from-stone-200 to-stone-300',
  'bg-gradient-to-br from-zinc-200 to-zinc-300',
  'bg-gradient-to-br from-gray-200 to-gray-300',
  'bg-gradient-to-br from-neutral-200 to-neutral-300',
];

function getColorIndex(str: unknown) {
  const s = String(str ?? '');
  return Math.abs(s.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % colors.length;
}

export default function LibraryPage() {
  const { serverUrl } = useServerStore();
  const router = useRouter();

  // Shared
  const [activeTab, setActiveTab] = useState<'local' | 'online'>('local');
  const viewMode = useViewPrefsStore((s) => s.libraryViewMode);
  const setViewMode = useViewPrefsStore((s) => s.setLibraryViewMode);
  const [searchQ, setSearchQ] = useState('');
  const toast = useToast((s) => s.show);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; bookId: string } | null>(null);
  const lastSelectedIdRef = useRef<string | null>(null);

  // Clear selection when tab switches or server changes
  useEffect(() => {
    setSelectedIds(new Set());
    setBatchMode(false);
    setContextMenu(null);
    lastSelectedIdRef.current = null;
  }, [activeTab, serverUrl]);

  // Local tab state
  const [books, setBooks] = useState<BookItem[]>([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [selectedFormat, setSelectedFormat] = useState('全部');
  const [selectedTag, setSelectedTag] = useState('全部');
  const [tagOptions, setTagOptions] = useState<string[]>(['全部']);
  const [currentPage, setCurrentPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 30;

  // Online tab state
  const [networkSources, setNetworkSources] = useState<NetworkSource[]>([]);
  const [networkSourcesLoading, setNetworkSourcesLoading] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<number | null>(null);
  const [categories, setCategories] = useState<NetworkCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [selectedCategoryUrl, setSelectedCategoryUrl] = useState<string | null>(null);
  const [networkBooks, setNetworkBooks] = useState<NetworkBook[]>([]);
  const [networkBooksLoading, setNetworkBooksLoading] = useState(false);
  const [networkPage, setNetworkPage] = useState(1);
  const [networkSearchQ, setNetworkSearchQ] = useState('');
  const [networkSearchMode, setNetworkSearchMode] = useState(false);
  const [networkSearchResults, setNetworkSearchResults] = useState<NetworkBook[]>([]);
  const [networkSearchLoading, setNetworkSearchLoading] = useState(false);

  // ── Local tab effects ────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab === 'local') loadBooks(currentPage);
  }, [serverUrl, activeTab, currentPage, selectedFormat, selectedTag]);

  useEffect(() => {
    if (!serverUrl) return;
    loadTags();
  }, [serverUrl]);

  const loadBooks = async (page: number) => {
    setLocalLoading(true);
    try {
      const params = new URLSearchParams({
        start: String((page - 1) * pageSize),
        size: String(pageSize),
      });
      if (selectedTag !== '全部') params.set('tag', selectedTag);
      if (selectedFormat !== '全部') params.set('format', selectedFormat.toLowerCase());
      const res = await request(`${serverUrl}/api/library?${params.toString()}`, { credentials: 'include' });
      const data = await res.json();
      if (data.err === 'user.need_login') { router.push('/login'); return; }
      setBooks(data.books || data.items || []);
      setTotal(data.total || 0);
    } catch {} finally { setLocalLoading(false); }
  };

  const loadTags = async () => {
    try {
      const res = await request(`${serverUrl}/api/book/nav`, { credentials: 'include' });
      const data = await res.json();
      if (data.err === 'user.need_login') { router.push('/login'); return; }
      const groups = Array.isArray(data.navs) ? (data.navs as NavGroup[]) : [];
      const tags = groups.flatMap((g) => g.tags ?? []).map((t) => t.name).filter(Boolean);
      setTagOptions(['全部', ...Array.from(new Set(tags))]);
    } catch {
      setTagOptions(['全部']);
    }
  };

  // ── Online tab effects ───────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab === 'online' && networkSources.length === 0) loadNetworkSources();
  }, [activeTab, serverUrl]);

  useEffect(() => {
    if (selectedSourceId !== null) {
      setSelectedCategoryUrl(null);
      setCategories([]);
      setNetworkBooks([]);
      loadCategories(selectedSourceId);
    }
  }, [selectedSourceId]);

  useEffect(() => {
    if (selectedCategoryUrl && selectedSourceId !== null) {
      setNetworkBooks([]);
      loadNetworkBooks(selectedCategoryUrl, networkPage);
    }
  }, [selectedCategoryUrl, networkPage]);

  const loadNetworkSources = async () => {
    setNetworkSourcesLoading(true);
    try {
      const res = await request(`${serverUrl}/api/network/sources`, { credentials: 'include' });
      const data = await res.json();
      if (data.err !== 'ok') return;
      setNetworkSources(data.items || []);
    } catch {} finally { setNetworkSourcesLoading(false); }
  };

  const loadCategories = async (sourceId: number) => {
    setCategoriesLoading(true);
    try {
      const res = await request(`${serverUrl}/api/network/categories?source_id=${sourceId}`, { credentials: 'include' });
      const data = await res.json();
      if (data.err !== 'ok') return;
      setCategories(data.items || []);
    } catch {} finally { setCategoriesLoading(false); }
  };

  const loadNetworkBooks = async (categoryUrl: string, page: number) => {
    if (!selectedSourceId) return;
    setNetworkBooksLoading(true);
    try {
      const params = new URLSearchParams({ source_id: String(selectedSourceId), url: categoryUrl, page: String(page) });
      const res = await request(`${serverUrl}/api/network/explore?${params.toString()}`, { credentials: 'include' });
      const data = await res.json();
      if (data.err !== 'ok') return;
      setNetworkBooks(data.books || []);
    } catch {} finally { setNetworkBooksLoading(false); }
  };

  // ── Network search ───────────────────────────────────────────────────────────
  const doNetworkSearch = useCallback(async (q: string) => {
    if (!q.trim() || !serverUrl) return;
    setNetworkSearchMode(true);
    setNetworkSearchLoading(true);
    setNetworkSearchResults([]);
    try {
      const params = new URLSearchParams({ key: q.trim() });
      const initRes = await request(`${serverUrl}/api/network/search?${params.toString()}`, { credentials: 'include' });
      const initData = await initRes.json();
      if (initData.err !== 'ok') return;
      const taskId = initData.task_id;
      // Poll until finished
      let done = false;
      let attempts = 0;
      while (!done && attempts < 60) {
        await new Promise((r) => setTimeout(r, 1000));
        attempts++;
        const pollRes = await request(`${serverUrl}/api/network/search/status?task_id=${taskId}`, { credentials: 'include' });
        const pollData = await pollRes.json();
        if (pollData.err !== 'ok') break;
        const partial: NetworkBook[] = (pollData.results || []).flatMap((r: { books?: NetworkBook[]; items?: NetworkBook[] } | NetworkBook) => {
          if (Array.isArray(r)) return r;
          if (typeof r === 'object' && r !== null) {
            const asResult = r as { books?: NetworkBook[]; items?: NetworkBook[] };
            return asResult.books || asResult.items || [];
          }
          return [];
        });
        setNetworkSearchResults(partial);
        if (pollData.finished) done = true;
      }
    } catch {} finally { setNetworkSearchLoading(false); }
  }, [serverUrl]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    if (activeTab === 'local') {
      if (searchQ.trim()) router.push(`/search?q=${encodeURIComponent(searchQ.trim())}`);
    } else {
      doNetworkSearch(networkSearchQ);
    }
  };

  // ── Selection (local tab only — online books have no stable ids) ───────────
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

  // ── Single-item actions (from right-click / long-press menu) ────────────
  const addToShelf = async (id: string) => {
    const book = books.find((b) => String(b.id) === id);
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
      if (data.err === 'ok') toast(`《${book.title}》已移出书架`);
      else toast(data.msg || '移出失败');
    } catch {
      toast('移出失败，请检查网络');
    }
  };

  const downloadOne = async (id: string) => {
    const book = books.find((b) => String(b.id) === id);
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
        onClick: () => (inShelf ? removeFromShelf(String(book.id)) : addToShelf(String(book.id))),
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

  // Empty selection while in batch mode → leave batch mode.
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
        const book = books.find((b) => String(b.id) === id);
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

  // ── Pagination helpers ───────────────────────────────────────────────────────
  const totalPages = Math.ceil(total / pageSize);

  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else if (currentPage <= 4) {
      pages.push(1, 2, 3, 4, 5, '...', totalPages);
    } else if (currentPage >= totalPages - 3) {
      pages.push(1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
    } else {
      pages.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages);
    }
    return pages;
  };

  const updateFilter = (type: 'format' | 'tag', value: string) => {
    setCurrentPage(1);
    if (type === 'format') setSelectedFormat(value);
    if (type === 'tag') setSelectedTag(value);
  };

  // ── Render helpers ───────────────────────────────────────────────────────────
  const activeSearchQ = activeTab === 'local' ? searchQ : networkSearchQ;
  const setActiveSearchQ = activeTab === 'local'
    ? setSearchQ
    : (v: string) => { setNetworkSearchQ(v); if (!v.trim()) setNetworkSearchMode(false); };

  const searchPlaceholder = activeTab === 'local' ? '搜索书名、作者或标签...' : '搜索在线书籍...';

  return (
    <DesktopLayout>
      {/* ── Header ── */}
      <header className="sticky top-0 z-10 flex items-center gap-4 px-8 py-5 border-b border-amber-950/10 bg-[#fffdf8]/80 backdrop-blur-xl shrink-0">
        <div className="shrink-0">
          {activeTab === 'local' ? (
            <>
              <p className="text-xs font-medium text-primary/80">共 {total} 本藏书</p>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">全部藏书</h1>
            </>
          ) : (
            <>
              <p className="text-xs font-medium text-primary/80">在线书库</p>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">在线书库</h1>
            </>
          )}
        </div>
        <div className="flex-1" />

        {/* Search — switches mode per tab */}
        <div className="relative shrink-0 w-[320px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            placeholder={searchPlaceholder}
            value={activeSearchQ}
            onChange={(e) => setActiveSearchQ(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            className="w-full h-10 pl-10 pr-3 text-sm rounded-2xl border border-amber-950/10 bg-white/70 text-foreground shadow-sm outline-none transition focus:border-primary/60 focus:bg-white"
          />
        </div>

        <ViewModeToggle value={viewMode} onChange={setViewMode} className="ml-1" />
      </header>

      {/* ── Tabs ── */}
      <div className="px-8 border-b border-amber-950/10 bg-white/35 shrink-0 relative backdrop-blur-sm">
        <div className="flex items-center gap-8 relative">
          <button
            onClick={() => setActiveTab('local')}
            className={cn('py-3 text-sm transition-colors duration-200', activeTab === 'local' ? 'text-foreground font-medium' : 'text-muted-foreground')}
          >本地</button>
          <button
            onClick={() => setActiveTab('online')}
            className={cn('py-3 text-sm transition-colors duration-200', activeTab === 'online' ? 'text-foreground font-medium' : 'text-muted-foreground')}
          >在线</button>
          <div
            className="absolute bottom-0 h-[2px] rounded-full bg-foreground transition-all duration-300 ease-out"
            style={{ left: activeTab === 'local' ? '0' : '52px', width: '28px' }}
          />
        </div>
      </div>

      {/* ══════════════════════════════════════════
          LOCAL TAB
      ══════════════════════════════════════════ */}
      {activeTab === 'local' ? (
        <>
          <div className="px-8 py-4 border-b border-amber-950/10 bg-white/25 shrink-0">
            <div className="flex items-center gap-6 rounded-3xl app-card px-4 py-3">
              <FilterSelect label="格式" value={selectedFormat} options={['全部', 'EPUB', 'PDF', 'MOBI', 'TXT', 'AZW3']} onChange={(v) => updateFilter('format', v)} />
              <FilterSelect label="标签" value={selectedTag} options={tagOptions} onChange={(v) => updateFilter('tag', v)} />
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-auto px-8 py-8">
            {localLoading ? (
              <div className="flex items-center justify-center h-64">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
              </div>
            ) : books.length === 0 ? (
              <div className="rounded-[32px] app-glass px-8 py-16 text-center">
                <p className="text-lg font-semibold text-foreground">没有找到匹配的书籍</p>
                <p className="mt-2 text-sm text-muted-foreground">可以调整格式或分类筛选条件后再试。</p>
              </div>
            ) : viewMode === 'rows' ? (
              <BookTable
                books={books as BookRow[]}
                batchMode={batchMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onContextAction={openContextMenu}
              />
            ) : (
              <div className={cn('rounded-[30px] app-card p-4 gap-x-4 gap-y-7', viewMode === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' : 'grid grid-cols-1 lg:grid-cols-2 gap-4')}>
                {books.map((book) => {
                  const authorName = book.author || book.authors?.[0]?.name || '';
                  const bookId = String(book.id);
                  const coverUrl = resolveServerAssetUrl(serverUrl, book.img || book.thumb);
                  const ci = getColorIndex(bookId);
                  const selected = selectedIds.has(bookId);
                  // Build interaction handlers: batch mode toggles selection; otherwise
                  // right-click / long-press opens the context menu.
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
                  return viewMode === 'grid' ? (
                    <Link key={bookId} href={`/detail?id=${bookId}`} {...cardHandlers} className={`group relative flex flex-col gap-3 rounded-[22px] p-2.5 transition-all duration-300 hover:bg-white/65 hover:shadow-[0_18px_45px_-30px_rgba(74,57,35,0.65)] ${selected ? 'ring-2 ring-primary/60 bg-white/70' : batchMode ? 'cursor-pointer' : ''}`}>
                      <div className="relative w-full overflow-hidden rounded-[18px] bg-white book-cover-shadow ring-1 ring-black/5 transition-all duration-300 ease-out group-hover:-translate-y-1.5" style={{ aspectRatio: '2/3' }}>
                        {coverUrl ? (
                          <AuthImage
                            src={coverUrl}
                            alt={book.title}
                            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                            loading="lazy"
                            fallback={
                              <div className={cn('w-full h-full flex items-center justify-center', colors[ci])}>
                                <span className="text-foreground/20 text-2xl font-bold font-serif">{book.title[0]}</span>
                              </div>
                            }
                          />
                        ) : (
                          <div className={cn('w-full h-full flex items-center justify-center', colors[ci])}>
                            <span className="text-foreground/20 text-2xl font-bold font-serif">{book.title[0]}</span>
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
                        <span className="text-sm font-medium truncate text-foreground">{book.title}</span>
                        {authorName && <span className="text-xs truncate text-muted-foreground">{authorName}</span>}
                      </div>
                    </Link>
                  ) : (
                    <Link key={bookId} href={`/detail?id=${bookId}`} {...cardHandlers} className={`group flex items-center gap-4 pl-1 pr-4 py-4 rounded-2xl transition-all hover:bg-white/70 border border-transparent hover:border-amber-950/10 hover:shadow-sm ${selected ? 'bg-white/70 ring-1 ring-primary/40' : batchMode ? 'cursor-pointer' : ''}`}>
                      <div className={`overflow-hidden shrink-0 transition-[width,opacity] duration-200 ease-out ${batchMode ? 'w-5 opacity-100' : 'w-0 opacity-0'}`}>
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center transition-all duration-150 ${selected ? 'bg-primary text-primary-foreground scale-100' : 'border-2 border-muted-foreground/30 scale-90'}`}>
                          {selected && <span className="text-[10px] font-bold">✓</span>}
                        </div>
                      </div>
                      <div className="w-14 h-[84px] rounded overflow-hidden shadow-card shrink-0 flex items-center justify-center relative">
                        {coverUrl ? (
                          <AuthImage
                            src={coverUrl}
                            alt={book.title}
                            className="w-full h-full object-cover"
                            loading="lazy"
                            fallback={
                              <div className={cn('w-full h-full flex items-center justify-center', colors[ci])}>
                                <span className="text-foreground/30 text-xs font-bold font-serif">{book.title[0]}</span>
                              </div>
                            }
                          />
                        ) : (
                          <div className={cn('w-full h-full flex items-center justify-center', colors[ci])}>
                            <span className="text-foreground/30 text-xs font-bold font-serif">{book.title[0]}</span>
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate text-foreground">{book.title}</p>
                        {authorName && <p className="text-xs text-muted-foreground truncate">{authorName}</p>}
                      </div>
                      <span className="text-[11px] text-muted-foreground shrink-0">{book.files?.[0]?.format?.toUpperCase() || 'EPUB'}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1.5 py-5 border-t border-amber-950/10 bg-white/35 shrink-0 px-8 backdrop-blur-sm">
              <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}
                className="flex items-center justify-center h-8 px-3 text-sm rounded-sm transition-colors text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent">上一页</button>
              {getPageNumbers().map((label, i) => (
                <button key={i} onClick={() => typeof label === 'number' && setCurrentPage(label)} disabled={label === '...'}
                  className={cn('flex items-center justify-center w-8 h-8 text-sm rounded-sm transition-colors',
                    label === currentPage ? 'bg-foreground text-primary-foreground font-medium' : 'text-muted-foreground hover:bg-muted',
                    label === '...' && 'hover:bg-transparent cursor-default'
                  )}>{label}</button>
              ))}
              <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages}
                className="flex items-center justify-center h-8 px-3 text-sm rounded-sm transition-colors text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent">下一页</button>
            </div>
          )}
        </>
      ) : (
        /* ══════════════════════════════════════════
            ONLINE TAB
        ══════════════════════════════════════════ */
        <div className="flex-1 min-h-0 overflow-auto flex flex-col">

          {/* ── Filter bar (书源 + 分类，与本地书库样式一致) ── */}
          {!networkSearchMode && (
            <div className="px-8 py-4 border-b border-amber-950/10 bg-white/25 shrink-0">
              <div className="flex items-center gap-6 rounded-3xl app-card px-4 py-3">
                {/* 书源选择 */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs shrink-0 text-muted-foreground">书源</span>
                  <Select
                    value={selectedSourceId === null ? '' : String(selectedSourceId)}
                    onChange={(v) => {
                      setSelectedSourceId(v === '' ? null : Number(v));
                      setNetworkPage(1);
                    }}
                    options={[
                      { value: '', label: '请选择书源' },
                      ...networkSources.map((s) => ({ value: String(s.id), label: s.name })),
                    ]}
                    loading={networkSourcesLoading}
                  />
                </div>

                {/* 分类选择，仅在选择书源后出现 */}
                {selectedSourceId !== null && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs shrink-0 text-muted-foreground">分类</span>
                    <Select
                      value={selectedCategoryUrl ?? ''}
                      onChange={(v) => {
                        setSelectedCategoryUrl(v === '' ? null : v);
                        setNetworkPage(1);
                      }}
                      options={[
                        { value: '', label: '请选择分类' },
                        ...categories.map((c) => ({ value: c.url, label: c.name })),
                      ]}
                      loading={categoriesLoading}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Network search results ── */}
          {networkSearchMode ? (
            <div className="flex-1 min-h-0 overflow-auto px-8 py-8">
              <div className="flex items-center gap-3 mb-6">
                <button
                  onClick={() => { setNetworkSearchMode(false); setNetworkSearchQ(''); setNetworkSearchResults([]); }}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  返回浏览
                </button>
                <span className="text-sm text-muted-foreground">·</span>
                <span className="text-sm font-medium text-foreground">搜索"{networkSearchQ}"</span>
                {networkSearchLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
              </div>

              {networkSearchLoading && networkSearchResults.length === 0 ? (
                <div className="flex items-center justify-center h-64">
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
                </div>
              ) : networkSearchResults.length === 0 ? (
                <div className="rounded-[32px] app-glass px-8 py-16 text-center">
                  <p className="text-lg font-semibold text-foreground">没有找到相关书籍</p>
                  <p className="mt-2 text-sm text-muted-foreground">换个关键词试试。</p>
                </div>
              ) : viewMode === 'rows' ? (
                <NetworkBookTable books={networkSearchResults} />
              ) : (
                <NetworkBookGrid books={networkSearchResults} viewMode={viewMode} />
              )}
            </div>
          ) : (
            /* ── Browse books / empty states ── */
            <div className="flex-1 min-h-0 overflow-auto flex flex-col">
              <div className="flex-1 min-h-0 overflow-auto px-8 py-8">
                {/* 未选书源 */}
                {selectedSourceId === null ? (
                  <div className="rounded-[32px] app-glass px-8 py-16 text-center">
                    <p className="text-lg font-semibold text-foreground">请先选择一个书源</p>
                    <p className="mt-2 text-sm text-muted-foreground">在上方筛选栏选择书源，即可浏览该书源的书籍分类。</p>
                  </div>
                ) : /* 已选书源但未选分类 */
                selectedCategoryUrl === null ? (
                  <div className="rounded-[32px] app-glass px-8 py-16 text-center">
                    <p className="text-lg font-semibold text-foreground">请选择一个分类</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      已选择书源「{networkSources.find(s => s.id === selectedSourceId)?.name}」，请在上方继续选择分类。
                    </p>
                  </div>
                ) : /* 加载中 */
                networkBooksLoading ? (
                  <div className="flex items-center justify-center h-64">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
                  </div>
                ) : /* 该分类下无书籍 */
                networkBooks.length === 0 ? (
                  <div className="rounded-[32px] app-glass px-8 py-16 text-center">
                    <p className="text-lg font-semibold text-foreground">该分类暂无书籍</p>
                    <p className="mt-2 text-sm text-muted-foreground">换个分类试试，或稍后再来看看。</p>
                  </div>
                ) : viewMode === 'rows' ? (
                  <NetworkBookTable books={networkBooks} />
                ) : (
                  <NetworkBookGrid books={networkBooks} viewMode={viewMode} />
                )}
              </div>

              {/* 分页，仅在有书籍时显示 */}
              {selectedCategoryUrl !== null && !networkBooksLoading && networkBooks.length > 0 && (
                <div className="flex items-center justify-center gap-3 py-5 border-t border-amber-950/10 bg-white/35 shrink-0 px-8 backdrop-blur-sm">
                  <button
                    onClick={() => setNetworkPage(p => Math.max(1, p - 1))}
                    disabled={networkPage === 1}
                    className="flex items-center justify-center h-8 px-3 text-sm rounded-sm transition-colors text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
                  >上一页</button>
                  <span className="text-sm text-muted-foreground">第 {networkPage} 页</span>
                  <button
                    onClick={() => setNetworkPage(p => p + 1)}
                    disabled={networkBooksLoading}
                    className="flex items-center justify-center h-8 px-3 text-sm rounded-sm transition-colors text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent"
                  >下一页</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <BatchActionBar
        batchMode={batchMode}
        selectedCount={selectedIds.size}
        totalCount={books.length}
        canAddShelf
        canRemoveShelf={false}
        canDownload
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

// ── Sub-components ──────────────────────────────────────────────────────────────

function networkBookToRow(book: NetworkBook, idx: number): BookRow {
  const title = book.title || book.name || `未命名-${idx}`;
  const authorRaw = book.author || book.authors;
  const author = typeof authorRaw === 'string'
    ? authorRaw
    : Array.isArray(authorRaw)
      ? authorRaw.map((a) => (typeof a === 'string' ? a : a.name)).join(', ')
      : '';
  // Network books don't carry a stable id; synthesize one from the index so the table
  // can key rows. The detail link is intentionally not wired for these — they're
  // search/explore results and we'd need the originating server to resolve a real id.
  return {
    id: `network-${idx}`,
    title,
    author,
    img: book.cover_url || book.img || book.thumb,
  };
}

function NetworkBookTable({ books }: { books: NetworkBook[] }) {
  return <BookTable books={books.map((b, i) => networkBookToRow(b, i))} linkable={false} />;
}

function NetworkBookGrid({ books, viewMode }: { books: NetworkBook[]; viewMode: ViewMode }) {
  return (
    <div className={cn('rounded-[30px] app-card p-4 gap-x-4 gap-y-7', viewMode === 'grid' ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' : 'grid grid-cols-1 lg:grid-cols-2 gap-4')}>
      {books.map((book, idx) => {
        const title = book.title || book.name || '';
        const authorRaw = book.author || book.authors;
        const author = typeof authorRaw === 'string'
          ? authorRaw
          : Array.isArray(authorRaw)
            ? authorRaw.map((a) => (typeof a === 'string' ? a : a.name)).join(', ')
            : '';
        const coverUrl = book.cover_url || book.img || book.thumb;
        const ci = getColorIndex(title + idx);
        return viewMode === 'grid' ? (
          <div key={idx} className="group flex flex-col gap-3 rounded-[22px] p-2.5 transition-all duration-300 hover:bg-white/65 hover:shadow-[0_18px_45px_-30px_rgba(74,57,35,0.65)]">
            <div className="relative w-full overflow-hidden rounded-[18px] bg-white book-cover-shadow ring-1 ring-black/5 transition-all duration-300 ease-out group-hover:-translate-y-1.5" style={{ aspectRatio: '2/3' }}>
              {coverUrl ? (
                <img src={coverUrl} alt={title} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
              ) : (
                <div className={cn('w-full h-full flex items-center justify-center', colors[ci])}>
                  <span className="text-foreground/20 text-2xl font-bold font-serif">{title[0]}</span>
                </div>
              )}
              <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-white/18 to-transparent opacity-80" />
              <div className="absolute inset-y-0 left-0 w-[10%] bg-gradient-to-r from-black/18 via-black/4 to-transparent mix-blend-multiply" />
            </div>
            <div className="flex flex-col gap-0.5 px-0.5">
              <span className="text-sm font-medium truncate text-foreground">{title}</span>
              {author && <span className="text-xs truncate text-muted-foreground">{author}</span>}
            </div>
          </div>
        ) : (
          <div key={idx} className="group flex items-center gap-4 pl-1 pr-4 py-4 rounded-2xl transition-all hover:bg-white/70 border border-transparent hover:border-amber-950/10 hover:shadow-sm">
            <div className="w-14 h-[84px] rounded overflow-hidden shadow-card shrink-0 flex items-center justify-center relative">
              {coverUrl ? (
                <img src={coverUrl} alt={title} className="w-full h-full object-cover" loading="lazy" />
              ) : (
                <div className={cn('w-full h-full flex items-center justify-center', colors[ci])}>
                  <span className="text-foreground/30 text-xs font-bold font-serif">{title[0]}</span>
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate text-foreground">{title}</p>
              {author && <p className="text-xs text-muted-foreground truncate">{author}</p>}
            </div>
            <span className="text-[11px] text-muted-foreground shrink-0">在线</span>
          </div>
        );
      })}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs shrink-0 text-muted-foreground">{label}</span>
      <Select
        value={value}
        onChange={onChange}
        options={options.map((o) => ({ value: o, label: o }))}
      />
    </div>
  );
}
