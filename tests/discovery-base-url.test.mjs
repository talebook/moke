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
  assert.equal(normalizeLibraryBaseUrl('https://books.example:443/'), 'https://books.example');
  assert.equal(normalizeLibraryBaseUrl('http://books.example:80'), 'http://books.example');
  assert.equal(normalizeLibraryBaseUrl('http://192.168.50.10/'), 'http://192.168.50.10');
});

test('manual public and IDNA addresses do not inherit discovery-only wire limits', () => {
  assert.deepEqual(parseLibraryBaseUrl('https://书库.example:443/team/books/'), {
    baseUrl: 'https://xn--1jq370b.example/team/books',
    origin: 'https://xn--1jq370b.example',
    protocol: 'https',
    host: 'xn--1jq370b.example',
    port: '443',
    pathPrefix: '/team/books',
  });
  assert.equal(isSameLibraryBaseUrl('https://书库.example/team/books', 'https://xn--1jq370b.example/team/books/'), true);
  const longUrl = `https://books.example/${'library/'.repeat(30)}books`;
  assert.ok(longUrl.length > 200);
  assert.equal(normalizeLibraryBaseUrl(longUrl), longUrl);
  assert.equal(normalizeLibraryBaseUrl('https://8.8.8.8/team/books'), 'https://8.8.8.8/team/books');
  // Syntax success neither resolves the name nor promises reachability/trust.
  assert.equal(normalizeLibraryBaseUrl('https://not-resolvable.invalid/team/books'), 'https://not-resolvable.invalid/team/books');
  assert.equal(normalizeLibraryBaseUrl('http://127.0.0.1/'), 'http://127.0.0.1');
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
    'http://１９２.１６８.５０.１０', 'http://0xffffffff',
    'http://-books.home.arpa', 'http://books..home.arpa',
    'http://books_home.arpa', 'http://books.home.arpa:abc', 'http://[fd12::broken]',
    `http://${'a'.repeat(64)}.example`, 'http://书库.example/书库',
    'http://books.home.arpa\u0000', 'http://books.home.arpa\u0085',
    'http://books.home.arpa\u00a0',
    'file:///etc/passwd', 'ftp://books.home.arpa',
  ]) {
    assert.throws(() => parseLibraryBaseUrl(input), undefined, input);
  }
});

test('invalid legacy values produce explicit errors and cannot compare equal', () => {
  for (const [value, error] of [
    ['http://u:p@books.example', 'invalid_base_url'],
    ['http://books.example/a/../b', 'invalid_base_path'],
    ['http://bad_host.example', 'invalid_base_host'],
    ['http://books.example:0', 'invalid_base_port'],
  ]) {
    assert.throws(() => parseLibraryBaseUrl(value), { message: error });
    assert.throws(() => normalizeLibraryBaseUrl(value), { message: error });
    assert.equal(isSameLibraryBaseUrl(value, value), false);
  }
});

test('IPv6 and nondefault ports keep their complete identity', () => {
  assert.equal(normalizeLibraryBaseUrl('http://[fd12:3456:789a::10]:8080'), 'http://[fd12:3456:789a::10]:8080');
  assert.equal(normalizeLibraryBaseUrl('https://books.home.arpa:8443/team/books'), 'https://books.home.arpa:8443/team/books');
});
