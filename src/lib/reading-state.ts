/**
 * 历史记录页的在读/读完归类逻辑。
 *
 * 从 read_history 过滤出「在读(1)」与「读完(2)」。缺 read_state 的书
 * 逐个请求 `/api/book/{id}/readstate`。为避免几百本书时同时发出全部请求
 * （N+1 请求风暴），做了两件事：
 *
 * - 并发上限：同时最多 READ_STATE_CONCURRENCY 个请求，其余排队。
 * - 会话内缓存：同一次会话内按 serverUrl+bookId 缓存结果（5 分钟 TTL），
 *   重复进入历史页不再重复请求。
 */

export interface ReadingStateItem {
  id: string | number;
  state?: {
    read_state?: number;
  };
}

export interface ReadingStateGroup<T extends ReadingStateItem = ReadingStateItem> {
  reading: T[];
  finished: T[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const READ_STATE_CONCURRENCY = 6;
const READ_STATE_CACHE_TTL_MS = 5 * 60 * 1000;

const readStateCache = new Map<string, { value: number; ts: number }>();

export function clearReadStateCache() {
  readStateCache.clear();
}

async function fetchReadState(
  fetchLike: FetchLike,
  serverUrl: string,
  bookId: string | number,
): Promise<number> {
  const cacheKey = `${serverUrl}/book/${bookId}`;
  const cached = readStateCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < READ_STATE_CACHE_TTL_MS) {
    return cached.value;
  }

  let state = 0;
  try {
    const res = await fetchLike(`${serverUrl}/api/book/${bookId}/readstate`, {
      credentials: 'include',
    });
    const data = await res.json();
    if (data && data.err === 'ok') {
      state = Number(data.read_state ?? 0) || 0;
    }
  } catch {
    state = 0;
  }

  readStateCache.set(cacheKey, { value: state, ts: Date.now() });
  return state;
}

/**
 * 把历史记录里的书按阅读状态归为「在读 / 读完」两组。
 * 已有 `state.read_state` 的直接使用（不请求网络），缺失的才发起请求，
 * 并发数受 READ_STATE_CONCURRENCY 限制。
 */
export async function filterReadingStateBooks<T extends ReadingStateItem>(
  fetchLike: FetchLike,
  serverUrl: string,
  books: T[],
): Promise<ReadingStateGroup<T>> {
  const states = new Array<number>(books.length).fill(0);
  let cursor = 0;

  async function worker() {
    while (cursor < books.length) {
      const index = cursor++;
      const book = books[index];
      if (typeof book.state?.read_state === 'number') {
        states[index] = book.state.read_state;
      } else {
        states[index] = await fetchReadState(fetchLike, serverUrl, book.id);
      }
    }
  }

  const poolSize = Math.min(READ_STATE_CONCURRENCY, books.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return {
    reading: books.filter((_, index) => states[index] === 1),
    finished: books.filter((_, index) => states[index] === 2),
  };
}
