import { MokeApiError } from './api-core.ts';
import { BOOK_HEADER_WINDOW, hasKnownMobiHeader, isHtmlBookResponsePrefix, isTextBookFormat, normalizeOfflineFormat } from './offline-book-core.ts';

const LOGIN_PATH = /^\/(?:login|signin|sign_in|user\/login|accounts\/login|api\/user\/sign_in)\/?$/i;

/** Recognize a login destination without following it or trusting a different server. */
export function isBookLoginResponse(response: Pick<Response, 'status' | 'url' | 'headers'>, requestedUrl: string): boolean {
  if (response.status === 401) return true;
  const destination = response.status >= 300 && response.status < 400
    ? response.headers.get('location')
    : response.url;
  if (!destination) return false;
  try {
    const expected = new URL(requestedUrl);
    const actual = new URL(destination, expected);
    return actual.origin === expected.origin && !actual.username && !actual.password
      && LOGIN_PATH.test(actual.pathname);
  } catch { return false; }
}

export function bookLoginRequiredError(status?: number): MokeApiError {
  return new MokeApiError('请先登录', 'user.need_login', status);
}

function htmlAttribute(tag: string, name: 'type' | 'action'): string | undefined {
  const pattern = name === 'type'
    ? /\stype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i
    : /\saction\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i;
  const match = pattern.exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] : undefined;
}

/** Only explicit API authentication errors or a recognizable login form qualify. */
export function isBookLoginBody(prefix: Uint8Array, format: string): boolean {
  if (isTextBookFormat(format)) return false;
  const mobi = ['mobi', 'azw', 'azw3', 'prc', 'pdb'].includes(normalizeOfflineFormat(format));
  if (mobi && hasKnownMobiHeader(prefix)) return false;
  const text = new TextDecoder().decode(prefix.subarray(0, BOOK_HEADER_WINDOW), { stream: true }).trim();
  // A complete, explicit login envelope is actionable even if the transport
  // later fails. Other JSON-looking Palm titles still wait for their header.
  try {
    const payload: unknown = JSON.parse(text);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)
      && Object.hasOwn(payload, 'err') && (payload as { err: unknown }).err === 'user.need_login') return true;
  } catch { /* HTML or an incomplete/non-API document. */ }

  // Match the document prefix, not form-like prose embedded inside a PDF or
  // other binary book. Legacy encoding later in an error page is irrelevant.
  if (!isHtmlBookResponsePrefix(prefix) && !/^<form\b/i.test(text)) return false;

  let password = false;
  let loginForm = false;
  for (const match of text.matchAll(/<(?:input|form)\b[^>]*>/gi)) {
    const tag = match[0];
    if (/^<input\b/i.test(tag) && htmlAttribute(tag, 'type')?.toLowerCase() === 'password') password = true;
    if (/^<form\b/i.test(tag)) {
      const action = htmlAttribute(tag, 'action');
      if (action) {
        try {
          const target = new URL(action, 'https://book-response.invalid');
          loginForm ||= ['http:', 'https:'].includes(target.protocol) && LOGIN_PATH.test(target.pathname);
        } catch { /* malformed action */ }
      }
    }
  }
  return password && loginForm;
}

/** Inspect an error document without cloning/buffering an unbounded native body. */
export async function readBookErrorPrefix(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let prefix: Uint8Array = new Uint8Array();
        while (prefix.length < BOOK_HEADER_WINDOW) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.length) continue;
          const next = new Uint8Array(Math.min(BOOK_HEADER_WINDOW, prefix.length + value.length));
          next.set(prefix);
          next.set(value.subarray(0, next.length - prefix.length), prefix.length);
          prefix = next;
        }
        return prefix;
      })(),
      new Promise<Uint8Array>((resolve) => { timer = setTimeout(() => resolve(new Uint8Array()), 1500); }),
    ]);
  } catch { return new Uint8Array(); }
  finally {
    clearTimeout(timer);
    // Cancellation can finish late in native IPC; it must not hold login navigation.
    void reader.cancel().catch(() => undefined);
  }
}
