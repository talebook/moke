import test from 'node:test';
import assert from 'node:assert/strict';
import { MokeApiError } from '../src/lib/api-core.ts';
import { OnlineReadingError } from '../src/lib/online-reading.ts';
import { buildLoginHref, captureLoginNavigation, getSafeLoginReturnTo, isLoginRequiredError } from '../src/lib/auth-navigation.ts';

test('authentication navigation recognizes explicit API, online and legacy failures', () => {
  for (const error of [
    new MokeApiError('请先登录', 'user.need_login', 200),
    new MokeApiError('请先登录', 'user.need_login', 403),
    new MokeApiError('Unauthorized', 'http.401', 401),
    new OnlineReadingError('online.auth_required', 200, 'bootstrap-body'),
    new Error('http.401'), new Error('comic.http.401'),
    Object.assign(new Error('Unauthorized'), { status: 401 }),
  ]) assert.equal(isLoginRequiredError(error), true);
});

test('permissions and network or storage failures do not request login', () => {
  for (const error of [
    new MokeApiError('没有权限', 'permission.denied', 403),
    new OnlineReadingError('online.permission_denied', 403),
    new Error('http.403'), new Error('comic.http.403'),
    new Error('book.download.transfer_failed'), new Error('book.download.storage_failed'),
    new Error('login server unavailable'), null, undefined, 'user.need_login',
  ]) assert.equal(isLoginRequiredError(error), false);
});

test('login retains book and search context through one encoded parameter', () => {
  for (const route of [
    '/detail?id=42&format=EPUB', '/library', '/search?scope=shelf&q=%E4%B9%A6',
    '/shelf', '/downloads', '/network-book?source=1&url=https%3A%2F%2Fbooks.test%2Fbook',
  ]) {
    assert.equal(getSafeLoginReturnTo(route), route);
    assert.equal(new URL(buildLoginHref(route), 'https://moke.local').searchParams.get('returnTo'), route);
  }
});

test('login return route rejects external, executable, embedded and ambiguous paths', () => {
  for (const route of [
    null, '', 'https://evil.test/detail', '//evil.test/detail', 'javascript:alert(1)',
    '/readest/reader?url=https://evil.test', '/login?returnTo=/login', '/welcome',
    '/detail\\evil', '/detail?x=\\evil', '/detail?x=%5cevil', '/detail?x=%00',
    '/detail\n', '/detail?x=\r', '/%2f%2fevil.test', '/detail/../shelf',
    '/detail%2f..%2fshelf', '/detail?x=%not-encoded',
  ]) assert.equal(getSafeLoginReturnTo(route), '/shelf', String(route));
});

test('a captured login action keeps its original safe return page and active session', () => {
  const session = { serverUrl: 'https://books.test', sessionRevision: 7 };
  const route = '/detail?id=42&format=EPUB';
  const navigation = captureLoginNavigation(session.serverUrl, () => session, () => route);
  assert.equal(navigation(), buildLoginHref(route));
});

test('late authentication from a departed page or changed query cannot navigate', () => {
  const session = { serverUrl: 'https://books.test', sessionRevision: 7 };
  let route = '/detail?id=42';
  const navigation = captureLoginNavigation(session.serverUrl, () => session, () => route);
  route = '/library';
  assert.equal(navigation(), null);
  route = '/detail?id=43';
  assert.equal(navigation(), null);
});

test('old download authentication cannot override a server switch or newer login session', () => {
  const session = { serverUrl: 'https://books.test', sessionRevision: 7 };
  const navigation = captureLoginNavigation(session.serverUrl, () => session, () => '/downloads');
  session.serverUrl = 'https://other.test';
  assert.equal(navigation(), null);
  session.serverUrl = 'https://books.test';
  session.sessionRevision = 8;
  assert.equal(navigation(), null);
});

test('a stale task source cannot borrow the current server session to request login', () => {
  const session = { serverUrl: 'https://current.test', sessionRevision: 1 };
  const navigation = captureLoginNavigation('https://previous.test', () => session, () => '/downloads');
  assert.equal(navigation(), null);
});
