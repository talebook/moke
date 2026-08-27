const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'if-modified-since',
  'if-none-match',
  'range',
  'user-agent',
]);

export const MAX_SECURE_REDIRECTS = 5;

/** Return a canonical HTTP(S) origin, without credentials or path data. */
export function normalizeHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function normalizeHttpsOrigin(value: string): string | null {
  const origin = normalizeHttpOrigin(value);
  return origin?.startsWith('https://') ? origin : null;
}

export function isCleartextHttpUrl(value: string): boolean {
  return normalizeHttpOrigin(value)?.startsWith('http://') ?? false;
}

/**
 * Invalid-certificate authorization is exact-origin scoped. Hostname checks are
 * never disabled: a certificate for another hostname must still fail.
 */
export function isInvalidCertificateAllowed(
  requestUrl: string,
  allowedOrigins: readonly string[],
): boolean {
  const requestOrigin = normalizeHttpsOrigin(requestUrl);
  if (!requestOrigin) return false;
  return allowedOrigins.some((origin) => normalizeHttpsOrigin(origin) === requestOrigin);
}

export interface SecureRedirectRequest {
  url: string;
  options: RequestInit;
}

function redirectMethod(status: number, method: string): string {
  if (status === 303 && method !== 'HEAD') return 'GET';
  if ((status === 301 || status === 302) && method === 'POST') return 'GET';
  return method;
}

function stripCrossOriginHeaders(headers: Headers): Headers {
  const safe = new Headers();
  headers.forEach((value, name) => {
    if (CROSS_ORIGIN_SAFE_HEADERS.has(name.toLowerCase())) safe.set(name, value);
  });
  return safe;
}

/**
 * Build the next manually-followed redirect request.
 *
 * Tauri redirects are handled in JS so certificate exemptions can be
 * re-evaluated for every origin. Cross-origin redirects never inherit auth,
 * cookies, custom credential headers, or a request body, and HTTPS downgrade
 * redirects are rejected.
 */
export function buildSecureRedirectRequest(
  currentUrl: string,
  status: number,
  location: string | null,
  options: RequestInit = {},
): SecureRedirectRequest | null {
  if (!REDIRECT_STATUSES.has(status) || !location) return null;

  const current = new URL(currentUrl);
  const target = new URL(location, current);
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('redirect.protocol_blocked');
  if (target.username || target.password) throw new Error('redirect.credentials_blocked');
  if (current.protocol === 'https:' && target.protocol === 'http:') {
    throw new Error('redirect.downgrade_blocked');
  }

  const currentMethod = (options.method || 'GET').toUpperCase();
  const nextMethod = redirectMethod(status, currentMethod);
  const crossOrigin = current.origin !== target.origin;
  const hasReplayableBody = nextMethod !== 'GET' && nextMethod !== 'HEAD' && options.body != null;
  if (crossOrigin && hasReplayableBody) throw new Error('redirect.cross_origin_body_blocked');

  let headers = new Headers(options.headers);
  if (crossOrigin) headers = stripCrossOriginHeaders(headers);
  if (nextMethod === 'GET' || nextMethod === 'HEAD') {
    headers.delete('content-length');
    headers.delete('content-type');
  }

  return {
    url: target.toString(),
    options: {
      ...options,
      method: nextMethod,
      headers,
      body: nextMethod === 'GET' || nextMethod === 'HEAD' ? undefined : options.body,
    },
  };
}
