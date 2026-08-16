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
  source_name?: string;
  source_connection_id?: string;
  source_annotation_id?: string;
  source_run_id?: string;
  source_position?: string;
  source_raw_hash?: string;
  source_updated_at?: string;
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

const DEFAULT_RETRY_OPTIONS: Required<AnnotationRetryOptions> = {
  maxRetries: 2,
  retryDelayMs: 300,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isAnnotationRetryable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof MokeApiError) {
    if (error.code === 'user.need_login' || error.code === 'permission.denied') return false;
    return error.status !== undefined && TRANSIENT_STATUS.has(error.status);
  }
  return error instanceof TypeError || error instanceof Error && /network|fetch|timeout|offline/i.test(error.message);
}

export function isAnnotationApiUnsupported(error: unknown): boolean {
  return error instanceof MokeApiError && (
    error.code === 'annotation.api.unsupported'
    || error.status === 404
    || ['page.not_found', 'handler.not_found', 'api.not_found'].includes(error.code)
  );
}

export async function withAnnotationRetry<T>(
  operation: () => Promise<T>,
  options: AnnotationRetryOptions = {},
): Promise<T> {
  const retry = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retry.maxRetries || !isAnnotationRetryable(error)) throw error;
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
    return data.annotations.map(normalizeAnnotation);
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
      annotation: normalizeAnnotation(data.annotation),
      created: Boolean(data.created),
      stale_ignored: Boolean(data.stale_ignored),
      conflict_protected: Boolean(data.conflict_protected),
      sync_enqueued: Boolean(data.sync_enqueued),
    };
  }, options);
}

export async function upsertBookAnnotations(
  requestLike: RequestLike,
  serverUrl: string,
  bookId: string | number,
  inputs: AnnotationUpsertInput[],
  options?: AnnotationRetryOptions,
): Promise<AnnotationBatchResult> {
  const settled = await Promise.allSettled(
    inputs.map((input) => upsertBookAnnotation(requestLike, serverUrl, bookId, input, options)),
  );
  const result: AnnotationBatchResult = { succeeded: [], failed: [] };

  settled.forEach((item, index) => {
    if (item.status === 'fulfilled') {
      result.succeeded.push(item.value);
    } else {
      result.failed.push({
        input: inputs[index],
        error: item.reason,
        retryable: isAnnotationRetryable(item.reason),
      });
    }
  });
  return result;
}

/**
 * Produce a deterministic, contract-safe client id for a local annotation.
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
): ReadingProgressPayload | null {
  if (!annotation.cfi) return null;
  return {
    schema: 'moke.readest.progress.v1',
    reader: 'readest',
    moke_book_id: String(bookId),
    location: annotation.cfi,
    chapter: annotation.chapter || undefined,
    updated_at: new Date().toISOString(),
  };
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
  const hasClientId = Boolean(input.client_id?.trim());
  const hasSourceName = Boolean(input.source_name?.trim());
  const hasSourceId = Boolean(input.source_annotation_id?.trim());
  const hasAnySourceField = [
    input.source_name,
    input.source_connection_id,
    input.source_annotation_id,
    input.source_run_id,
    input.source_position,
    input.source_raw_hash,
    input.source_updated_at,
  ].some((value) => value !== undefined);
  if (!ANNOTATION_TYPES.includes(input.annotation_type)) {
    throw new MokeApiError('不支持的笔记类型。', 'annotation.type.invalid');
  }
  if (!hasClientId && !hasSourceId) {
    throw new MokeApiError('笔记缺少稳定的幂等标识。', 'annotation.identity.missing');
  }
  if (hasSourceName !== hasSourceId || hasAnySourceField !== hasSourceName || input.source_name?.trim() === 'talebook') {
    throw new MokeApiError('笔记来源标识不完整。', 'annotation.source.invalid');
  }
  if (input.client_id && input.client_id.length > 64) {
    throw new MokeApiError('笔记客户端标识过长。', 'annotation.identity.invalid');
  }
}

function normalizeAnnotation(value: unknown): BookAnnotation {
  if (!isRecord(value)
    || typeof value.id !== 'number'
    || typeof value.book_id !== 'number'
    || typeof value.annotation_type !== 'string'
    || !ANNOTATION_TYPES.includes(value.annotation_type as AnnotationType)
    || typeof value.is_private !== 'boolean'
    || !Array.isArray(value.sources)) {
    throw unsupportedContractError();
  }

  return {
    id: value.id,
    book_id: value.book_id,
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

function unsupportedContractError(): MokeApiError {
  return new MokeApiError(
    `当前 Talebook 服务器未提供兼容的笔记契约（需要 ${TALEBOOK_ANNOTATION_CONTRACT}）。`,
    'annotation.api.unsupported',
  );
}

function asCompatibilityError(error: unknown): unknown {
  if (error instanceof MokeApiError && (
    error.status === 404
    || ['page.not_found', 'handler.not_found', 'api.not_found'].includes(error.code)
  )) {
    return unsupportedContractError();
  }
  return error;
}
