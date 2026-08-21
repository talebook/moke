import { MokeApiError, readApiJson } from './api-core.ts';
import type { ReadingProgressPayload } from './reading-progress';

export const TALEBOOK_ANNOTATION_CONTRACT = 'talebook.annotations.v2' as const;

export const ANNOTATION_TYPES = ['highlight', 'note', 'bookmark', 'chapter_comment'] as const;
export type AnnotationType = (typeof ANNOTATION_TYPES)[number];

export interface AnnotationSource {
  id: number;
  source_name: string;
  source_connection_id: string;
  source_annotation_id: string | null;
  source_run_id: string | null;
  source_position: string | null;
  source_raw_hash: string | null;
  source_updated_at: string | null;
  source_sync_status: string;
  source_synced_at: string | null;
  source_sync_error: string | null;
}

export interface BookAnnotation {
  id: number;
  book_id: number;
  client_id: string | null;
  annotation_type: AnnotationType;
  is_private: boolean;
  cfi: string | null;
  chapter: string;
  quote_text: string;
  content: string;
  color: string;
  author_name: string;
  user_modified_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  sources: AnnotationSource[];
}

export interface AnnotationUpsertInput {
  annotation_type: AnnotationType;
  client_id?: string;
  is_private?: boolean;
  cfi?: string | null;
  chapter?: string;
  quote_text?: string;
  content?: string;
  color?: string;
  author_name?: string;
  source_name?: string | null;
  source_connection_id?: string | null;
  source_annotation_id?: string | null;
  source_run_id?: string | null;
  source_position?: string | null;
  source_raw_hash?: string | null;
  source_updated_at?: string | null;
}

export interface AnnotationUpsertResult {
  annotation: BookAnnotation;
  created: boolean;
  stale_ignored: boolean;
  conflict_protected: boolean;
  sync_enqueued: boolean;
}

export interface AnnotationBatchResult {
  succeeded: AnnotationUpsertResult[];
  failed: Array<{
    input: AnnotationUpsertInput;
    error: unknown;
    retryable: boolean;
  }>;
}

type ApiEnvelope = { err?: string; msg?: string };
type RequestLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AnnotationRetryOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface AnnotationBatchOptions extends AnnotationRetryOptions {
  concurrency?: number;
}

const DEFAULT_RETRY_OPTIONS: Required<AnnotationRetryOptions> = {
  maxRetries: 2,
  retryDelayMs: 300,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const SAFE_WRITE_RETRY_STATUS = new Set([408, 425, 429]);
const DEFAULT_BATCH_CONCURRENCY = 6;
// A hard guardrail for future bulk import/sync callers so one batch cannot
// overwhelm a single-process Talebook server even if configured incorrectly.
const MAX_BATCH_CONCURRENCY = 20;
const TRANSPORT_ERROR_PATTERN = /network|fetch|offline|timed?\s*out|connection (?:refused|reset|closed)|failed to connect|error sending request|dns|socket/i;
const ANNOTATION_LOCATE_SUPPRESSION_TTL_MS = 2 * 60 * 1000;
const annotationLocateSuppressions = new Map<string, {
  serverUrl: string;
  bookId: string;
  expiresAt: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
}>();

export function isAnnotationRetryable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof MokeApiError) {
    if (error.code === 'user.need_login' || error.code === 'permission.denied') return false;
    return error.status !== undefined && TRANSIENT_STATUS.has(error.status);
  }
  return isTransportError(error);
}

function isAnnotationWriteRetryable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof MokeApiError) {
    return error.status !== undefined && SAFE_WRITE_RETRY_STATUS.has(error.status);
  }
  // Retry only when no HTTP response was received (or the server explicitly
  // asks the client to retry via 408/425/429). An arbitrary 5xx can represent a
  // deterministic application failure, so it is surfaced instead of looped.
  // Reusing the same client/source identity keeps transport recovery idempotent.
  return isTransportError(error);
}

export function isAnnotationApiUnsupported(error: unknown): boolean {
  return error instanceof MokeApiError && (
    error.code === 'annotation.api.unsupported'
    || ['page.not_found', 'handler.not_found', 'api.not_found'].includes(error.code)
  );
}

export async function withAnnotationRetry<T>(
  operation: () => Promise<T>,
  options: AnnotationRetryOptions = {},
  shouldRetry: (error: unknown) => boolean = isAnnotationRetryable,
): Promise<T> {
  const retry = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retry.maxRetries || !shouldRetry(error)) throw error;
      await retry.sleep(retry.retryDelayMs * 2 ** attempt);
      attempt += 1;
    }
  }
}

