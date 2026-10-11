import { retryOnlineRead } from './online-retry.ts';

type RequestLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface ComicPage {
  id: string;
  index: number;
  width: number;
  height: number;
  mimeType: string;
}
export interface ComicManifest {
  id: string;
  title: string;
  revision: string;
  pages: ComicPage[];
}
export interface ComicProgress {
  kind: 'comic';
  version: 1;
  pageId: string;
  pageIndex: number;
  percent: number;
  completed: boolean;
}

export class ComicError extends Error {}
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);
const MAX_PAGE_BYTES = 32 * 1024 * 1024;

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new ComicError('comic.response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new ComicError('comic.response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  if (!size) throw new ComicError('comic.response');
  return chunks;
}

export function comicErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (/login|auth|401/.test(code)) return '登录状态已失效，请返回并重新登录。';
  if (/permission|inactive|403/.test(code)) return '当前账号没有阅读这本漫画的权限，请联系书库管理员。';
  if (/404|book_not_found/.test(code)) return '漫画不存在或服务器尚未提供漫画阅读接口，请检查书库版本。';
  if (/media_type|container_missing|415/.test(code)) return '服务器尚未将本书识别为受支持的漫画容器，请在书库中检查类型和格式。';
  if (/stale|revision|409/.test(code)) return '漫画文件已更新，请重新打开以加载最新页面。';
  return '漫画加载失败，请检查连接或文件是否损坏，然后重试。';
}

export function parseComicManifest(value: unknown, bookId: string): ComicManifest {
  const data = value as Record<string, unknown> | null;
  if (!data || data.contract_version !== 1 || String(data.book_id) !== bookId
    || typeof data.title !== 'string' || typeof data.revision !== 'string'
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.revision)
    || !Array.isArray(data.pages) || !data.pages.length || data.pages.length > 20000
    || data.pages_count !== data.pages.length) throw new ComicError('comic.manifest');
  const ids = new Set<string>();
  const pages = [...data.pages].sort((a, b) => a.index - b.index).map((page, index) => {
    if (!page || page.index !== index || typeof page.id !== 'string' || !page.id || ids.has(page.id)
      || !Number.isSafeInteger(page.width) || page.width <= 0 || page.width > 40000
      || !Number.isSafeInteger(page.height) || page.height <= 0 || page.height > 40000 || page.width * page.height > 40000000
      || !IMAGE_TYPES.has(page.mime_type)) throw new ComicError('comic.manifest');
    ids.add(page.id);
    // Never consume the server's URL/token. Construct a page-scoped path and
    // use the host session instead; credentials cannot reach the reader DOM.
    return { id: page.id, index, width: page.width, height: page.height, mimeType: page.mime_type };
  });
  return { id: `${bookId}:${data.revision}`, title: data.title, revision: data.revision, pages };
}

export function comicProgress(manifest: ComicManifest, pageIndex: number): ComicProgress {
  const index = Math.min(manifest.pages.length - 1, Math.max(0, Math.trunc(pageIndex) || 0));
  return { kind: 'comic', version: 1, pageId: manifest.pages[index].id, pageIndex: index,
    percent: Math.round((index + 1) * 10000 / manifest.pages.length) / 100,
    completed: index === manifest.pages.length - 1 };
}

export function restoreComicPage(manifest: ComicManifest, value: unknown): number {
  const p = value as Partial<ComicProgress> | null;
  if (p?.kind !== 'comic' || p.version !== 1 || !Number.isSafeInteger(p.pageIndex)) return 0;
  const byId = manifest.pages.findIndex(page => page.id === p.pageId);
  return byId >= 0 ? byId : comicProgress(manifest, p.pageIndex!).pageIndex;
}

export function createComicApi(request: RequestLike, serverUrl: string, bookId: string, signal: AbortSignal) {
  const server = new URL(serverUrl);
  if (!['http:', 'https:'].includes(server.protocol) || server.username || server.password
    || server.search || server.hash || !/^[1-9]\d*$/.test(bookId)) throw new ComicError('comic.target');
  const base = `${server.href.replace(/\/$/, '')}/api/book/${bookId}/comic`;
  async function response(path: string, signal: AbortSignal, init?: RequestInit): Promise<Response> {
    const url = `${base}/${path}`;
    const options = { ...init, credentials: 'include', redirect: 'error', maxRedirections: 0, signal } as RequestInit;
    const result = await request(url, options);
    if (!result.ok || result.redirected || result.url !== url) {
      await result.body?.cancel().catch(() => undefined);
      throw new ComicError(`comic.http.${result.status}`);
    }
    return result;
  }
  async function json(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    return retryOnlineRead(async requestSignal => {
      const result = await response(path, requestSignal, init);
      if (!result.headers.get('content-type')?.includes('application/json')) throw new ComicError('comic.response');
      const chunks = await readBoundedBody(result, 8 * 1024 * 1024);
      const data = JSON.parse(await new Blob(chunks as BlobPart[]).text());
      if (data?.err !== 'ok') throw new ComicError(typeof data?.err === 'string' ? data.err : 'comic.response');
      return data;
    }, () => false, signal);
  }
  return {
    manifest: async () => parseComicManifest(await json('pages'), bookId),
    progress: async () => (await json('progress')).progress,
    save: async (progress: ComicProgress) => {
      await json('progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ progress }) });
    },
    page: async (manifest: ComicManifest, index: number) => retryOnlineRead(async requestSignal => {
      if (!Number.isSafeInteger(index) || !manifest.pages[index]) throw new ComicError('comic.page');
      const result = await response(`pages/${index}?revision=${encodeURIComponent(manifest.revision)}`, requestSignal);
      const mime = result.headers.get('content-type')?.split(';')[0].trim().toLowerCase() || '';
      if (!IMAGE_TYPES.has(mime) || mime !== manifest.pages[index].mimeType
        || Number(result.headers.get('content-length')) > MAX_PAGE_BYTES) {
        await result.body?.cancel().catch(() => undefined);
        throw new ComicError('comic.image');
      }
      const chunks = await readBoundedBody(result, MAX_PAGE_BYTES);
      return new Blob(chunks as BlobPart[], { type: mime });
    }, () => false, signal),
  };
}

/** A single writer coalesces rapid turns; an old failed save cannot replace a newer page. */
export class ComicProgressWriter {
  private pending?: ComicProgress;
  private running?: Promise<void>;
  private save: (progress: ComicProgress) => Promise<void>;
  constructor(save: (progress: ComicProgress) => Promise<void>) { this.save = save; }
  queue(progress: ComicProgress) { this.pending = progress; }
  flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.pending) {
        const next = this.pending;
        this.pending = undefined;
        try { await this.save(next); }
        catch (error) { this.pending ??= next; throw error; }
      }
    })().finally(() => { this.running = undefined; });
    return this.running;
  }
}
