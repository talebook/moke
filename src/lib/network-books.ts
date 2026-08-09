/**
 * 网络书（在线书库）的服务器 API 封装。
 *
 * 纯轮询/URL 逻辑在 `network-book-core.ts`（可单测）；本文件负责通过
 * `@/lib/api` 的 `request` 走 Tauri 原生 HTTP（自签名证书 / 登录 cookie）。
 */
import { readApiJson, request } from '@/lib/api';
import {
  pollNetworkSave,
  type NetworkSaveState,
  type NetworkSaveStatusResponse,
} from '@/lib/network-book-core';

export interface NetworkBookDetail {
  name?: string;
  author?: string;
  kind?: string;
  last_chapter?: string;
  intro?: string;
  cover_url?: string;
  word_count?: string;
  book_url?: string;
  toc_url?: string;
}

interface NetworkBookResponse {
  err?: string;
  msg?: string;
  book?: NetworkBookDetail;
  toc_url?: string;
}

interface NetworkSaveResponse {
  err?: string;
  msg?: string;
  tag?: string;
}

/** 拉取网络书详情（`/api/network/book`）。非 ok（含 need_login / js_unsupported）抛 MokeApiError。 */
export async function fetchNetworkBook(
  serverUrl: string,
  sourceId: number,
  bookUrl: string,
): Promise<{ book: NetworkBookDetail; tocUrl?: string }> {
  const params = new URLSearchParams({ source_id: String(sourceId), book_url: bookUrl });
  const response = await request(`${serverUrl}/api/network/book?${params.toString()}`, {
    credentials: 'include',
  });
  const data = await readApiJson<NetworkBookResponse>(response, '网络书籍详情解析失败。');
  return { book: data.book ?? {}, tocUrl: data.toc_url };
}

/** 发起「保存到本地书库」后台任务（`/api/network/save`）。默认存为 epub 以便 readest 阅读。 */
export async function saveNetworkBook(
  serverUrl: string,
  sourceId: number,
  bookUrl: string,
  fmt: 'txt' | 'epub' = 'epub',
): Promise<{ tag?: string; msg?: string }> {
  const response = await request(`${serverUrl}/api/network/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ source_id: sourceId, book_url: bookUrl, fmt, clean: true }),
  });
  const data = await readApiJson<NetworkSaveResponse>(response, '发起保存失败。');
  return { tag: data.tag, msg: data.msg };
}

/** 查询保存任务进度（`/api/network/save/status`）。 */
export async function fetchNetworkSaveStatus(
  serverUrl: string,
  sourceId: number,
  bookUrl: string,
  signal?: AbortSignal,
): Promise<NetworkSaveStatusResponse> {
  const params = new URLSearchParams({ source_id: String(sourceId), book_url: bookUrl });
  const response = await request(`${serverUrl}/api/network/save/status?${params.toString()}`, {
    credentials: 'include',
    signal,
  });
  const data = await readApiJson<NetworkSaveStatusResponse>(response, '查询保存进度失败。');
  return data;
}

export type PollNetworkSaveOptions = {
  intervalMs?: number;
  maxMisses?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  onUpdate?: (state: NetworkSaveState) => void;
};

/** 绑定好 `fetchStatus` 的 `pollNetworkSave`，供详情页 / 右键菜单使用。 */
export function pollNetworkSaveForBook(
  serverUrl: string,
  sourceId: number,
  bookUrl: string,
  options: PollNetworkSaveOptions = {},
): Promise<NetworkSaveState> {
  return pollNetworkSave({
    ...options,
    fetchStatus: (signal) => fetchNetworkSaveStatus(serverUrl, sourceId, bookUrl, signal),
  });
}
