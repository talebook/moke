/**
 * Security policy and bounded response reader for book covers.
 *
 * This module deliberately has no React/Tauri imports so the redirect, URL,
 * byte and pixel limits can be exercised with Node's built-in test runner.
 */

export const MAX_COVER_BYTES = 5 * 1024 * 1024;
export const MAX_COVER_PIXELS = 16 * 1024 * 1024;
export const MAX_COVER_DIMENSION = 8192;
export const MAX_COVER_REDIRECTS = 3;

const ALLOWED_CONTENT_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

export type CoverAccess = 'library' | 'public';

export interface ParsedCoverUrl {
  url: URL;
  access: CoverAccess;
}

export interface CoverImageInfo {
  format: 'gif' | 'jpeg' | 'png' | 'webp';
  width: number;
  height: number;
}

export interface CoverFetchDependencies {
  fetchLibrary: (url: string) => Promise<Response>;
  fetchPublic: (url: string) => Promise<Response>;
  /** Native callers resolve and pin DNS themselves; tests can inject a resolver. */
  resolvePublicHost?: (hostname: string) => Promise<string[]>;
}

export interface FetchCoverBytesOptions {
  imageUrl: string;
  libraryUrl: string;
  allowPublicCrossOrigin?: boolean;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface CoverBytesResult {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
  info: CoverImageInfo;
}

function coverError(code: string): Error {
  return new Error(`image.${code}`);
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function parseIpv6(hostname: string): number[] | null {
  const input = normalizeHostname(hostname);
  if (!input.includes(':') || input.includes('%')) return null;

  const halves = input.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const fields = half.split(':');
    const result: number[] = [];
    for (const field of fields) {
      if (field.includes('.')) {
        const ipv4 = parseIpv4(field);
        if (!ipv4) return null;
        result.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(field)) return null;
        result.push(Number.parseInt(field, 16));
      }
    }
    return result;
  };

  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array<number>(omitted).fill(0), ...right];
}

function ipv4IsNonPublic(octets: number[]): boolean {
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6IsNonPublic(parts: number[]): boolean {
  const first = parts[0];
  const second = parts[1];
  const allZeroBeforeV4 = parts.slice(0, 6).every((part) => part === 0);
  const mappedV4 = parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;
  if (mappedV4) {
    return ipv4IsNonPublic([
      parts[6] >> 8,
      parts[6] & 0xff,
      parts[7] >> 8,
      parts[7] & 0xff,
    ]);
  }
  // Deprecated IPv4-compatible space (::/96) has no legitimate CDN use and
  // is handled inconsistently by operating-system network stacks.
  if (allZeroBeforeV4) return true;

  return (
    parts.every((part) => part === 0) ||
    parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1 ||
    (first & 0xfe00) === 0xfc00 || // unique-local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x0064 && second === 0xff9b) || // NAT64 well-known/local prefixes
    (first === 0x0100 && second === 0) || // discard-only 100::/64
    (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) || // special/documentation
    first === 0x2002 || // 6to4 can encode otherwise-forbidden IPv4 targets
    (first & 0xfff0) === 0x3ff0 || // documentation 3fff::/20
    first === 0x5f00 // segment-routing SIDs, not a public endpoint
  );
}

/** Reject literal or resolved addresses that are not globally routable. */
export function isForbiddenCoverAddress(address: string): boolean {
  const hostname = normalizeHostname(address);
  const ipv4 = parseIpv4(hostname);
  if (ipv4) return ipv4IsNonPublic(ipv4);
  const ipv6 = parseIpv6(hostname);
  return ipv6 ? ipv6IsNonPublic(ipv6) : false;
}

export function assertPublicCoverUrl(url: URL): void {
  const hostname = normalizeHostname(url.hostname);
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname === 'metadata.google.internal' ||
    hostname.endsWith('.metadata.google.internal') ||
    isForbiddenCoverAddress(hostname)
  ) {
    throw coverError('url.private');
  }
}

/** Parse relative covers against the configured library, never the WebView origin. */
export function parseCoverUrl(
  imageUrl: string,
  libraryUrl: string,
  allowPublicCrossOrigin = false,
): ParsedCoverUrl {
  let library: URL;
  let url: URL;
  try {
    library = new URL(libraryUrl);
    url = new URL(imageUrl, library);
  } catch {
    throw coverError('url.invalid');
  }

  if (!['http:', 'https:'].includes(library.protocol) || !['http:', 'https:'].includes(url.protocol)) {
    throw coverError('url.invalid');
  }
  if (url.username || url.password) throw coverError('url.credentials');
  url.hash = '';

  if (url.origin === library.origin) return { url, access: 'library' };
  if (!allowPublicCrossOrigin) throw coverError('url.cross_origin');
  assertPublicCoverUrl(url);
  return { url, access: 'public' };
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function inspectPng(bytes: Uint8Array): CoverImageInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) };
}

