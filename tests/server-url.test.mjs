import test from 'node:test';
import assert from 'node:assert/strict';

import { isHttpUrl, parseHttpUrl } from '../src/lib/server-url.ts';

test('accepts http and https URLs', () => {
  assert.equal(isHttpUrl('http://192.168.1.5:8080'), true);
  assert.equal(isHttpUrl('https://books.example.com'), true);
  assert.equal(isHttpUrl('https://user:pass@example.com/path?q=1#frag'), true);
});

test('rejects non-http protocols', () => {
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isHttpUrl('file:///etc/passwd'), false);
  assert.equal(isHttpUrl('ftp://example.com'), false);
  assert.equal(isHttpUrl('about:blank'), false);
});

test('rejects malformed input instead of throwing', () => {
  assert.equal(isHttpUrl(''), false);
  assert.equal(isHttpUrl('   '), false);
  assert.equal(isHttpUrl('not a url'), false);
  assert.equal(isHttpUrl('//no-scheme'), false);
});

test('parses an HTTP URL once for callers to reuse', () => {
  const parsed = parseHttpUrl('https://books.example.com:8443/path?q=1');

  assert.equal(parsed?.origin, 'https://books.example.com:8443');
  assert.equal(parsed?.protocol, 'https:');
  for (const candidate of ['', '   ', 'not a url', '//host', 'ftp://example.com']) {
    let invalid;
    assert.doesNotThrow(() => {
      invalid = parseHttpUrl(candidate);
    });
    assert.equal(invalid, null);
  }
});
