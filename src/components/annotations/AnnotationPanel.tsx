'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, Highlighter, LoaderCircle, MapPin, MessageSquareText, Plus, RefreshCw, StickyNote, X } from 'lucide-react';
import { getErrorMessage, MokeApiError, request } from '@/lib/api';
import {
  annotationSourceNames,
  fetchBookAnnotations,
  isAnnotationApiUnsupported,
  newMokeAnnotationClientId,
  TALEBOOK_ANNOTATION_CONTRACT,
  upsertBookAnnotation,
  type AnnotationType,
  type BookAnnotation,
} from '@/lib/annotations';

interface AnnotationPanelProps {
  bookId: string;
  serverUrl: string;
  downloaded: boolean;
  onLocate: (annotation: BookAnnotation) => Promise<void>;
  onAuthRequired: () => void;
}

type LoadState = 'loading' | 'ready' | 'error' | 'unsupported' | 'auth-required';

const TYPE_META: Record<AnnotationType, { label: string; icon: typeof StickyNote }> = {
  highlight: { label: '高亮', icon: Highlighter },
  note: { label: '笔记', icon: StickyNote },
  bookmark: { label: '书签', icon: Bookmark },
  chapter_comment: { label: '章评', icon: MessageSquareText },
};

const SOURCE_LABELS: Record<string, string> = {
  talebook: 'Talebook',
  moke: 'Moke',
  calibre: 'Calibre',
  weread: '微信读书',
  readwise: 'Readwise',
  brs: 'BRS',
};