export async function fetchBookAnnotations(
  requestLike: RequestLike,
  serverUrl: string,
  bookId: string | number,
  options?: AnnotationRetryOptions,
): Promise<BookAnnotation[]> {
  return withAnnotationRetry(async () => {
    const response = await requestLike(
      `${serverUrl}/api/book/${encodeURIComponent(String(bookId))}/annotations`,
      { credentials: 'include' },
    );

    let data: ApiEnvelope & { annotations?: unknown };
    try {
      data = await readApiJson(response, '笔记接口响应无效。');
    } catch (error) {
      throw asCompatibilityError(error);
    }

    if (!Array.isArray(data.annotations)) {
      throw unsupportedContractError();
    }
    const annotations: BookAnnotation[] = [];
    for (const value of data.annotations) {
      try {
        annotations.push(normalizeAnnotation(value));
      } catch {
        // One corrupt/older record must not turn a supported endpoint into an
        // "unsupported contract" error or hide all other valid annotations.
      }
    }
    if (data.annotations.length > 0 && annotations.length === 0) {
      throw unsupportedContractError();
    }
    return annotations;
  }, options);
}

export async function upsertBookAnnotation(
  requestLike: RequestLike,
  serverUrl: string,
  bookId: string | number,
  input: AnnotationUpsertInput,
  options?: AnnotationRetryOptions,
): Promise<AnnotationUpsertResult> {
  validateUpsertInput(input);

  return withAnnotationRetry(async () => {
    const response = await requestLike(
      `${serverUrl}/api/book/${encodeURIComponent(String(bookId))}/annotations`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(input),
      },
    );

    let data: ApiEnvelope & Partial<Omit<AnnotationUpsertResult, 'annotation'>> & { annotation?: unknown };
    try {
      data = await readApiJson(response, '笔记保存响应无效。');
    } catch (error) {
      throw asCompatibilityError(error);
    }

    if (!data.annotation) throw unsupportedContractError();
    return {
      annotation: normalizeUpsertAnnotation(data.annotation, input, bookId),
      created: Boolean(data.created),
      stale_ignored: Boolean(data.stale_ignored),
      conflict_protected: Boolean(data.conflict_protected),
      sync_enqueued: Boolean(data.sync_enqueued),
    };
  }, options, isAnnotationWriteRetryable);
}

/**
 * Reserved bulk-sync primitive for future local annotation importers. The UI
 * currently saves one note at a time, but sync jobs need partial-failure
 * reporting and bounded concurrency without reimplementing the v2 contract.
 */
export async function upsertBookAnnotations(
  requestLike: RequestLike,
  serverUrl: string,
  bookId: string | number,
  inputs: AnnotationUpsertInput[],
  options: AnnotationBatchOptions = {},
): Promise<AnnotationBatchResult> {
  const { concurrency = DEFAULT_BATCH_CONCURRENCY, ...retryOptions } = options;
  const requestedConcurrency = Number.isFinite(concurrency)
    ? Math.max(1, Math.floor(concurrency))
    : DEFAULT_BATCH_CONCURRENCY;
  const limit = Math.min(MAX_BATCH_CONCURRENCY, requestedConcurrency);
  const settled: PromiseSettledResult<AnnotationUpsertResult>[] = [];

  for (let index = 0; index < inputs.length; index += limit) {
    const batch = inputs.slice(index, index + limit);
    settled.push(...await Promise.allSettled(
      batch.map((input) => upsertBookAnnotation(requestLike, serverUrl, bookId, input, retryOptions)),
    ));
  }
  const result: AnnotationBatchResult = { succeeded: [], failed: [] };

  settled.forEach((item, index) => {
    if (item.status === 'fulfilled') {
      result.succeeded.push(item.value);
    } else {
      result.failed.push({
        input: inputs[index],
        error: item.reason,
        retryable: isAnnotationWriteRetryable(item.reason),
      });
    }
  });
  return result;
}

/**
 * Produce a deterministic, contract-safe client id for future local sync jobs.
 * Callers should use an immutable local record id as `localId`; repeated syncs
 * of the same record then hit Talebook's `(owner, book, client_id)` upsert key.
 */
export function stableMokeAnnotationClientId(bookId: string | number, localId: string): string {
  const value = `${bookId}\u0000${localId}`;
  const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => hash32(value, seed).toString(16).padStart(8, '0'));
  return `moke-${hashes.join('-')}`;
}

