/**
 * 校验字符串是否是合法 http(s) URL。
 *
 * `/access` 页会把 URL 参数 / localStorage 里的服务器地址直接写进 store，
 * 必须拒绝 `javascript:` 等非 http 协议——`new URL(candidate).origin` 对
 * 这类输入返回 `"null"`，会把 serverUrl 设成 `"null"` 导致应用需重连。
 */
export function parseHttpUrl(candidate: string): URL | null {
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function isHttpUrl(candidate: string): boolean {
  return parseHttpUrl(candidate) !== null;
}

/** A server is a root HTTP origin. Never silently discard credentials or paths. */
export function normalizeServerAddress(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('请输入服务器地址');
  const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`;
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    throw new Error('请输入有效的服务器地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('服务器地址须使用 HTTP 或 HTTPS');
  }
  // URL parsing collapses dot segments. Reject the supplied path before that
  // normalization can turn /book/.. into an apparently valid root address.
  const authority = absolute.slice(absolute.indexOf('://') + 3);
  const pathStart = authority.search(/[\\/]/);
  const suppliedPath = pathStart < 0 ? '' : authority.slice(pathStart);
  if (url.username || url.password || url.pathname !== '/' || (suppliedPath && suppliedPath !== '/') || url.search || url.hash
    || input.includes('?') || input.includes('#')) {
    throw new Error('请填写服务器根地址，不要包含账号、路径、查询参数或片段');
  }
  return url.origin;
}

/** Match old :80/:443 offline identities without renaming records or files. */
export function sameServerAddress(left: string, right: string): boolean {
  try { return normalizeServerAddress(left) === normalizeServerAddress(right); }
  catch { return left === right; }
}
