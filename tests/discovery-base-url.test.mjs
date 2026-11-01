import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLibraryBaseUrl, normalizeLibraryBaseUrl, isSameLibraryBaseUrl } from '../src/lib/discovery/base-url.ts';

test('library identity retains prefixes while origin describes only transport', () => {
  assert.deepEqual(parseLibraryBaseUrl('HTTPS://Books.Home.Arpa:443/team/books/'), {
    baseUrl: 'https://books.home.arpa/team/books',
    origin: 'https://books.home.arpa',
    protocol: 'https',
    host: 'books.home.arpa',
    port: '443',
    pathPrefix: '/team/books',
  });
  assert.equal(isSameLibraryBaseUrl('http://books.home.arpa:80/a/', 'http://books.home.arpa/a'), true);
  assert.equal(isSameLibraryBaseUrl('http://books.home.arpa/a', 'http://books.home.arpa/b'), false);
  assert.equal(isSameLibraryBaseUrl('http://books.home.arpa/a', 'https://books.home.arpa/a'), false);
  assert.equal(isSameLibraryBaseUrl('bad', 'bad'), false);
  assert.equal(normalizeLibraryBaseUrl('http://192.168.50.10/'), 'http://192.168.50.10');
});

test('base URL contract accepts supplied positive vectors without losing their public prefix', () => {
  const vectors = JSON.parse(readFileSync(new URL('../src-tauri/discovery-core/tests/fixtures/tb-444-discovery-v1-vectors.json', import.meta.url), 'utf8'));
  for (const entry of vectors.cases.filter((entry) => entry.expected.decision === 'candidate')) {
    const txt = entry.patch.txt ?? vectors.base.txt;
    const raw = txt.find((value) => value.startsWith('url=')).slice(4);
    assert.equal(normalizeLibraryBaseUrl(raw), entry.expected.base_url ?? 'http://192.168.50.10:8080', entry.case_id);
    if (entry.expected.welcome_url) {
      assert.equal(`${normalizeLibraryBaseUrl(raw)}/api/welcome`, entry.expected.welcome_url);
    }
  }
});

test('reject raw URL syntax before URL can erase unsafe or ambiguous data', () => {
  for (const input of [
    '', ' books.home.arpa', 'http://books.home.arpa ', 'http://books.home.arpa\n',
    'http://u:p@books.home.arpa', 'http://@books.home.arpa',
    'http://books.home.arpa?', 'http://books.home.arpa#',
    'http://books.home.arpa/?x=1', 'http://books.home.arpa/#x',
    'http://books.home.arpa/a/../b', 'http://books.home.arpa/./b',
    'http://books.home.arpa/%2e%2e', 'http://books.home.arpa/a%2fb',
    'http://books.home.arpa\\foo', 'http://books.home.arpa//a',
    'http://books.home.arpa/a.b', 'http://books.home.arpa/书库',
    'http://books.home.arpa:0', 'http://books.home.arpa:65536',
    'http://192.168.1', 'http://0xc0a8320a', 'http://0300.0250.062.012',
    'http://-books.home.arpa', 'http://books..home.arpa',
    'file:///etc/passwd', 'ftp://books.home.arpa', 'http://books.home.arpa/' + 'a'.repeat(200),
  ]) {
    assert.throws(() => parseLibraryBaseUrl(input), undefined, input);
  }
});

test('IPv6 and nondefault ports keep their complete identity', () => {
  assert.equal(normalizeLibraryBaseUrl('http://[fd12:3456:789a::10]:8080'), 'http://[fd12:3456:789a::10]:8080');
  assert.equal(normalizeLibraryBaseUrl('https://books.home.arpa:8443/team/books'), 'https://books.home.arpa:8443/team/books');
});