/** Generate once for a new draft and retain it when retrying the same save. */
export function newMokeAnnotationClientId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `moke-${globalThis.crypto.randomUUID()}`;
  }
  return `moke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
}

export function annotationSourceNames(annotation: BookAnnotation): string[] {
  const names = annotation.sources.map((source) => source.source_name).filter(Boolean);
  return names.length > 0 ? Array.from(new Set(names)) : ['talebook'];
}

export function annotationReaderProgress(
  annotation: BookAnnotation,
  bookId: string | number,
  navigationId?: string,
): ReadingProgressPayload | null {
  const cfi = readestAnnotationCfi(annotation.cfi);
  if (!cfi) return null;
  return {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: String(bookId),
    location: cfi,
    chapter: annotation.chapter || undefined,
    moke_navigation_id: navigationId,
    moke_navigation_kind: navigationId ? 'annotation-locate' : undefined,
    updated_at: new Date().toISOString(),
  };
}

export function hasReadestAnnotationLocation(annotation: BookAnnotation): boolean {
  return readestAnnotationCfi(annotation.cfi) !== null;
}

/**
 * Start a one-shot annotation navigation correlation. Readest echoes this id
 * only on startup/restore relocations caused by this navigation; ordinary page
 * turns carry no marker and are persisted immediately, regardless of timing or
 * CFI normalization. The timer is resource cleanup, not a correctness window.
 */
export function beginAnnotationLocateNavigation(
  serverUrl: string,
  bookId: string | number,
): string {
  const navigationId = newAnnotationNavigationId();
  const cleanupTimer = setTimeout(() => {
    annotationLocateSuppressions.delete(navigationId);
  }, ANNOTATION_LOCATE_SUPPRESSION_TTL_MS);
  if (typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) cleanupTimer.unref();
  annotationLocateSuppressions.set(navigationId, {
    serverUrl: normalizeServerUrl(serverUrl),
    bookId: String(bookId),
    expiresAt: Date.now() + ANNOTATION_LOCATE_SUPPRESSION_TTL_MS,
    cleanupTimer,
  });
  return navigationId;
}

export function clearAnnotationLocateProgressSuppression(navigationId: string): void {
  const suppression = annotationLocateSuppressions.get(navigationId);
  if (suppression) clearTimeout(suppression.cleanupTimer);
  annotationLocateSuppressions.delete(navigationId);
}

export function shouldSuppressAnnotationReaderProgress(
  serverUrl: string,
  progress: ReadingProgressPayload,
  now = Date.now(),
): boolean {
  if (
    progress.moke_navigation_kind !== 'annotation-locate'
    || !progress.moke_navigation_id
  ) return false;

  const suppression = annotationLocateSuppressions.get(progress.moke_navigation_id);
  if (!suppression) return false;
  if (now >= suppression.expiresAt) {
    clearAnnotationLocateProgressSuppression(progress.moke_navigation_id);
    return false;
  }
  if (
    suppression.serverUrl !== normalizeServerUrl(serverUrl)
    || suppression.bookId !== progress.moke_book_id
  ) return false;

  if (progress.moke_navigation_phase === 'complete') {
    clearAnnotationLocateProgressSuppression(progress.moke_navigation_id);
  }
  return true;
}

function newAnnotationNavigationId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `annotation-locate-${globalThis.crypto.randomUUID()}`;
  }
  return `annotation-locate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
}

function hash32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function validateUpsertInput(input: AnnotationUpsertInput): void {
  const hasClientId = hasMeaningfulString(input.client_id);
  const hasSourceName = hasMeaningfulString(input.source_name);
  const hasSourceId = hasMeaningfulString(input.source_annotation_id);
  const hasAnySourceField = [
    input.source_name,
    input.source_connection_id,
    input.source_annotation_id,
    input.source_run_id,
    input.source_position,
    input.source_raw_hash,
    input.source_updated_at,
  ].some(hasMeaningfulString);
  if (!ANNOTATION_TYPES.includes(input.annotation_type)) {
    throw new MokeApiError('不支持的笔记类型。', 'annotation.type.invalid');
  }
  if (!hasClientId && !hasSourceId) {
    throw new MokeApiError('笔记缺少稳定的幂等标识。', 'annotation.identity.missing');
  }
  if (hasSourceName !== hasSourceId || hasAnySourceField !== hasSourceName) {
    throw new MokeApiError('笔记来源标识不完整。', 'annotation.source.invalid');
  }
  if (input.client_id && input.client_id.length > 64) {
    throw new MokeApiError('笔记客户端标识过长。', 'annotation.identity.invalid');
  }
}

