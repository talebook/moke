'use client';

import { getErrorMessage, MokeApiError, readApiJson, request } from '@/lib/api';
import { debugLog } from '@/lib/debug-log';
import { readingProgressForPersistence } from '@/lib/reading-progress-payload';
import { useServerStore } from '@/lib/store/server';

export interface ReadingProgressPayload {
  schema: 'moke.readest.progress.v1';
  reader: 'readest';
  moke_book_id: string;
  reader_book_id?: string;
  view_key?: string;
  location?: string;
  section_href?: string;
  chapter?: string;
  page?: number;
  total_pages?: number;
  progress?: number;
  fraction?: number;
  moke_navigation_id?: string;
  moke_navigation_kind?: 'annotation-locate';
  moke_navigation_phase?: 'pending' | 'navigating' | 'complete';
  updated_at: string;
}

interface ReadingProgressResponse {
  err?: string;
  msg?: string;
  progress?: Partial<ReadingProgressPayload>;
  update_time?: string | null;
  [key: string]: unknown;
}

export function normalizeReaderProgressEvent(input: Record<string, unknown>): ReadingProgressPayload | null {
  const mokeBookId = input.moke_book_id;
  if (typeof mokeBookId !== 'string' && typeof mokeBookId !== 'number') return null;

  const page = toNumber(input.page);
  const totalPages = toNumber(input.total_pages);
  const progress = toNumber(input.progress);
  const fraction = toNumber(input.fraction);

  return {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: String(mokeBookId),
    reader_book_id: toStringValue(input.book_id),
    view_key: toStringValue(input.view_key),
    location: toStringValue(input.location),
    section_href: toStringValue(input.section_href),
    chapter: toStringValue(input.chapter),
    page,
    total_pages: totalPages,
    progress,
    fraction,
    moke_navigation_id: toStringValue(input.moke_navigation_id),
    moke_navigation_kind: input.moke_navigation_kind === 'annotation-locate'
      ? 'annotation-locate'
      : undefined,
    moke_navigation_phase: isNavigationPhase(input.moke_navigation_phase)
      ? input.moke_navigation_phase
      : undefined,
    updated_at: new Date().toISOString(),
  };
}

export async function fetchReadingProgress(bookId: string | number, signal?: AbortSignal): Promise<ReadingProgressPayload | null> {
  const { serverUrl, capabilities } = useServerStore.getState();
  if (!serverUrl || capabilities.checkedAt && !capabilities.readingProgressApi) return null;

  try {
    const response = await request(`${serverUrl}/api/book/${bookId}/progress`, {
      signal,
      credentials: 'include',
    });
    const data = await readApiJson<ReadingProgressResponse>(response);
    const progress = data.progress;

    if (!progress || progress.schema !== 'moke.readest.progress.v1') return null;
    return readingProgressForPersistence(progress as ReadingProgressPayload);
  } catch (error) {
    markProgressUnsupported(error);
    debugLog('warn', 'reading-progress', `读取阅读进度失败: ${bookId}`, getErrorMessage(error));
    return null;
  }
}

export async function saveReadingProgress(bookId: string | number, progress: ReadingProgressPayload): Promise<void> {
  const { serverUrl, capabilities } = useServerStore.getState();
  if (!serverUrl || capabilities.checkedAt && !capabilities.readingProgressApi) return;

  try {
    const response = await request(`${serverUrl}/api/book/${bookId}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ progress: readingProgressForPersistence(progress) }),
    });
    await readApiJson<ReadingProgressResponse>(response);
  } catch (error) {
    markProgressUnsupported(error);
    debugLog('warn', 'reading-progress', `保存阅读进度失败: ${bookId}`, getErrorMessage(error));
  }
}

function markProgressUnsupported(error: unknown) {
  if (!(error instanceof MokeApiError)) return;
  if (error.status !== 404 && error.code !== 'page.not_found' && error.code !== 'handler.not_found' && error.code !== 'api.not_found') return;

  const { capabilities, setServerCapabilities } = useServerStore.getState();
  if (!capabilities.readingProgressApi) return;

  setServerCapabilities({
    ...capabilities,
    readingProgressApi: false,
    checkedAt: Date.now(),
  });
}

function toStringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function isNavigationPhase(value: unknown): value is NonNullable<ReadingProgressPayload['moke_navigation_phase']> {
  return value === 'pending' || value === 'navigating' || value === 'complete';
}

function toNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}