function inspectGif(bytes: Uint8Array): CoverImageInfo | null {
  if (bytes.length < 13) return null;
  const signature = String.fromCharCode(...bytes.slice(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { format: 'gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function inspectJpeg(bytes: Uint8Array): CoverImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 1 >= bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      return {
        format: 'jpeg',
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return null;
}

function inspectWebp(bytes: Uint8Array): CoverImageInfo | null {
  if (
    bytes.length < 30 ||
    String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' ||
    String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP'
  ) return null;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const data = offset + 8;
    if (data + size > bytes.length) return null;
    if (type === 'VP8X' && size >= 10) {
      return {
        format: 'webp',
        width: 1 + readUint24Le(bytes, data + 4),
        height: 1 + readUint24Le(bytes, data + 7),
      };
    }
    if (type === 'VP8 ' && size >= 10 && bytes[data + 3] === 0x9d && bytes[data + 4] === 0x01 && bytes[data + 5] === 0x2a) {
      return {
        format: 'webp',
        width: ((bytes[data + 7] << 8) | bytes[data + 6]) & 0x3fff,
        height: ((bytes[data + 9] << 8) | bytes[data + 8]) & 0x3fff,
      };
    }
    if (type === 'VP8L' && size >= 5 && bytes[data] === 0x2f) {
      return {
        format: 'webp',
        width: 1 + (((bytes[data + 2] & 0x3f) << 8) | bytes[data + 1]),
        height: 1 + (((bytes[data + 4] & 0x0f) << 10) | (bytes[data + 3] << 2) | (bytes[data + 2] >> 6)),
      };
    }
    offset = data + size + (size % 2);
  }
  return null;
}

export function inspectCoverImage(bytes: Uint8Array): CoverImageInfo {
  const info = inspectPng(bytes) ?? inspectGif(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
  if (!info) throw coverError('format.invalid');
  if (
    info.width < 1 ||
    info.height < 1 ||
    info.width > MAX_COVER_DIMENSION ||
    info.height > MAX_COVER_DIMENSION ||
    info.width * info.height > MAX_COVER_PIXELS
  ) {
    throw coverError('dimensions.exceeded');
  }
  return info;
}

function normalizedContentType(value: string | null): string {
  return (value ?? '').split(';', 1)[0].trim().toLowerCase();
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const rawLength = response.headers.get('content-length');
  if (rawLength && /^\d+$/.test(rawLength) && Number(rawLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw coverError('size.exceeded');
  }
  if (!response.body) throw coverError('body.missing');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw coverError('size.exceeded');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function contentTypeMatchesFormat(contentType: string, format: CoverImageInfo['format']): boolean {
  if (!contentType) return true;
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) return false;
  if (format === 'jpeg') return contentType === 'image/jpeg' || contentType === 'image/jpg';
  return contentType === `image/${format}`;
}

/**
 * Follow redirects manually so policy is re-evaluated before every request.
 * Once a route becomes public it stays anonymous, even if it redirects back
 * to the library origin, preventing credentials from being reintroduced.
 */
export async function fetchCoverBytes(
  options: FetchCoverBytesOptions,
  dependencies: CoverFetchDependencies,
): Promise<CoverBytesResult> {
  const maxBytes = options.maxBytes ?? MAX_COVER_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_COVER_REDIRECTS;
  let parsed = parseCoverUrl(options.imageUrl, options.libraryUrl, options.allowPublicCrossOrigin);
  let anonymous = parsed.access === 'public';
  let redirects = 0;

  for (;;) {
    if (anonymous) {
      assertPublicCoverUrl(parsed.url);
      if (dependencies.resolvePublicHost) {
        const addresses = await dependencies.resolvePublicHost(normalizeHostname(parsed.url.hostname));
        if (addresses.length === 0 || addresses.some(isForbiddenCoverAddress)) {
          throw coverError('url.private');
        }
      }
    }

    const response = anonymous
      ? await dependencies.fetchPublic(parsed.url.toString())
      : await dependencies.fetchLibrary(parsed.url.toString());

    if (response.status >= 300 && response.status < 400) {
      if (redirects >= maxRedirects) {
        await response.body?.cancel().catch(() => undefined);
        throw coverError('redirect.exceeded');
      }
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw coverError('redirect.invalid');
      parsed = parseCoverUrl(
        new URL(location, parsed.url).toString(),
        options.libraryUrl,
        options.allowPublicCrossOrigin,
      );
      anonymous ||= parsed.access === 'public';
      redirects += 1;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw coverError(`http.${response.status}`);
    }

    const contentType = normalizedContentType(response.headers.get('content-type'));
    if (contentType && !ALLOWED_CONTENT_TYPES.has(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw coverError('content_type.invalid');
    }
    const bytes = await readBoundedBody(response, maxBytes);
    const info = inspectCoverImage(bytes);
    if (!contentTypeMatchesFormat(contentType, info.format)) throw coverError('content_type.invalid');
    return { bytes, contentType: contentType || `image/${info.format}`, finalUrl: parsed.url.toString(), info };
  }
}
