/** A library identity includes its public path prefix. Origin is only a network boundary. */
export interface ParsedLibraryBaseUrl {
  baseUrl: string;
  origin: string;
  protocol: 'http' | 'https';
  host: string;
  port: string;
  pathPrefix: string;
}

/**
 * Validate the original spelling before URL can erase dot segments, credentials,
 * whitespace or encoded characters. This is syntax validation, not LAN or trust
 * validation, and performs no network operations.
 */
export function parseLibraryBaseUrl(value: string): ParsedLibraryBaseUrl {
  if (!value || value.length > 200 || /[^\x21-\x7e]/.test(value) || /[%\\@?#]/.test(value)) {
    throw new Error('invalid_base_url');
  }
  const match = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(value);
  if (!match) throw new Error('invalid_base_url');

  const path = match[3] ?? '';
  if (path !== '' && path !== '/' && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(path)) {
    throw new Error('invalid_base_path');
  }

  // Require ordinary DNS names, dotted decimal IPv4, or bracketed IPv6. URL's
  // legacy numeric IPv4 aliases (127.1, hex, octal) must not change an identity.
  const authority = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?$/i.exec(match[2]);
  if (!authority) throw new Error('invalid_base_host');
  const rawHost = authority[1];
  if (!rawHost.startsWith('[')) {
    const dnsHost = rawHost.endsWith('.') ? rawHost.slice(0, -1) : rawHost;
    if (dnsHost.length > 253 || dnsHost.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
      throw new Error('invalid_base_host');
    }
  }
  if (authority[2] && (!Number.isInteger(Number(authority[2])) || Number(authority[2]) < 1 || Number(authority[2]) > 65535)) {
    throw new Error('invalid_base_port');
  }

  const url = new URL(value);
  if (/^[0-9.]+$/.test(url.hostname) && rawHost !== url.hostname) {
    throw new Error('invalid_base_host');
  }
  const pathPrefix = path === '/' ? '' : path.replace(/\/$/, '');
  const protocol = url.protocol === 'https:' ? 'https' : 'http';
  return {
    baseUrl: `${url.origin}${pathPrefix}`,
    origin: url.origin,
    protocol,
    host: url.hostname,
    port: url.port || (protocol === 'https' ? '443' : '80'),
    pathPrefix,
  };
}

export function normalizeLibraryBaseUrl(value: string): string {
  return parseLibraryBaseUrl(value).baseUrl;
}

export function isSameLibraryBaseUrl(left: string, right: string): boolean {
  try {
    return normalizeLibraryBaseUrl(left) === normalizeLibraryBaseUrl(right);
  } catch {
    return false;
  }
}
