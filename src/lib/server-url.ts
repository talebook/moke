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
