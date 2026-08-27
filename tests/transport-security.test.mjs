import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSecureRedirectRequest,
  isCleartextHttpUrl,
  isInvalidCertificateAllowed,
  normalizeHttpOrigin,
  normalizeHttpsOrigin,
} from '../src/lib/transport-security.ts';

test('TLS 豁免只匹配显式授权的 HTTPS origin', () => {
  const allowed = ['https://books.example.com', 'not a url', 'http://plain.example.com'];

  assert.equal(isInvalidCertificateAllowed('https://books.example.com/api', allowed), true);
  assert.equal(isInvalidCertificateAllowed('https://books.example.com:8443/api', allowed), false);
  assert.equal(isInvalidCertificateAllowed('https://other.example.com/api', allowed), false);
  assert.equal(isInvalidCertificateAllowed('http://books.example.com/api', allowed), false);
  assert.equal(normalizeHttpsOrigin('https://books.example.com:443/path'), 'https://books.example.com');
});

test('HTTP 风险识别和 origin 规范化拒绝凭据及非 HTTP 协议', () => {
  assert.equal(isCleartextHttpUrl('http://192.168.1.5:8080/path'), true);
  assert.equal(isCleartextHttpUrl('https://books.example.com'), false);
  assert.equal(normalizeHttpOrigin('https://books.example.com/path?q=1'), 'https://books.example.com');
  assert.equal(normalizeHttpOrigin('https://user:pass@books.example.com'), null);
  assert.equal(normalizeHttpOrigin('file:///tmp/book'), null);
});

test('同源重定向保留请求信息，跨域重定向移除敏感和自定义凭据头', () => {
  const options = {
    headers: {
      Authorization: 'Bearer secret',
      Cookie: 'session=secret',
      'X-Api-Key': 'secret',
      Accept: 'application/json',
    },
    credentials: 'include',
  };

  const sameOrigin = buildSecureRedirectRequest(
    'https://books.example.com/api',
    302,
    '/login',
    options,
  );
  assert.equal(sameOrigin.url, 'https://books.example.com/login');
  assert.equal(new Headers(sameOrigin.options.headers).get('authorization'), 'Bearer secret');

  const crossOrigin = buildSecureRedirectRequest(
    'https://books.example.com/api',
    302,
    'https://login.example.net/session',
    options,
  );
  const headers = new Headers(crossOrigin.options.headers);
  assert.equal(headers.get('authorization'), null);
  assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get('x-api-key'), null);
  assert.equal(headers.get('accept'), 'application/json');
});

test('跨域重定向不会重放正文，HTTPS 也不能降级到 HTTP', () => {
  assert.throws(
    () => buildSecureRedirectRequest(
      'https://books.example.com/login',
      307,
      'https://other.example.com/login',
      { method: 'POST', body: 'password=secret' },
    ),
    /redirect\.cross_origin_body_blocked/,
  );

  assert.throws(
    () => buildSecureRedirectRequest(
      'https://books.example.com/api',
      302,
      'http://books.example.com/api',
    ),
    /redirect\.downgrade_blocked/,
  );
});

test('303 将 POST 改为 GET 并移除正文相关请求头', () => {
  const next = buildSecureRedirectRequest(
    'https://books.example.com/login',
    303,
    '/shelf',
    {
      method: 'POST',
      body: 'password=secret',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    },
  );

  assert.equal(next.options.method, 'GET');
  assert.equal(next.options.body, undefined);
  assert.equal(new Headers(next.options.headers).get('content-type'), null);
});
