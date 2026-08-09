/**
 * 校验字符串是否是合法 http(s) URL。
 *
 * `/access` 页会把 URL 参数 / localStorage 里的服务器地址直接写进 store，
 * 必须拒绝 `javascript:` 等非 http 协议——`new URL(candidate).origin` 对
 * 这类输入返回 `"null"`，会把 serverUrl 设成 `"null"` 导致应用需重连。
 */
export function isHttpUrl(candidate: string): boolean {
  try {
    const protocol = new URL(candidate).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
