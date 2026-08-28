'use client';

import Link from 'next/link';
import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Search, ArrowLeft, Loader2 } from 'lucide-react';
import { useServerStore } from '@/lib/store/server';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { getErrorMessage, MokeApiError, readApiJson, request } from '@/lib/api';
import { cn, resolveServerAssetUrl } from '@/lib/utils';
import { AuthImage } from '@/components/ui/AuthImage';
import { BookTable, type BookRow, type SortState } from '@/components/book/BookTable';
import { buildNetworkBookHref, pollNetworkSearch, type NetworkSearchStatusResponse } from '@/lib/network-book-core';
import { pollNetworkSaveForBook, saveNetworkBook } from '@/lib/network-books';
import { ViewModeToggle, type ViewMode } from '@/components/book/ViewModeToggle';
import { BatchActionBar, type BatchAction } from '@/components/book/BatchActionBar';
import { BookContextMenu, type ContextMenuItem } from '@/components/book/BookContextMenu';
import { Select } from '@/components/ui/Select';
import { useViewPrefsStore } from '@/lib/store/view-prefs';
import { beginOfflineDownload, endOfflineDownload } from '@/lib/offline-download';
import { startManagedOfflineBookDownload } from '@/lib/managed-offline-download';
import { listOfflineBooks } from '@/lib/offline-books';
import { buildOfflineLibrary } from '@/lib/offline-library';
import { useLongPressRegistry } from '@/lib/long-press';
import { useToast } from '@/lib/toast';
import { BookOpen, Check, Download, ListChecks, X } from 'lucide-react';
import { BookCoverFallback } from '@/components/book/BookCoverFallback';

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
  state?: { wants?: boolean | number };
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
  /** 书籍来源的书源 id（搜索时按源分组，需要在扁平化时保留）。 */
  source_id?: number;
  source_name?: string;
}

const TAG_DROPDOWN_LIMIT = 12;
const MORE_TAGS_VALUE = '__moke_more_tags__';

