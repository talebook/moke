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

/** 保存到本地书库的轮询状态：终态为 completed / failed / lost。 */
export type NetworkSaveState =
  | { status: 'running'; done: number; total: number; progress: number }
  | { status: 'completed'; bookId: number }
  | { status: 'failed'; error: string }
  | { status: 'lost' };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 轮询网络书保存任务直到终态。
 *
 * - `!found` 或 `fetchStatus` 抛错计一次 miss，连续 `maxMisses` 次判 `lost`
 *   （容忍瞬时错误 / 任务注册竞态；后台任务可能因服务器重启丢失）。
 * - `running` 时通过 `onUpdate` 回报进度，然后 `sleep` 后继续。
 * - `completed` / `failed` 立即返回。
 */
export async function pollNetworkSave({
  fetchStatus,
  intervalMs = 1500,
  maxMisses = 3,
  sleep = defaultSleep,
  onUpdate,
}: {
  fetchStatus: () => Promise<NetworkSaveStatusResponse | null>;
  intervalMs?: number;
  maxMisses?: number;
  sleep?: (ms: number) => Promise<void>;
  onUpdate?: (state: NetworkSaveState) => void;
}): Promise<NetworkSaveState> {
  let misses = 0;

  for (;;) {
    let status: NetworkSaveStatusResponse | null;
    try {
      status = await fetchStatus();
    } catch {
      status = null;
    }

    if (!status || !status.found) {
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
        bookId: status.book_id ?? 0,
      };
      onUpdate?.(completed);
      return completed;
    }

    const failed: NetworkSaveState = { status: 'failed', error: status.error ?? '' };
    onUpdate?.(failed);
    return failed;
  }
}
