import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeServerAddress } from '../src/lib/server-url.ts';

test('accepts HTTP(S) roots and optional schemes', () => {
  assert.equal(normalizeServerAddress('http://192.168.1.5:8080'), 'http://192.168.1.5:8080');
  assert.equal(normalizeServerAddress('https://books.example.com/'), 'https://books.example.com');
  assert.equal(normalizeServerAddress(' books.example.com:8080 '), 'http://books.example.com:8080');
});
test('rejects non-HTTP protocols and malformed input', () => {
  for (const value of ['', '   ', 'not a url', '//no-scheme', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'ftp://example.com', 'about:blank']) assert.throws(() => normalizeServerAddress(value));
});
test('rejects credentials and non-root components without stripping them', () => {
  for (const value of ['https://user:pass@example.com', 'https://example.com/book', 'https://example.com/book/..', 'https://example.com/?q=1', 'https://example.com/#fragment']) assert.throws(() => normalizeServerAddress(value), /服务器根地址/);
});
test('canonicalizes hostname/default ports and retains non-default ports', () => {
  assert.equal(normalizeServerAddress('https://BOOKS.example.com:443'), 'https://books.example.com');
  assert.equal(normalizeServerAddress('http://BOOKS.example.com:80'), 'http://books.example.com');
  assert.equal(normalizeServerAddress('https://books.example.com:8443'), 'https://books.example.com:8443');
});