export default function LibraryPage() {
  const { serverUrl, offlineMode } = useServerStore();
  const router = useRouter();
  const isTauriApp = process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';

  // Shared
  const [activeTab, setActiveTab] = useState<'local' | 'online'>('local');
  const viewMode = useViewPrefsStore((s) => s.libraryViewMode);
  const setViewMode = useViewPrefsStore((s) => s.setLibraryViewMode);
  const [searchQ, setSearchQ] = useState('');
  const toast = useToast((s) => s.show);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchMode, setBatchMode] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; bookId: string } | null>(null);
  const [networkContextMenu, setNetworkContextMenu] = useState<{ x: number; y: number; book: NetworkBook } | null>(null);
  const lastSelectedIdRef = useRef<string | null>(null);
  const { makeHandlers: makeLongPressHandlers } = useLongPressRegistry();

  const networkSaveAbortRef = useRef<Set<AbortController>>(new Set());
  const [networkSavingKeys, setNetworkSavingKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    const abortControllers = networkSaveAbortRef.current;
    return () => {
      for (const controller of abortControllers) controller.abort();
      abortControllers.clear();
    };
  }, []);

  // Clear selection when tab switches or server changes
  useEffect(() => {
    setSelectedIds(new Set());
    setBatchMode(false);
    setContextMenu(null);
    setNetworkContextMenu(null);
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

  // 请求序号：每个数据请求在发起时取号，回写 setState 前校验仍是当前最新，
  // 慢的旧请求即使后返回也不会覆盖新结果（翻页/切 tab/连搜/详情跳转的竞态保护）。
  const booksSeqRef = useRef(0);
  const categoriesSeqRef = useRef(0);
  const networkBooksSeqRef = useRef(0);
  const networkSearchSeqRef = useRef(0);
  // 在途网络搜索的控制句柄：新搜索/卸载时 abort，防止并行轮询与卸载后后台空转。
  const networkSearchControllerRef = useRef<AbortController | null>(null);

  // 卸载时终止在途的网络搜索轮询，避免离开页面后仍在后台每 1s 打 status。
  useEffect(() => {
    return () => {
      networkSearchControllerRef.current?.abort();
      networkSearchControllerRef.current = null;
    };
  }, []);

  // ── Local tab effects ────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab === 'local') loadBooks(currentPage);
  }, [serverUrl, offlineMode, activeTab, currentPage, selectedFormat, selectedTag]);

  useEffect(() => {
    if (!serverUrl) return;
    loadTags();
  }, [serverUrl, offlineMode]);

  const loadBooks = async (page: number) => {
    const seq = ++booksSeqRef.current;
    setLocalLoading(true);
    try {
      if (offlineMode) {
        const records = await listOfflineBooks(serverUrl || undefined);
        const localBooks: BookItem[] = buildOfflineLibrary(records);
        const filtered = selectedFormat === '全部'
          ? localBooks
          : localBooks.filter((book) => book.files?.[0]?.format.toLowerCase() === selectedFormat.toLowerCase());
        if (seq !== booksSeqRef.current) return;
        setBooks(filtered.slice((page - 1) * pageSize, page * pageSize));
        setTotal(filtered.length);
        return;
      }
      const params = new URLSearchParams({
        start: String((page - 1) * pageSize),
        size: String(pageSize),
      });
      if (selectedTag !== '全部') params.set('tag', selectedTag);
      if (selectedFormat !== '全部') params.set('format', selectedFormat.toLowerCase());
      const res = await request(`${serverUrl}/api/library?${params.toString()}`, { credentials: 'include' });
      const data = await readApiJson<{ err?: string; msg?: string; books?: BookItem[]; items?: BookItem[]; total?: number }>(res, '书库列表解析失败。', ['ok', 'user.need_login']);
      if (seq !== booksSeqRef.current) return;
      if (data.err === 'user.need_login') { router.push('/login'); return; }
      setBooks(data.books || data.items || []);
      setTotal(data.total || 0);
    } catch (error) {
      if (seq !== booksSeqRef.current) return;
      setBooks([]);
      setTotal(0);
      toast(getErrorMessage(error, '书库加载失败，请检查服务器连接。'));
    } finally { if (seq === booksSeqRef.current) setLocalLoading(false); }
  };

  const loadTags = async () => {
    if (offlineMode) {
      setTagOptions(['全部']);
      return;
    }
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
    if (!offlineMode && activeTab === 'online' && networkSources.length === 0) loadNetworkSources();
  }, [activeTab, offlineMode, serverUrl]);

  useEffect(() => {
    if (offlineMode && activeTab !== 'local') setActiveTab('local');
  }, [activeTab, offlineMode]);

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
      const data = await readApiJson<{ err?: string; msg?: string; items?: NetworkSource[] }>(res, '网络书源解析失败。');
      setNetworkSources(data.items || []);
    } catch (error) {
      setNetworkSources([]);
      toast(getErrorMessage(error, '网络书源加载失败。'));
    } finally { setNetworkSourcesLoading(false); }
  };

  const loadCategories = async (sourceId: number) => {
    const seq = ++categoriesSeqRef.current;
    setCategoriesLoading(true);
    try {
      const res = await request(`${serverUrl}/api/network/categories?source_id=${sourceId}`, { credentials: 'include' });
      const data = await readApiJson<{ err?: string; msg?: string; items?: NetworkCategory[] }>(res, '分类解析失败。');
      if (seq !== categoriesSeqRef.current) return;
      setCategories(data.items || []);
    } catch (error) {
      if (seq !== categoriesSeqRef.current) return;
      setCategories([]);
      toast(getErrorMessage(error, '分类加载失败。'));
    } finally { if (seq === categoriesSeqRef.current) setCategoriesLoading(false); }
  };

  const loadNetworkBooks = async (categoryUrl: string, page: number) => {
    if (!selectedSourceId) return;
    const seq = ++networkBooksSeqRef.current;
    setNetworkBooksLoading(true);
    try {
      const params = new URLSearchParams({ source_id: String(selectedSourceId), url: categoryUrl, page: String(page) });
      const res = await request(`${serverUrl}/api/network/explore?${params.toString()}`, { credentials: 'include' });
      const data = await readApiJson<{ err?: string; msg?: string; books?: NetworkBook[] }>(res, '网络书籍解析失败。');
      if (seq !== networkBooksSeqRef.current) return;
      setNetworkBooks((data.books || []).map((b) => ({ ...b, source_id: selectedSourceId })));
    } catch (error) {
      if (seq !== networkBooksSeqRef.current) return;
      setNetworkBooks([]);
      toast(getErrorMessage(error, '网络书籍加载失败。'));
    } finally { if (seq === networkBooksSeqRef.current) setNetworkBooksLoading(false); }
  };

  // ── Network search ───────────────────────────────────────────────────────────
  const doNetworkSearch = useCallback(async (q: string) => {
    if (!q.trim() || !serverUrl) return;
    // 发起新搜索时终止上一路在途轮询，避免两条并行循环互相覆盖结果/loading 状态。
    networkSearchControllerRef.current?.abort();
    const controller = new AbortController();
    networkSearchControllerRef.current = controller;
    const seq = ++networkSearchSeqRef.current;
    setNetworkSearchMode(true);
    setNetworkSearchLoading(true);
    setNetworkSearchResults([]);
    try {
      const params = new URLSearchParams({ key: q.trim() });
      const initRes = await request(`${serverUrl}/api/network/search?${params.toString()}`, { credentials: 'include', signal: controller.signal });
      const initData = await readApiJson<{ err?: string; msg?: string; task_id?: string | number }>(initRes, '网络搜索任务解析失败。');
      const taskId = initData.task_id;
      if (taskId == null) throw new Error('网络搜索任务创建失败。');
      // 轮询在 abort（新搜索 / 卸载）时提前返回 null，不再继续打 status。
      await pollNetworkSearch({
        fetchStatus: async () => {
          const pollRes = await request(`${serverUrl}/api/network/search/status?task_id=${taskId}`, { credentials: 'include', signal: controller.signal });
          return readApiJson<NetworkSearchStatusResponse>(pollRes, '网络搜索结果解析失败。');
        },
        signal: controller.signal,
        intervalMs: 1000,
        maxAttempts: 60,
        onPartial: (books) => {
          if (seq !== networkSearchSeqRef.current) return;
          setNetworkSearchResults(books);
        },
      });
    } catch (error) {
      // 已取消（新搜索接管或组件卸载）时静默退出，不弹错误、不回写状态。
      if (controller.signal.aborted) return;
      if (seq !== networkSearchSeqRef.current) return;
      toast(getErrorMessage(error, '网络搜索失败。'));
    } finally {
      // 仅当仍是当前最新的一路时才收尾，避免旧的先结束时提前把 loading 置 false。
      if (seq === networkSearchSeqRef.current && networkSearchControllerRef.current === controller) {
        networkSearchControllerRef.current = null;
        setNetworkSearchLoading(false);
      }
    }
  }, [serverUrl]);

  // 返回浏览 / 切走在线 tab 时终止在途网络搜索轮询。
  const cancelNetworkSearch = useCallback(() => {
    networkSearchControllerRef.current?.abort();
    networkSearchControllerRef.current = null;
    networkSearchSeqRef.current++;
    setNetworkSearchLoading(false);
  }, []);

  useEffect(() => {
    if (activeTab !== 'online') cancelNetworkSearch();
  }, [activeTab, cancelNetworkSearch]);

  const submitActiveSearch = () => {
    if (activeTab === 'local') {
      if (searchQ.trim()) router.push(`/search?q=${encodeURIComponent(searchQ.trim())}`);
    } else {
      doNetworkSearch(networkSearchQ);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // 网络搜索进行中忽略 Enter，避免并行启动第二条轮询。
      if (activeTab === 'online' && networkSearchLoading) return;
      submitActiveSearch();
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
    if (!beginOfflineDownload(serverUrl, id, format)) {
      toast(`《${book.title}》正在下载中`);
      return;
    }
    try {
      await startManagedOfflineBookDownload({
        serverUrl,
        bookId: id,
        title: book.title,
        author: book.author || book.authors?.map((item) => item.name).filter(Boolean).join('、'),
        inShelf: Boolean(book.state?.wants),
        format,
      });
      toast(`《${book.title}》已下载`);
    } catch {
      toast('下载失败');
    } finally {
      endOfflineDownload(serverUrl, id, format);
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
  };

  const openContextMenu = (bookId: string, x: number, y: number) => {
    setContextMenu({ x, y, bookId });
  };

  // ── Network-book actions (在线书库) ─────────────────────────────────────────
  const openNetworkContextMenu = (book: NetworkBook, x: number, y: number) => {
    setNetworkContextMenu({ x, y, book });
  };

  const openNetworkBookUnavailable = (book: NetworkBook) => {
    toast(`《${book.title || book.name || '该书'}》的书源未提供链接，无法查看详情或保存，可尝试搜索书名。`);
  };

  const saveNetworkBookWithFeedback = async (book: NetworkBook) => {
    const sourceId = book.source_id;
    if (sourceId == null || !book.book_url) {
      toast('缺少书源信息，无法保存。');
      return;
    }
    const key = `${sourceId}:${book.book_url}`;
    if (networkSavingKeys.has(key)) return;
    setNetworkSavingKeys((prev) => new Set(prev).add(key));
    const controller = new AbortController();
    networkSaveAbortRef.current.add(controller);
    const title = book.title || book.name || '该书';
    try {
      await saveNetworkBook(serverUrl, sourceId, book.book_url);
      if (controller.signal.aborted) return;
      toast(`已开始保存《${title}》到本地书库`);
      const result = await pollNetworkSaveForBook(serverUrl, sourceId, book.book_url, {
        intervalMs: 1500,
        maxMisses: 3,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (result.status === 'completed') {
        toast(`《${title}》已保存到书库`);
      } else if (result.status === 'failed') {
        toast(`《${title}》保存失败：${result.error || '未知错误'}`);
      } else if (result.status === 'timeout') {
        toast(`《${title}》保存超时，请稍后到书库查看或重试。`);
      } else if (result.status === 'lost') {
        toast('保存进度丢失，可能服务器已重启，请稍后重试。');
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof MokeApiError && error.code === 'permission.not_permit') {
        toast('当前账号没有保存网络书的权限，请联系管理员在后台开启「保存」权限。');
        return;
      }
      if (error instanceof MokeApiError && error.code === 'user.need_login') {
        toast('登录状态已失效，请重新登录后重试。');
        router.push('/login');
        return;
      }
      toast(getErrorMessage(error, '保存失败，请检查网络或登录状态。'));
    } finally {
      networkSaveAbortRef.current.delete(controller);
      setNetworkSavingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const buildNetworkMenuItems = (book: NetworkBook): ContextMenuItem[] => {
    const sourceId = book.source_id;
    const title = book.title || book.name || '该书';
    return [
      {
        key: 'open',
        label: '查看详情',
        icon: <BookOpen className="w-3.5 h-3.5" />,
        disabled: sourceId == null || !book.book_url,
        onClick: () => {
          if (sourceId != null && book.book_url) {
            router.push(buildNetworkBookHref(sourceId, book.book_url));
          }
        },
      },
      { key: 'sep-1', label: '', separator: true },
      {
        key: 'save',
        label: '保存到本地书库',
        icon: <Download className="w-3.5 h-3.5" />,
        disabled:
          sourceId == null || !book.book_url || networkSavingKeys.has(`${sourceId}:${book.book_url}`),
        onClick: () => void saveNetworkBookWithFeedback(book),
      },
    ];
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
      let skipped = 0;
      for (const id of ids) {
        const book = books.find((b) => String(b.id) === id);
        if (!book) { fail++; continue; }
        const format = (book.files?.[0]?.format || 'epub').toLowerCase();
        if (!beginOfflineDownload(serverUrl, id, format)) { skipped++; continue; }
        try {
          await startManagedOfflineBookDownload({
            serverUrl,
            bookId: id,
            title: book.title,
            author: book.author || book.authors?.map((item) => item.name).filter(Boolean).join('、'),
            inShelf: Boolean(book.state?.wants),
            format,
          });
          ok++;
        } catch { fail++; }
        finally { endOfflineDownload(serverUrl, id, format); }
      }
      exitBatchMode();
      if (ok > 0) toast(`已下载 ${ok} 本`);
      if (fail > 0) toast(`${fail} 本下载失败`);
      if (skipped > 0) toast(`${skipped} 本正在下载中，已跳过`);
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

  const searchPlaceholder = '搜索书籍';

  return (
    <DesktopLayout>
      {/* ── Header ── */}
      <header className="sticky top-0 z-10 flex shrink-0 flex-col gap-4 border-b border-amber-950/10 bg-[#fffdf8]/80 px-4 py-4 backdrop-blur-xl sm:px-6 md:flex-row md:items-center md:px-8 md:py-5">
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
        <div className="hidden flex-1 md:block" />

        <div className="flex w-full min-w-0 items-center gap-2 md:w-auto">
          {/* Search — switches mode per tab */}
          <div className="flex min-w-0 flex-1 items-center gap-2 md:w-[390px] md:flex-none">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <input
                type="search"
                placeholder={searchPlaceholder}
                value={activeSearchQ}
                onChange={(e) => setActiveSearchQ(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                className="w-full h-10 pl-10 pr-3 text-sm rounded-2xl border border-amber-950/10 bg-white/70 text-foreground shadow-sm outline-none transition focus:border-primary/60 focus:bg-white"
              />
            </div>
            <button
              type="button"
              onClick={submitActiveSearch}
              disabled={!activeSearchQ.trim() || (activeTab === 'online' && networkSearchLoading)}
              className="h-10 shrink-0 rounded-2xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {activeTab === 'online' && networkSearchLoading ? '搜索中' : '搜索'}
            </button>
          </div>
          <ViewModeToggle value={viewMode} onChange={setViewMode} className="ml-1 shrink-0" />
        </div>
      </header>

      {/* ── Tabs ── */}
      <div className="relative shrink-0 border-b border-amber-950/10 bg-white/35 px-4 backdrop-blur-sm sm:px-6 md:px-8">
        <div className="flex items-center gap-8 relative">
          <button
            onClick={() => setActiveTab('local')}
            className={cn('py-3 text-sm transition-colors duration-200', activeTab === 'local' ? 'text-foreground font-medium' : 'text-muted-foreground')}
          >本地</button>
          {!offlineMode && <button
            onClick={() => setActiveTab('online')}
            className={cn('py-3 text-sm transition-colors duration-200', activeTab === 'online' ? 'text-foreground font-medium' : 'text-muted-foreground')}
          >在线</button>}
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
          <div className="shrink-0 border-b border-amber-950/10 bg-white/25 px-4 py-3 sm:px-6 md:px-8 md:py-4">
            <div className="flex items-center gap-4 overflow-x-auto rounded-3xl app-card px-4 py-3 md:gap-6">
              <FilterSelect label="格式" value={selectedFormat} options={['全部', 'EPUB', 'PDF', 'MOBI', 'TXT', 'AZW3']} onChange={(v) => updateFilter('format', v)} />
              <TagFilterSelect value={selectedTag} options={tagOptions} onChange={(v) => updateFilter('tag', v)} />
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-auto px-4 py-5 sm:px-6 md:px-8 md:py-8">
            {localLoading ? (
              <div className="flex items-center justify-center h-64">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
              </div>
            ) : books.length === 0 ? (
              <div className="rounded-[28px] app-glass px-5 py-12 text-center sm:rounded-[32px] sm:px-8 sm:py-16">
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
                paged={totalPages > 1}
                onSortChange={() => setCurrentPage(1)}
              />
            ) : (
              <div className={cn('rounded-[24px] app-card p-2 sm:rounded-[30px] sm:p-4', viewMode === 'grid' ? 'grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-7 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' : 'grid grid-cols-1 gap-1 lg:grid-cols-2 lg:gap-4')}>
                {books.map((book, index) => {
                  const authorName = book.author || book.authors?.[0]?.name || '';
                  const bookId = String(book.id);
                  const coverUrl = resolveServerAssetUrl(serverUrl, book.img || book.thumb);
                  const selected = selectedIds.has(bookId);
                  // Build interaction handlers: batch mode toggles selection; otherwise
                  // right-click / long-press opens the context menu.
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
                    : makeLongPressHandlers(bookId, openContextMenu);
                  return viewMode === 'grid' ? (
                    <Link key={bookId} href={`/detail?id=${bookId}`} {...cardHandlers} className={`book-card-motion group relative flex flex-col gap-3 rounded-[22px] p-2.5 transition-all duration-300 hover:bg-white/65 hover:shadow-[0_18px_45px_-30px_rgba(74,57,35,0.65)] ${selected ? 'ring-2 ring-primary/60 bg-white/70' : batchMode ? 'cursor-pointer' : ''}`}>
                      <div className="book-cover-motion relative w-full overflow-hidden rounded-[18px] bg-white book-cover-shadow ring-1 ring-black/5 transition-all duration-300 ease-out group-hover:-translate-y-1.5" style={{ aspectRatio: '2/3' }}>
                        {coverUrl ? (
                          <AuthImage
                            src={coverUrl}
                            alt={book.title}
                            className="book-cover-media w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                            loading={index === 0 ? 'eager' : 'lazy'}
                            fetchPriority={index === 0 ? 'high' : 'auto'}
                            fallback={
                              <BookCoverFallback title={book.title} seed={bookId} className="book-cover-media" textClassName="text-2xl" />
                            }
                          />
                        ) : (
                          <BookCoverFallback title={book.title} seed={bookId} className="book-cover-media" textClassName="text-2xl" />
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
                        <span className="book-title-motion text-sm font-semibold truncate text-foreground">{book.title}</span>
                        {authorName && <span className="text-xs truncate text-muted-foreground">{authorName}</span>}
                      </div>
                    </Link>
                  ) : (
                    <Link key={bookId} href={`/detail?id=${bookId}`} {...cardHandlers} className={`book-list-motion group flex min-w-0 items-center gap-3 rounded-2xl border border-transparent px-2 py-3 transition-all hover:border-amber-950/10 hover:bg-white/70 hover:shadow-sm sm:gap-4 sm:px-3 sm:py-4 ${selected ? 'bg-white/70 ring-1 ring-primary/40' : batchMode ? 'cursor-pointer' : ''}`}>
                      <div className={`overflow-hidden shrink-0 transition-[width,opacity] duration-200 ease-out ${batchMode ? 'w-5 opacity-100' : 'w-0 opacity-0'}`}>
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center transition-all duration-150 ${selected ? 'bg-primary text-primary-foreground scale-100' : 'border-2 border-muted-foreground/30 scale-90'}`}>
                          {selected && <span className="text-[10px] font-bold">✓</span>}
                        </div>
                      </div>
                      <div className="book-list-cover-motion h-[72px] w-12 rounded-md overflow-hidden shadow-card shrink-0 flex items-center justify-center relative sm:h-[84px] sm:w-14">
                        {coverUrl ? (
                          <AuthImage
                            src={coverUrl}
                            alt={book.title}
                            className="w-full h-full object-cover"
                            loading={index === 0 ? 'eager' : 'lazy'}
                            fetchPriority={index === 0 ? 'high' : 'auto'}
                            fallback={
                              <BookCoverFallback title={book.title} seed={bookId} textClassName="text-xs" />
                            }
                          />
                        ) : (
                          <BookCoverFallback title={book.title} seed={bookId} textClassName="text-xs" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="book-title-motion line-clamp-2 text-sm font-semibold leading-5 text-foreground">{book.title}</p>
                        {authorName && <p className="text-xs text-muted-foreground truncate">{authorName}</p>}
                      </div>
                      <span className="shrink-0 rounded-md border border-border/40 bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{book.files?.[0]?.format?.toUpperCase() || 'EPUB'}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex shrink-0 items-center justify-center gap-1.5 overflow-x-auto border-t border-amber-950/10 bg-white/35 px-4 py-4 backdrop-blur-sm sm:px-8 md:py-5">
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
            <div className="shrink-0 border-b border-amber-950/10 bg-white/25 px-4 py-3 sm:px-6 md:px-8 md:py-4">
              <div className="flex items-center gap-4 overflow-x-auto rounded-3xl app-card px-4 py-3 md:gap-6">
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
            <div className="flex-1 min-h-0 overflow-auto px-4 py-5 sm:px-6 md:px-8 md:py-8">
              <div className="flex items-center gap-3 mb-6">
                <button
                  onClick={() => { cancelNetworkSearch(); setNetworkSearchMode(false); setNetworkSearchQ(''); setNetworkSearchResults([]); }}
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
                <div className="rounded-[28px] app-glass px-5 py-12 text-center sm:rounded-[32px] sm:px-8 sm:py-16">
                  <p className="text-lg font-semibold text-foreground">没有找到相关书籍</p>
                  <p className="mt-2 text-sm text-muted-foreground">换个关键词试试。</p>
                </div>
              ) : viewMode === 'rows' ? (
                <NetworkBookTable books={networkSearchResults} onContextAction={openNetworkContextMenu} />
              ) : (
                <NetworkBookGrid books={networkSearchResults} viewMode={viewMode} onContextAction={openNetworkContextMenu} onOpenUnavailable={openNetworkBookUnavailable} />
              )}
            </div>
          ) : (
            /* ── Browse books / empty states ── */
            <div className="flex-1 min-h-0 overflow-auto flex flex-col">
              <div className="flex-1 min-h-0 overflow-auto px-4 py-5 sm:px-6 md:px-8 md:py-8">
                {/* 未选书源 */}
                {selectedSourceId === null ? (
                  <div className="rounded-[28px] app-glass px-5 py-12 text-center sm:rounded-[32px] sm:px-8 sm:py-16">
                    <p className="text-lg font-semibold text-foreground">请先选择一个书源</p>
                    <p className="mt-2 text-sm text-muted-foreground">在上方筛选栏选择书源，即可浏览该书源的书籍分类。</p>
                  </div>
                ) : /* 已选书源但未选分类 */
                selectedCategoryUrl === null ? (
                  <div className="rounded-[28px] app-glass px-5 py-12 text-center sm:rounded-[32px] sm:px-8 sm:py-16">
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
                  <div className="rounded-[28px] app-glass px-5 py-12 text-center sm:rounded-[32px] sm:px-8 sm:py-16">
                    <p className="text-lg font-semibold text-foreground">该分类暂无书籍</p>
                    <p className="mt-2 text-sm text-muted-foreground">换个分类试试，或稍后再来看看。</p>
                  </div>
                ) : viewMode === 'rows' ? (
                  <NetworkBookTable books={networkBooks} onContextAction={openNetworkContextMenu} paged onSortChange={() => setNetworkPage(1)} />
                ) : (
                  <NetworkBookGrid books={networkBooks} viewMode={viewMode} onContextAction={openNetworkContextMenu} onOpenUnavailable={openNetworkBookUnavailable} />
                )}
              </div>

              {/* 分页，仅在有书籍时显示 */}
              {selectedCategoryUrl !== null && !networkBooksLoading && networkBooks.length > 0 && (
                <div className="flex shrink-0 items-center justify-center gap-3 border-t border-amber-950/10 bg-white/35 px-4 py-4 backdrop-blur-sm sm:px-8 md:py-5">
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
      {networkContextMenu && (() => {
        const book = networkContextMenu.book;
        return (
          <BookContextMenu
            position={{ x: networkContextMenu.x, y: networkContextMenu.y }}
            items={buildNetworkMenuItems(book)}
            onClose={() => setNetworkContextMenu(null)}
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
  // can key rows. Rows are made clickable via `getRowHref`, which resolves the
  // network-book detail page from `source_id` + `book_url` (see NetworkBookTable).
  return {
    id: `network-${idx}`,
    title,
    author,
    img: book.cover_url || book.img || book.thumb,
    source_id: book.source_id,
    book_url: book.book_url,
  };
}

function NetworkBookTable({
  books,
  onContextAction,
  paged = false,
  onSortChange,
}: {
  books: NetworkBook[];
  onContextAction?: (book: NetworkBook, x: number, y: number) => void;
  /** 网络书籍也是分页加载时，排序只作用于当前页：显示提示并配合 onSortChange 重置页码。 */
  paged?: boolean;
  onSortChange?: (sort: SortState | null) => void;
}) {
  return (
    <BookTable
      books={books.map((b, i) => networkBookToRow(b, i))}
      getRowHref={(row) =>
        row.source_id != null && row.book_url ? buildNetworkBookHref(row.source_id, row.book_url) : ''
      }
      paged={paged}
      onSortChange={onSortChange}
      onContextAction={
        onContextAction
          ? (id, x, y) => {
              const idx = parseInt(String(id).replace(/^network-/, ''), 10);
              const book = books[idx];
              if (book) onContextAction(book, x, y);
            }
          : undefined
      }
    />
  );
}

function buildNetworkCardHandlers(
  book: NetworkBook,
  onContextAction: (book: NetworkBook, x: number, y: number) => void,
  onTap?: (book: NetworkBook) => void,
) {
  let pressTimer: number | null = null;
  let didLongPress = false;
  let touchX = 0;
  let touchY = 0;
  return {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      onContextAction(book, e.clientX, e.clientY);
    },
    onTouchStart: (e: React.TouchEvent) => {
      didLongPress = false;
      const t = e.touches[0];
      touchX = t?.clientX ?? 0;
      touchY = t?.clientY ?? 0;
      pressTimer = window.setTimeout(() => {
        didLongPress = true;
        if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(50);
        onContextAction(book, touchX, touchY);
      }, 500);
    },
    onTouchEnd: () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    },
    onTouchMove: () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    },
    onClick: (e: React.MouseEvent) => {
      if (didLongPress) { e.preventDefault(); e.stopPropagation(); return; }
      // 没有可打开链接的书：普通点击给提示（否则卡片是「死的」）
      if (onTap) onTap(book);
    },
  };
}

function NetworkBookGrid({
  books,
  viewMode,
  onContextAction,
  onOpenUnavailable,
}: {
  books: NetworkBook[];
  viewMode: ViewMode;
  onContextAction?: (book: NetworkBook, x: number, y: number) => void;
  /** 该书没有 book_url（无法打开详情）时，普通点击的回调（用于提示）。 */
  onOpenUnavailable?: (book: NetworkBook) => void;
}) {
  return (
    <div className={cn('rounded-[24px] app-card p-2 sm:rounded-[30px] sm:p-4', viewMode === 'grid' ? 'grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 sm:gap-x-4 sm:gap-y-7 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6' : 'grid grid-cols-1 gap-1 lg:grid-cols-2 lg:gap-4')}>
      {books.map((book, idx) => {
        const title = book.title || book.name || '';
        const authorRaw = book.author || book.authors;
        const author = typeof authorRaw === 'string'
          ? authorRaw
          : Array.isArray(authorRaw)
            ? authorRaw.map((a) => (typeof a === 'string' ? a : a.name)).join(', ')
            : '';
        const coverUrl = book.cover_url || book.img || book.thumb;
        const coverSeed = `${title}:${idx}`;
        const href =
          book.source_id != null && book.book_url ? buildNetworkBookHref(book.source_id, book.book_url) : '';
        // 书源未提供 book_url 时没有可打开的详情页：让普通点击给出提示而不是死卡片。
        const cardHandlers = onContextAction
          ? buildNetworkCardHandlers(
              book,
              onContextAction,
              href ? undefined : onOpenUnavailable,
            )
          : {};

        if (viewMode === 'grid') {
          const card = (
            <>
              <div className="book-cover-motion relative w-full overflow-hidden rounded-[18px] bg-white book-cover-shadow ring-1 ring-black/5 transition-all duration-300 ease-out group-hover:-translate-y-1.5" style={{ aspectRatio: '2/3' }}>
                {coverUrl ? (
                  <img
                    src={coverUrl}
                    alt={title}
                    className="book-cover-media w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                    loading={idx === 0 ? 'eager' : 'lazy'}
                    fetchPriority={idx === 0 ? 'high' : 'auto'}
                  />
                ) : (
                  <BookCoverFallback title={title} seed={coverSeed} className="book-cover-media" textClassName="text-2xl" />
                )}
                <div className="absolute inset-x-0 top-0 h-1/3 bg-gradient-to-b from-white/18 to-transparent opacity-80" />
                <div className="absolute inset-y-0 left-0 w-[10%] bg-gradient-to-r from-black/18 via-black/4 to-transparent mix-blend-multiply" />
              </div>
              <div className="flex flex-col gap-0.5 px-0.5">
                <span className="book-title-motion text-sm font-semibold truncate text-foreground">{title}</span>
                {author && <span className="text-xs truncate text-muted-foreground">{author}</span>}
              </div>
            </>
          );
          return href ? (
            <Link key={idx} href={href} {...cardHandlers} className="book-card-motion group flex flex-col gap-3 rounded-[22px] p-2.5 transition-all duration-300 hover:bg-white/65 hover:shadow-[0_18px_45px_-30px_rgba(74,57,35,0.65)]">
              {card}
            </Link>
          ) : (
            <div key={idx} {...cardHandlers} className="book-card-motion group flex flex-col gap-3 rounded-[22px] p-2.5 transition-all duration-300 hover:bg-white/65 hover:shadow-[0_18px_45px_-30px_rgba(74,57,35,0.65)]">
              {card}
            </div>
          );
        }

        const card = (
          <>
            <div className="book-list-cover-motion h-[72px] w-12 rounded-md overflow-hidden shadow-card shrink-0 flex items-center justify-center relative sm:h-[84px] sm:w-14">
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt={title}
                  className="w-full h-full object-cover"
                  loading={idx === 0 ? 'eager' : 'lazy'}
                  fetchPriority={idx === 0 ? 'high' : 'auto'}
                />
              ) : (
                <BookCoverFallback title={title} seed={coverSeed} textClassName="text-xs" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="book-title-motion line-clamp-2 text-sm font-semibold leading-5 text-foreground">{title}</p>
              {author && <p className="text-xs text-muted-foreground truncate">{author}</p>}
            </div>
            <span className="shrink-0 rounded-md border border-border/40 bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">在线</span>
          </>
        );
        return href ? (
          <Link key={idx} href={href} {...cardHandlers} className="book-list-motion group flex min-w-0 items-center gap-3 rounded-2xl border border-transparent px-2 py-3 transition-all hover:border-amber-950/10 hover:bg-white/70 hover:shadow-sm sm:gap-4 sm:px-3 sm:py-4">
            {card}
          </Link>
        ) : (
          <div key={idx} {...cardHandlers} className="book-list-motion group flex min-w-0 items-center gap-3 rounded-2xl border border-transparent px-2 py-3 transition-all hover:border-amber-950/10 hover:bg-white/70 hover:shadow-sm sm:gap-4 sm:px-3 sm:py-4">
            {card}
          </div>
        );
      })}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span className="text-xs shrink-0 text-muted-foreground">{label}</span>
      <Select
        value={value}
        onChange={onChange}
        options={options.map((o) => ({ value: o, label: o }))}
      />
    </div>
  );
}

function TagFilterSelect({ value, options, onChange }: { value: string; options: string[]; onChange: (value: string) => void }) {
  const [showAllTags, setShowAllTags] = useState(false);
  const hasMoreTags = options.length > TAG_DROPDOWN_LIMIT;
  const compactTags = hasMoreTags
    ? Array.from(new Set([
        ...options.slice(0, TAG_DROPDOWN_LIMIT),
        ...(options.includes(value) ? [value] : []),
      ]))
    : options;
  const selectOptions = [
    ...compactTags.map((tag) => ({ value: tag, label: tag })),
    ...(hasMoreTags ? [{ value: MORE_TAGS_VALUE, label: '更多标签…' }] : []),
  ];

  return (
    <>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-xs shrink-0 text-muted-foreground">标签</span>
        <Select
          value={value}
          onChange={(nextValue) => {
            if (nextValue === MORE_TAGS_VALUE) {
              setShowAllTags(true);
              return;
            }
            onChange(nextValue);
          }}
          options={selectOptions}
        />
      </div>

      {showAllTags && (
        <TagPickerDialog
          value={value}
          options={options}
          onSelect={onChange}
          onClose={() => setShowAllTags(false)}
        />
      )}
    </>
  );
}

function TagPickerDialog({
  value,
  options,
  onSelect,
  onClose,
}: {
  value: string;
  options: string[];
  onSelect: (value: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="all-tags-title"
        className="flex max-h-[85dvh] w-full flex-col rounded-t-[28px] border border-amber-950/10 bg-white/95 shadow-2xl backdrop-blur sm:max-w-2xl sm:rounded-[28px]"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-amber-950/10 px-5 py-4 sm:px-6">
          <div>
            <h2 id="all-tags-title" className="text-base font-semibold text-foreground">全部标签</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">共 {options.length} 个选项</p>
          </div>
          <button
            type="button"
            aria-label="关闭全部标签"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-amber-950/10 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 grid-cols-2 gap-2 overflow-y-auto overscroll-contain p-4 sm:grid-cols-3 sm:gap-3 sm:p-6">
          {options.map((tag) => {
            const isSelected = tag === value;
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={isSelected}
                onClick={() => {
                  onSelect(tag);
                  onClose();
                }}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors',
                  isSelected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-amber-950/10 bg-white/70 text-foreground hover:bg-muted/60',
                )}
              >
                <span className="min-w-0 flex-1 break-words">{tag}</span>
                {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
