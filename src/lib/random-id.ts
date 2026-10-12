/** Security-sensitive authority must never fall back to Math.random. */
export function secureRandomUUID(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  // getRandomValues is available in many HTTP/older WebViews where randomUUID
  // is absent. Preserve the UUID format used by the reader-return receipt.
  if (typeof crypto?.getRandomValues !== 'function') throw new Error('当前环境不支持安全随机数');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let sequence = 0;
/** Local identities/filenames only: these values do not grant authority. */
export function createLocalId(): string {
  try { return secureRandomUUID(); }
  catch {
    return `local-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}