function normalizeUpsertAnnotation(
  value: unknown,
  input: AnnotationUpsertInput,
  requestedBookId: string | number,
): BookAnnotation {
  try {
    return normalizeAnnotation(value);
  } catch {
    // A successful idempotent POST may return a compact representation even
    // when the GET endpoint uses the full v2 shape. Preserve the committed
    // result by filling optional display fields from the submitted payload.
  }

  if (!isRecord(value)) throw unsupportedContractError();
  const id = finiteNumber(value.id);
  const bookId = finiteNumber(value.book_id) ?? finiteNumber(requestedBookId);
  const annotationType = typeof value.annotation_type === 'string'
    && ANNOTATION_TYPES.includes(value.annotation_type as AnnotationType)
    ? value.annotation_type as AnnotationType
    : input.annotation_type;
  if (id === null || bookId === null || !ANNOTATION_TYPES.includes(annotationType)) {
    throw unsupportedContractError();
  }

  const sources: AnnotationSource[] = [];
  if (Array.isArray(value.sources)) {
    for (const source of value.sources) {
      try {
        sources.push(normalizeSource(source));
      } catch {
        // A malformed optional source must not turn a committed POST into a
        // visible save failure. The next GET can recover the canonical shape.
      }
    }
  }

  return {
    id,
    book_id: bookId,
    client_id: nullableString(value.client_id) ?? nullableString(input.client_id),
    annotation_type: annotationType,
    is_private: typeof value.is_private === 'boolean' ? value.is_private : input.is_private ?? true,
    cfi: fallbackNullableString(value.cfi, input.cfi),
    chapter: fallbackString(value.chapter, input.chapter),
    quote_text: fallbackString(value.quote_text, input.quote_text),
    content: fallbackString(value.content, input.content),
    color: fallbackString(value.color, input.color),
    author_name: fallbackString(value.author_name, input.author_name),
    user_modified_at: nullableString(value.user_modified_at),
    created_at: nullableString(value.created_at),
    updated_at: nullableString(value.updated_at),
    sources,
  };
}

function normalizeAnnotation(value: unknown): BookAnnotation {
  if (!isRecord(value)
    || typeof value.annotation_type !== 'string'
    || !ANNOTATION_TYPES.includes(value.annotation_type as AnnotationType)
    || typeof value.is_private !== 'boolean'
    || !Array.isArray(value.sources)) {
    throw unsupportedContractError();
  }
  const id = finiteNumber(value.id);
  const bookId = finiteNumber(value.book_id);
  if (id === null || bookId === null) throw unsupportedContractError();

  return {
    id,
    book_id: bookId,
    client_id: nullableString(value.client_id),
    annotation_type: value.annotation_type as AnnotationType,
    is_private: value.is_private,
    cfi: nullableString(value.cfi),
    chapter: stringValue(value.chapter),
    quote_text: stringValue(value.quote_text),
    content: stringValue(value.content),
    color: stringValue(value.color),
    author_name: stringValue(value.author_name),
    user_modified_at: nullableString(value.user_modified_at),
    created_at: nullableString(value.created_at),
    updated_at: nullableString(value.updated_at),
    sources: value.sources.map(normalizeSource),
  };
}

function normalizeSource(value: unknown): AnnotationSource {
  if (!isRecord(value)
    || typeof value.id !== 'number'
    || typeof value.source_name !== 'string'
    || typeof value.source_connection_id !== 'string'
    || typeof value.source_sync_status !== 'string') {
    throw unsupportedContractError();
  }
  return {
    id: value.id,
    source_name: value.source_name,
    source_connection_id: value.source_connection_id,
    source_annotation_id: nullableString(value.source_annotation_id),
    source_run_id: nullableString(value.source_run_id),
    source_position: nullableString(value.source_position),
    source_raw_hash: nullableString(value.source_raw_hash),
    source_updated_at: nullableString(value.source_updated_at),
    source_sync_status: value.source_sync_status,
    source_synced_at: nullableString(value.source_synced_at),
    source_sync_error: nullableString(value.source_sync_error),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function fallbackString(value: unknown, fallback: unknown): string {
  return typeof value === 'string' ? value : stringValue(fallback);
}

function fallbackNullableString(value: unknown, fallback: unknown): string | null {
  if (value === null) return null;
  return nullableString(value) ?? nullableString(fallback);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function hasMeaningfulString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTransportError(error: unknown): boolean {
  return error instanceof TypeError
    || error instanceof Error && TRANSPORT_ERROR_PATTERN.test(error.message);
}

function readestAnnotationCfi(value: string | null): string | null {
  if (!value) return null;
  const cfi = value.trim();
  return /^epubcfi\(.+\)$/.test(cfi) ? cfi : null;
}

function normalizeServerUrl(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, '');
}

function unsupportedContractError(): MokeApiError {
  return new MokeApiError(
    `当前 Talebook 服务器未提供兼容的笔记契约（需要 ${TALEBOOK_ANNOTATION_CONTRACT}）。`,
    'annotation.api.unsupported',
  );
}

function asCompatibilityError(error: unknown): unknown {
  if (error instanceof MokeApiError && (
    ['page.not_found', 'handler.not_found', 'api.not_found'].includes(error.code)
  )) {
    return unsupportedContractError();
  }
  return error;
}
