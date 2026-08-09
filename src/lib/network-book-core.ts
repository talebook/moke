/**
 * 网络书（在线书库）相关的纯逻辑，与 DOM / `@/` 别名无关，便于 Node 单测。
 *
 * 上层 `network-books.ts`（client 侧）负责调用服务器 API 并把 `fetchStatus`
 * 绑定到 `pollNetworkSave`；本文件只做 URL 构造和状态轮询。
 */

export function buildNetworkBookHref(sourceId: number, bookUrl: string): string {
  const params = new URLSearchParams({
    source_id: String(sourceId),
    book_url: bookUrl,
  });
  return `/network-book?${params.toString()}`;
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
  fetchStatus: () => Promise<NetworkSaveStatusResponse | null>;
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
      status = await fetchStatus();
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
