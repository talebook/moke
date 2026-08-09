/**
 * 网络书（在线书库）相关的纯逻辑，与 DOM / `@/` 别名无关，便于 Node 单测。
 *
 * 上层 `network-books.ts`（client 侧）负责调用服务器 API 并把 `fetchStatus`
 * 绑定到 `pollNetworkSave`；本文件只做 URL 构造、状态轮询和搜索结果归一化。
 */

export interface NetworkSearchBook {
  title?: string;
  name?: string;
  author?: string;
  authors?: string | Array<{ name: string }>;
  book_url: string;
  cover_url?: string;
  img?: string;
  thumb?: string;
  source_id?: number;
  source_name?: string;
}

/** 按源分组的搜索结果条目（`{ source_id, source_name, books/items }`）。 */
export interface NetworkSearchGroupResult {
  source_id?: number;
  source_name?: string;
  books?: NetworkSearchBook[];
  items?: NetworkSearchBook[];
}

/** 搜索结果数组中的单个条目：分组对象、裸书对象，或裸数组。 */
export type NetworkSearchResultEntry = NetworkSearchGroupResult | NetworkSearchBook | NetworkSearchBook[];

export function buildNetworkBookHref(sourceId: number, bookUrl: string): string {
  const params = new URLSearchParams({
    source_id: String(sourceId),
    book_url: bookUrl,
  });
  return `/network-book?${params.toString()}`;
}

/** 网络书（在线书库）通用字段。 */
export interface NetworkBook {
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

/** 网络搜索状态查询（`/api/network/search/status`）的归一化响应。 */
export interface NetworkSearchStatusResponse {
  err?: string;
  msg?: string;
  results?: Array<
    | { source_id?: number; source_name?: string; books?: NetworkBook[]; items?: NetworkBook[] }
    | NetworkBook
  >;
  finished?: boolean;
}

/**
 * 把搜索结果扁平化为带 `source_id` / `source_name` 的书籍列表。
 *
 * 服务器实际只返回分组形态（talebook `SearchTaskService.get_status` 仅汇总
 * `state == "done"` 且 `books` 非空的源）；裸书 / 裸数组分支仅为归一化入口的防御，
 * 服务器不提供整体源信息，无源可补，保持原样透传。
 *
 * 条目有三种形态，统一处理：
 * - 分组对象 `{ source_id, source_name, books/items }`：展开其书籍，缺省时补
 *   分组携带的源信息；
 * - 裸数组：逐项透传；
 * - 裸书对象：须带书字段（`book_url` / `title` / `name`）才算书，保留书籍自身
 *   的源信息；否则视为占位对象（如仅有 `source_id`/`source_name` 的空分组）丢弃，
 *   避免渲染成点不开的幽灵卡片。
 *
 * 运行时 `results` 来自未校验的 JSON，非数组时安全返回空数组。
 */
export function flattenNetworkSearchResults(
  results: NetworkSearchResultEntry[] | undefined,
): NetworkSearchBook[] {
  if (!Array.isArray(results)) return [];
  return results.flatMap((r) => {
    if (Array.isArray(r)) {
      return r;
    }
    if (typeof r === 'object' && r !== null) {
      const group = r as NetworkSearchGroupResult;
      const items = group.books || group.items;
      if (Array.isArray(items)) {
        return items.map((b) => ({
          ...b,
          source_id: b.source_id ?? group.source_id,
          source_name: b.source_name ?? group.source_name,
        }));
      }
      const book = r as NetworkSearchBook;
      if (!book.book_url && !book.title && !book.name) return [];
      return [book];
    }
    return [];
  });
}

/**
 * 解析 URL 参数中的 `source_id`。空串 / 缺失 / 非数字 / 非整数都返回 `null`，
 * 避免把 `Number('abc')` 的 `NaN` 或 `Number('12.5')` 的小数透传给服务器
 * （书源 id 是数据库整数）。
 */
export function parseNetworkSourceId(raw: string | null): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}
/** `/api/network/save/status` 的归一化响应（`readApiJson` 返回的原始字段）。 */
export interface NetworkSaveStatusResponse {
  err?: string;
  msg?: string;
  found?: boolean;
  status?: string;
  progress?: number;
  done?: number;
  total?: number;
  book_id?: number;
  error?: string;
}

/** 保存到本地书库的轮询状态：终态为 completed / failed / lost / timeout / aborted。 */
export type NetworkSaveState =
  | { status: 'running'; done: number; total: number; progress: number }
  | { status: 'completed'; bookId?: number }
  | { status: 'failed'; error: string }
  | { status: 'lost' }
  | { status: 'timeout' }
  | { status: 'aborted' };

