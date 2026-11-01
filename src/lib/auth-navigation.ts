const LOGIN_RETURN_PATHS = new Set([
  '/detail',
  '/library',
  '/search',
  '/shelf',
  '/downloads',
  '/network-book',
]);
const LOCAL_ORIGIN = 'https://moke.local';
const UNSAFE_ROUTE_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

/** Only explicit authentication failures should interrupt an initiated action. */
export function isLoginRequiredError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  if (code === 'user.need_login' || code === 'online.auth_required') return true;
  if (status === 401) return true;
  // Compatibility with older download and comic errors without a status field.
  return error instanceof Error && [
    'user.need_login', 'online.auth_required', 'http.401', 'comic.http.401',
  ].includes(error.message);
}

/** Login may return to a known host page, never a server or embedded document. */
export function getSafeLoginReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/shelf';
  try {
    if (UNSAFE_ROUTE_CHARACTERS.test(value) || UNSAFE_ROUTE_CHARACTERS.test(decodeURIComponent(value))) return '/shelf';
    const url = new URL(value, LOCAL_ORIGIN);
    if (url.origin !== LOCAL_ORIGIN || !LOGIN_RETURN_PATHS.has(url.pathname)) return '/shelf';
    // Reject normalized dot segments and encoded path separators rather than
    // silently converting an untrusted path into an allowed one.
    if (url.pathname !== value.split(/[?#]/, 1)[0]) return '/shelf';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return '/shelf';
  }
}

export function buildLoginHref(returnTo: string): string {
  return `/login?returnTo=${encodeURIComponent(getSafeLoginReturnTo(returnTo))}`;
}

interface LoginSessionIdentity {
  serverUrl: string;
  sessionRevision: number;
}

/**
 * Capture the initiating page/session before an asynchronous read or download.
 * A late authentication error must not interrupt another page or newer login.
 * Call the returned getter only for an explicit authentication failure.
 */
export function captureLoginNavigation(
  requestServerUrl: string,
  readSession: () => LoginSessionIdentity,
  readRoute: () => string = () => `${window.location.pathname}${window.location.search}`,
): () => string | null {
  const { serverUrl, sessionRevision } = readSession();
  const route = readRoute();
  const href = buildLoginHref(route);
  return () => {
    const current = readSession();
    return requestServerUrl === serverUrl && current.serverUrl === serverUrl
      && current.sessionRevision === sessionRevision && readRoute() === route
      ? href : null;
  };
}
