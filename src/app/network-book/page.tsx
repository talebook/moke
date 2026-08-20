'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, ArrowLeft, BookOpen, CheckCircle2, Loader2, Save } from 'lucide-react';
import { requestAnimatedBack } from '@/lib/native-back';
import { DesktopLayout } from '@/components/layout/DesktopLayout';
import { getErrorMessage, MokeApiError } from '@/lib/api';
import { useServerStore } from '@/lib/store/server';
import {
  fetchNetworkBook,
  pollNetworkSaveForBook,
  saveNetworkBook,
  type NetworkBookDetail,
} from '@/lib/network-books';
import { parseNetworkSourceId } from '@/lib/network-book-core';

function NetworkBookContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { serverUrl } = useServerStore();
  const sourceIdParam = searchParams.get('source_id');
  const bookUrl = searchParams.get('book_url');
  // 用 Number.isInteger 校验：`Number('abc')` 得 NaN、`Number('12.5')` 得小数，
  // 都不是合法的书源 id；`NaN == null` 为 false，会让守卫放行并向服务器发出
  // `source_id=NaN` 请求；非法值归一为 null 走守卫。
  const sourceId = parseNetworkSourceId(sourceIdParam);

  const [book, setBook] = useState<NetworkBookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fmt, setFmt] = useState<'txt' | 'epub'>('epub');
  const [saving, setSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ percent: number; done: number; total: number } | null>(null);
  const [saveError, setSaveError] = useState('');
  const [saveDone, setSaveDone] = useState(false);
  const aliveRef = useRef(true);
  const saveAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    const controller = new AbortController();
    saveAbortRef.current = controller;
    return () => {
      aliveRef.current = false;
      controller.abort();
    };
  }, []);

  const loadBook = useCallback(async () => {
    if (!serverUrl || sourceId == null || !bookUrl) {
      setError('缺少书源或书籍链接参数，无法加载详情。');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { book: detail } = await fetchNetworkBook(serverUrl, sourceId, bookUrl);
      if (!aliveRef.current) return;
      setBook(detail);
      if (!detail.name) setError('未找到该书籍。');
    } catch (e) {
      if (!aliveRef.current) return;
      if (e instanceof MokeApiError && e.code === 'user.need_login') {
        router.push('/login');
        return;
      }
      setError(getErrorMessage(e, '加载书籍详情失败。'));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [serverUrl, sourceId, bookUrl, router]);

  useEffect(() => {
    void loadBook();
  }, [loadBook]);

  const handleSave = async () => {
    if (!serverUrl || sourceId == null || !bookUrl || saving) return;
    setSaving(true);
    setSaveError('');
    setSaveDone(false);
    setSaveProgress(null);
    try {
      await saveNetworkBook(serverUrl, sourceId, bookUrl, fmt);
      const result = await pollNetworkSaveForBook(serverUrl, sourceId, bookUrl, {
        intervalMs: 1500,
        maxMisses: 3,
        signal: saveAbortRef.current?.signal,
        onUpdate: (state) => {
          if (state.status === 'running' && aliveRef.current) {
            setSaveProgress({ percent: state.progress, done: state.done, total: state.total });
          }
        },
      });
      if (!aliveRef.current) return;
      if (result.status === 'completed') {
        setSaveProgress(null);
        if (result.bookId) {
          router.push(`/detail?id=${result.bookId}`);
          return;
        }
        setSaveDone(true);
        return;
      }
      setSaveProgress(null);
      if (result.status === 'timeout') {
        setSaveError('保存超时，请稍后到书库查看或重试。');
        return;
      }
      if (result.status === 'aborted') return;
      setSaveError(
        result.status === 'failed' && result.error
          ? result.error
          : '保存任务已丢失，请稍后重试。',
      );
    } catch (e) {
      if (!aliveRef.current) return;
      setSaveProgress(null);
      if (e instanceof MokeApiError && e.code === 'user.need_login') {
        router.push('/login');
        return;
      }
      if (e instanceof MokeApiError && e.code === 'permission.not_permit') {
        setSaveError('当前账号没有保存网络书的权限，请联系管理员在后台开启「保存」权限。');
        return;
      }
      setSaveError(getErrorMessage(e, '发起保存失败。'));
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  };

  const coverUrl = book?.cover_url || '';
  const author = book?.author || '';
  const metaParts = [book?.kind, book?.word_count].filter(Boolean).join(' · ');

  return (
    <DesktopLayout>
      <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 md:px-8 md:py-8">
        <div className="mb-6 rounded-[24px] app-card px-4 py-4 sm:mb-8 sm:rounded-[28px] sm:px-5">
          <button
            onClick={() => requestAnimatedBack()}
            className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
            <span>返回</span>
          </button>
          <div className="mt-2 flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">在线书库</span>
            <span className="text-muted-foreground/60">/</span>
            <span className="max-w-[300px] truncate font-medium text-foreground">
              {book?.name || '网络书籍'}
            </span>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
          </div>
        ) : error || !book ? (
          <div className="rounded-[28px] app-glass px-5 py-16 text-center sm:rounded-[32px] sm:px-8">
            <p className="text-lg font-semibold text-foreground">无法加载书籍</p>
            <p className="mt-2 text-sm text-muted-foreground">{error || '未找到该书籍。'}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-6 md:flex-row md:gap-10">
            <div className="mx-auto flex w-full max-w-[260px] shrink-0 flex-col items-stretch md:mx-0 md:w-[240px] md:items-start">
              <div className="w-full overflow-hidden rounded-[24px] border border-amber-950/10 bg-white book-cover-shadow md:w-[220px]">
                <div className="relative flex aspect-[2/3] items-center justify-center bg-muted/60">
                  {coverUrl ? (
                    <img src={coverUrl} alt={book.name || '封面'} className="h-full w-full object-cover" />
                  ) : (
                    <BookOpen className="h-16 w-16 text-muted-foreground/40" />
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="relative mt-5 inline-flex h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-primary text-sm font-semibold text-primary-foreground shadow-md transition-all duration-200 hover:bg-primary/90 active:scale-[0.98] disabled:opacity-80 md:mt-6 md:w-[220px]"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                {saving ? (saveProgress ? `保存中 ${saveProgress.percent}%` : '保存中…') : '保存到书库'}
              </button>

              {!saving && (
                <div className="mt-3 w-full md:w-[220px]">
                  <div className="flex flex-wrap gap-1.5">
                    {(['txt', 'epub'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setFmt(f)}
                        className={`h-7 rounded-lg border px-2.5 text-xs font-medium transition-all ${
                          fmt === f
                            ? 'border-primary/30 bg-primary/10 text-primary'
                            : 'border-border/40 bg-muted/50 text-muted-foreground hover:border-border'
                        }`}
                      >
                        {f.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    保存为 EPUB 需要逐章转换，耗时较长；TXT 保存更快。
                  </p>
                </div>
              )}

              {saving && saveProgress && saveProgress.total > 0 && (
                <div className="mt-3 w-full md:w-[220px]">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-300"
                      style={{ width: `${saveProgress.percent}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {saveProgress.done} / {saveProgress.total} 章节
                  </p>
                </div>
              )}

              {saveError && (
                <p className="mt-3 flex w-full items-start gap-1.5 px-1 text-xs leading-relaxed text-destructive md:w-[220px]">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {saveError}
                </p>
              )}

              {saveDone && (
                <p className="mt-3 flex w-full items-start gap-1.5 px-1 text-xs leading-relaxed text-primary md:w-[220px]">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  已保存到书库，请到书库查看。
                </p>
              )}
            </div>

            <div className="min-w-0 flex-1 rounded-[28px] app-glass px-5 pb-6 pt-5 sm:rounded-[32px] sm:px-7 sm:pb-7 sm:pt-6">
              <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
                {book.name || '未命名书籍'}
              </h1>
              {author && <p className="mt-1 text-base font-medium text-muted-foreground">{author}</p>}
              {metaParts && <p className="mt-1 text-xs text-muted-foreground/80">{metaParts}</p>}
              {book.last_chapter && (
                <p className="mt-2 text-sm text-muted-foreground">最新章节：{book.last_chapter}</p>
              )}

              {book.intro && (
                <>
                  <div className="my-4 border-t border-border/40" />
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <BookOpen className="h-4 w-4 text-primary" />
                    <span>简介</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                    {book.intro}
                  </p>
                </>
              )}

              <div className="mt-6 flex items-center gap-2 rounded-2xl border border-amber-950/10 bg-white/60 px-4 py-3 text-xs text-muted-foreground">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
                保存完成后可在本地书库中查看并阅读这本书。
              </div>
            </div>
          </div>
        )}
      </div>
    </DesktopLayout>
  );
}

export default function NetworkBookPage() {
  return (
    <Suspense
      fallback={
        <DesktopLayout>
          <div className="flex items-center justify-center px-4 py-16 sm:px-8">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground/20 border-t-primary" />
          </div>
        </DesktopLayout>
      }
    >
      <NetworkBookContent />
    </Suspense>
  );
}