/** 服务器显式终态之外的 status 取值（pending / queued 等）视为未知，按 miss 容忍。 */
const KNOWN_TERMINAL_OR_RUNNING = ['running', 'completed', 'failed'] as const;

type KnownSaveStatus = (typeof KNOWN_TERMINAL_OR_RUNNING)[number];

function isKnownSaveStatus(
  status: NetworkSaveStatusResponse | null,
): status is NetworkSaveStatusResponse & { status: KnownSaveStatus } {
  return (
    status != null &&
    status.found === true &&
    status.status != null &&
    (KNOWN_TERMINAL_OR_RUNNING as readonly string[]).includes(status.status)
  );
}

/** 轮询总时长上限（默认 10 分钟），超时后返回 `timeout`，避免任务卡死在 running 时无限轮询。 */
export const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 轮询网络书保存任务直到终态。
 *
 * - `!found`、`fetchStatus` 抛错或 status 为未知取值（pending/queued/字段缺失）各计一次
 *   miss，连续 `maxMisses` 次判 `lost`（容忍瞬时错误 / 任务注册竞态 / 排队中的任务）。
 * - `running` 时通过 `onUpdate` 回报进度，然后 `sleep` 后继续。
 * - `completed` / `failed` 立即返回。
 * - 总耗时超过 `timeoutMs` 返回 `timeout`；`signal` 被中止返回 `aborted`（组件卸载时可取消）。
 */
export async function pollNetworkSave({
  fetchStatus,
  intervalMs = 1500,
  maxMisses = 3,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  signal,
  sleep = defaultSleep,
  onUpdate,
}: {
  fetchStatus: (signal?: AbortSignal) => Promise<NetworkSaveStatusResponse | null>;
  intervalMs?: number;
  maxMisses?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  onUpdate?: (state: NetworkSaveState) => void;
}): Promise<NetworkSaveState> {
  const startedAt = Date.now();
  let misses = 0;

  for (;;) {
    if (signal?.aborted) {
      const aborted: NetworkSaveState = { status: 'aborted' };
      onUpdate?.(aborted);
      return aborted;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const timeout: NetworkSaveState = { status: 'timeout' };
      onUpdate?.(timeout);
      return timeout;
    }

    let status: NetworkSaveStatusResponse | null;
    try {
      status = await fetchStatus(signal);
    } catch {
      status = null;
    }

    if (!isKnownSaveStatus(status)) {
      misses += 1;
      if (misses >= maxMisses) {
        const lost: NetworkSaveState = { status: 'lost' };
        onUpdate?.(lost);
        return lost;
      }
      await sleep(intervalMs);
      continue;
    }

    misses = 0;

    if (status.status === 'running') {
      const running: NetworkSaveState = {
        status: 'running',
        done: status.done ?? 0,
        total: status.total ?? 0,
        progress: status.progress ?? 0,
      };
      onUpdate?.(running);
      await sleep(intervalMs);
      continue;
    }

    if (status.status === 'completed') {
      const completed: NetworkSaveState = {
        status: 'completed',
        bookId: status.book_id ?? undefined,
      };
      onUpdate?.(completed);
      return completed;
    }

    const failed: NetworkSaveState = { status: 'failed', error: status.error ?? '' };
    onUpdate?.(failed);
    return failed;
  }
}

/**
 * 轮询网络搜索任务直到 `finished`，或达到 `maxAttempts` 上限，或收到取消信号。
 *
 * - 每次轮询返回的中间结果通过 `onPartial` 回调上报（由调用方决定是否回写 UI）。
 * - `fetchStatus` 抛错会向上传播（调用方据此提示错误并停止，与原实现一致）。
 * - `signal` 已中止时，在 sleep 前后与 `fetchStatus` 之后都会提前返回 `null`，
 *   调用方据此判断是"取消"而不是"失败"，从而避免陈旧结果覆盖 / 后台空转。
 */
export async function pollNetworkSearch({
  fetchStatus,
  signal,
  intervalMs = 1000,
  maxAttempts = 60,
  sleep = defaultSleep,
  onPartial,
}: {
  fetchStatus: () => Promise<NetworkSearchStatusResponse | null>;
  signal?: AbortSignal;
  intervalMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  onPartial?: (books: NetworkBook[]) => void;
}): Promise<NetworkSearchStatusResponse | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) return null;
    await sleep(intervalMs);
    if (signal?.aborted) return null;

    const status = await fetchStatus();
    if (signal?.aborted) return null;
    if (!status) continue;

    const books = flattenNetworkSearchResults(status.results);
    if (books.length > 0) onPartial?.(books);

    if (status.finished) return status;
  }
  return null;
}