export function AnnotationPanel({
  bookId,
  serverUrl,
  downloaded,
  onLocate,
  onAuthRequired,
}: AnnotationPanelProps) {
  const [annotations, setAnnotations] = useState<BookAnnotation[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [showComposer, setShowComposer] = useState(false);
  const [chapter, setChapter] = useState('');
  const [content, setContent] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const draftClientIdRef = useRef('');
  const loadSequenceRef = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    setLoadState('loading');
    setErrorMessage('');
    try {
      const items = await fetchBookAnnotations(request, serverUrl, bookId);
      if (sequence !== loadSequenceRef.current) return;
      setAnnotations(items);
      setLoadState('ready');
    } catch (error) {
      if (sequence !== loadSequenceRef.current) return;
      if (error instanceof MokeApiError && error.code === 'user.need_login') {
        setLoadState('auth-required');
        onAuthRequired();
        return;
      }
      if (isAnnotationApiUnsupported(error)) {
        setLoadState('unsupported');
        return;
      }
      setErrorMessage(getErrorMessage(error, '暂时无法读取笔记，请检查网络后重试。'));
      setLoadState('error');
    }
  }, [bookId, onAuthRequired, serverUrl]);

  useEffect(() => {
    void load();
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [load]);

  const sources = useMemo(() => {
    const names = annotations.flatMap(annotationSourceNames);
    return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
  }, [annotations]);

  useEffect(() => {
    if (sourceFilter !== 'all' && !sources.includes(sourceFilter)) {
      setSourceFilter('all');
    }
  }, [sourceFilter, sources]);

  const visibleAnnotations = useMemo(() => {
    if (sourceFilter === 'all' || !sources.includes(sourceFilter)) return annotations;
    return annotations.filter((annotation) => annotationSourceNames(annotation).includes(sourceFilter));
  }, [annotations, sourceFilter, sources]);

  const saveNote = async () => {
    const trimmedContent = content.trim();
    if (!trimmedContent || saving) return;
    if (!draftClientIdRef.current) draftClientIdRef.current = newMokeAnnotationClientId();

    setSaving(true);
    setSaveError('');
    try {
      const result = await upsertBookAnnotation(request, serverUrl, bookId, {
        annotation_type: 'note',
        client_id: draftClientIdRef.current,
        chapter: chapter.trim(),
        content: trimmedContent,
        is_private: isPrivate,
      });
      // Invalidate a GET that started before this POST. Otherwise its stale
      // snapshot could arrive last and erase the newly saved note from the UI.
      loadSequenceRef.current += 1;
      setAnnotations((current) => {
        const remaining = current.filter((item) => item.id !== result.annotation.id);
        return [...remaining, result.annotation];
      });
      setChapter('');
      setContent('');
      setIsPrivate(true);
      setShowComposer(false);
      draftClientIdRef.current = '';
    } catch (error) {
      if (error instanceof MokeApiError && error.code === 'user.need_login') {
        setLoadState('auth-required');
        onAuthRequired();
        return;
      }
      setSaveError(getErrorMessage(error, '笔记保存失败；草稿已保留，可直接重试。'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-6 rounded-[28px] app-glass px-5 py-5 sm:rounded-[32px] sm:px-7 sm:py-6" aria-labelledby="annotations-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="annotations-title" className="flex items-center gap-2 text-base font-semibold text-foreground">
            <StickyNote className="h-4 w-4 text-primary" />
            笔记与标注
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">来源可追溯；删除同步暂未启用，不会静默移除任一端数据。</p>
        </div>
        {loadState === 'ready' && (
          <button
            type="button"
            onClick={() => setShowComposer((value) => !value)}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-primary/25 bg-primary/10 px-3 text-xs font-semibold text-primary transition hover:bg-primary/15"
          >
            {showComposer ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {showComposer ? '取消' : '新增笔记'}
          </button>
        )}
      </div>

      {showComposer && (
        <div className="mt-4 rounded-2xl border border-border/60 bg-background/70 p-4">
          <label className="block text-xs font-medium text-foreground">
            章节（可选）
            <input
              value={chapter}
              onChange={(event) => setChapter(event.target.value)}
              maxLength={500}
              className="mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary"
              placeholder="例如：第一章"
            />
          </label>
          <label className="mt-3 block text-xs font-medium text-foreground">
            笔记
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              rows={3}
              className="mt-1.5 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              placeholder="写下你的想法"
            />
          </label>
          <label className="mt-3 flex items-center gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(event) => setIsPrivate(event.target.checked)}
              className="h-4 w-4 rounded border-border"
            />
            设为私有（私有笔记不会同步到外部来源）
          </label>
          {saveError && <p className="mt-3 text-xs text-destructive" role="alert">{saveError}</p>}
          <button
            type="button"
            onClick={saveNote}
            disabled={!content.trim() || saving}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
          >
            {saving && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
            {saving ? '保存中' : saveError ? '重试保存' : '保存笔记'}
          </button>
        </div>
      )}

      {loadState === 'loading' && (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" /> 正在同步笔记…
        </div>
      )}

      {loadState === 'unsupported' && (
        <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-foreground">
          当前 Talebook 版本不支持 Moke 笔记联动，需要服务端契约 <code className="text-xs">{TALEBOOK_ANNOTATION_CONTRACT}</code>。
        </div>
      )}

      {loadState === 'auth-required' && (
        <div className="mt-4 rounded-2xl border border-border bg-background p-4 text-sm text-foreground" role="status">
          登录状态已失效，正在前往登录页…
        </div>
      )}

      {loadState === 'error' && (
        <div className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/10 p-4">
          <p className="text-sm text-foreground" role="alert">{errorMessage}</p>
          <p className="mt-1 text-xs text-muted-foreground">本次失败不会修改远端或本地笔记。</p>
          <button type="button" onClick={() => void load()} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline">
            <RefreshCw className="h-3.5 w-3.5" /> 重试
          </button>
        </div>
      )}

      {loadState === 'ready' && annotations.length === 0 && !showComposer && (
        <p className="py-10 text-center text-sm text-muted-foreground">这本书还没有笔记或标注。</p>
      )}

      {loadState === 'ready' && annotations.length > 0 && (
        <>
          {sources.length > 1 && (
            <div className="mt-4 flex flex-wrap gap-2" aria-label="按来源筛选">
              <FilterButton active={sourceFilter === 'all'} onClick={() => setSourceFilter('all')}>全部来源</FilterButton>
              {sources.map((source) => (
                <FilterButton key={source} active={sourceFilter === source} onClick={() => setSourceFilter(source)}>
                  {sourceLabel(source)}
                </FilterButton>
              ))}
            </div>
          )}

          <div className="mt-4 space-y-3">
            {visibleAnnotations.map((annotation) => (
              <AnnotationCard
                key={annotation.id}
                annotation={annotation}
                downloaded={downloaded}
                onLocate={onLocate}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function AnnotationCard({
  annotation,
  downloaded,
  onLocate,
}: {
  annotation: BookAnnotation;
  downloaded: boolean;
  onLocate: (annotation: BookAnnotation) => Promise<void>;
}) {
  const meta = TYPE_META[annotation.annotation_type];
  const Icon = meta.icon;
  const failedSources = annotation.sources.filter((source) => source.source_sync_status === 'failed');
  const sourcePositions = Array.from(new Set(
    annotation.sources.map((source) => source.source_position).filter((value): value is string => Boolean(value)),
  ));

  return (
    <article className="rounded-2xl border border-border/60 bg-background/65 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-lg bg-muted px-2 py-1 text-[11px] font-semibold text-foreground">
            <Icon className="h-3 w-3" /> {meta.label}
          </span>
          {annotationSourceNames(annotation).map((source) => (
            <span key={source} className="rounded-lg border border-border/60 px-2 py-1 text-[11px] text-muted-foreground">
              来源：{sourceLabel(source)}
            </span>
          ))}
          {annotation.is_private && <span className="text-[11px] text-muted-foreground">仅自己可见</span>}
        </div>
        <span className="text-[11px] text-muted-foreground">{formatDate(annotation.updated_at || annotation.created_at)}</span>
      </div>

      {annotation.chapter && <p className="mt-3 text-xs font-semibold text-foreground">{annotation.chapter}</p>}
      {!annotation.cfi && sourcePositions.length > 0 && (
        <p className="mt-1 text-[11px] text-muted-foreground">来源位置：{sourcePositions.join(' · ')}</p>
      )}
      {annotation.quote_text && (
        <blockquote className="mt-2 border-l-2 border-primary/35 pl-3 text-sm leading-relaxed text-muted-foreground">{annotation.quote_text}</blockquote>
      )}
      {annotation.content && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{annotation.content}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        {annotation.cfi ? (
          <button
            type="button"
            disabled={!downloaded}
            onClick={() => void onLocate(annotation)}
            className="inline-flex items-center gap-1 font-semibold text-primary hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
            title={downloaded ? '在阅读器中定位' : '请先下载书籍'}
          >
            <MapPin className="h-3.5 w-3.5" /> {downloaded ? '精确定位' : '下载后可定位'}
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
            <MapPin className="h-3.5 w-3.5" /> 无精确位置，已按章节展示
          </span>
        )}
        {failedSources.length > 0 && (
          <span className="text-destructive">
            {failedSources.length} 个来源同步失败，可在 Talebook 插件执行记录中重试
          </span>
        )}
      </div>
    </article>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition ${active ? 'border-primary/35 bg-primary/10 text-primary' : 'border-border/60 text-muted-foreground hover:bg-muted'}`}
    >
      {children}
    </button>
  );
}

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source;
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(date);
}
