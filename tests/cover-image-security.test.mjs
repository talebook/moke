import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  fetchCoverBytes,
  isForbiddenCoverAddress,
  MAX_COVER_BYTES,
  parseCoverUrl,
} from '../src/lib/cover-image-core.ts';

const LIBRARY_URL = 'https://library.example';

function pngHeader(width = 1, height = 1) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function imageResponse(bytes = pngHeader(), headers = {}) {
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': 'image/png', ...headers },
  });
}

function redirectResponse(location) {
  return new Response(null, { status: 302, headers: { Location: location } });
}

test('封面 URL 只接受相对书库或显式允许的 HTTP(S) 公网地址', () => {
  assert.equal(parseCoverUrl('/cover/1.jpg', LIBRARY_URL).url.href, 'https://library.example/cover/1.jpg');
  assert.equal(parseCoverUrl('https://library.example/cover/1.jpg', LIBRARY_URL).access, 'library');

  for (const value of [
    'file:///etc/passwd',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'ftp://cdn.example/cover.jpg',
    'https://user:secret@cdn.example/cover.jpg',
  ]) {
    assert.throws(() => parseCoverUrl(value, LIBRARY_URL, true), /image\.url\./, value);
  }
  assert.throws(
    () => parseCoverUrl('https://cdn.example/cover.jpg', LIBRARY_URL),
    /image\.url\.cross_origin/,
  );
  assert.equal(
    parseCoverUrl('https://cdn.example/cover.jpg', LIBRARY_URL, true).access,
    'public',
  );
});

test('IPv4/IPv6 私网、特殊地址和非常规 IPv4 写法均被拒绝', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::8.8.8.8',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '64:ff9b::a00:1',
    '2001:db8::1',
    '3fff::1',
    '5f00::1',
  ]) {
    assert.equal(isForbiddenCoverAddress(address), true, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isForbiddenCoverAddress(address), false, address);
  }
  for (const url of [
    'http://127.0.0.1/cover.jpg',
    'http://2130706433/cover.jpg',
    'http://0x7f000001/cover.jpg',
    'http://[::1]/cover.jpg',
    'http://metadata.google.internal/computeMetadata/v1/',
  ]) {
    assert.throws(() => parseCoverUrl(url, LIBRARY_URL, true), /image\.url\.private/, url);
  }
});

test('DNS 解析到任一私网地址时在发请求前拒绝', async () => {
  let requests = 0;
  await assert.rejects(
    fetchCoverBytes(
      {
        imageUrl: 'https://cdn.example/cover.png',
        libraryUrl: LIBRARY_URL,
        allowPublicCrossOrigin: true,
      },
      {
        fetchLibrary: async () => { throw new Error('unexpected library request'); },
        fetchPublic: async () => { requests += 1; return imageResponse(); },
        resolvePublicHost: async () => ['203.0.113.8', '10.0.0.8'],
      },
    ),
    /image\.url\.private/,
  );
  assert.equal(requests, 0);
});

test('同源重定向到私网会在访问重定向目标前拒绝', async () => {
  let publicRequests = 0;
  await assert.rejects(
    fetchCoverBytes(
      {
        imageUrl: '/cover/1.png',
        libraryUrl: LIBRARY_URL,
        allowPublicCrossOrigin: true,
      },
      {
        fetchLibrary: async () => redirectResponse('https://rebind.example/cover.png'),
        fetchPublic: async () => { publicRequests += 1; return imageResponse(); },
        resolvePublicHost: async () => ['192.168.1.20'],
      },
    ),
    /image\.url\.private/,
  );
  assert.equal(publicRequests, 0);
});

test('跨域重定向切换到匿名传输且不会重新启用书库凭据', async () => {
  const calls = [];
  const result = await fetchCoverBytes(
    {
      imageUrl: '/cover/1.png',
      libraryUrl: LIBRARY_URL,
      allowPublicCrossOrigin: true,
    },
    {
      fetchLibrary: async (url) => {
        calls.push(['library-with-cookie', url]);
        return redirectResponse('https://cdn.example/cover.png');
      },
      fetchPublic: async (url) => {
        calls.push(['public-without-cookie', url]);
        if (url.startsWith('https://cdn.example')) {
          return redirectResponse('https://library.example/cdn-return.png');
        }
        return imageResponse();
      },
      resolvePublicHost: async () => ['1.1.1.1'],
    },
  );

  assert.equal(result.info.width, 1);
  assert.deepEqual(calls.map(([transport]) => transport), [
    'library-with-cookie',
    'public-without-cookie',
    'public-without-cookie',
  ]);
});

test('Content-Length 超限时不读取正文', async () => {
  let bodyPulls = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      bodyPulls += 1;
      controller.enqueue(pngHeader());
      controller.close();
    },
  }), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(MAX_COVER_BYTES + 1),
    },
  });

  await assert.rejects(
    fetchCoverBytes(
      { imageUrl: '/cover.png', libraryUrl: LIBRARY_URL },
      {
        fetchLibrary: async () => response,
        fetchPublic: async () => { throw new Error('unexpected public request'); },
      },
    ),
    /image\.size\.exceeded/,
  );
  // Node may pull once while constructing a Response, but the loader never
  // consumes the advertised-oversize stream further.
  assert.ok(bodyPulls <= 1);
});

for (const [name, advertisedLength] of [
  ['缺失 Content-Length', undefined],
  ['伪造过小 Content-Length', '1'],
]) {
  test(`${name} 仍按流式实际字节限制`, async () => {
    const bytes = new Uint8Array(65);
    bytes.set(pngHeader());
    const headers = advertisedLength ? { 'Content-Length': advertisedLength } : {};
    await assert.rejects(
      fetchCoverBytes(
        { imageUrl: '/cover.png', libraryUrl: LIBRARY_URL, maxBytes: 64 },
        {
          fetchLibrary: async () => imageResponse(bytes, headers),
          fetchPublic: async () => { throw new Error('unexpected public request'); },
        },
      ),
      /image\.size\.exceeded/,
    );
  });
}

test('超大像素、SVG 和超出重定向次数的响应均被拒绝', async () => {
  await assert.rejects(
    fetchCoverBytes(
      { imageUrl: '/cover.png', libraryUrl: LIBRARY_URL },
      {
        fetchLibrary: async () => imageResponse(pngHeader(8193, 1)),
        fetchPublic: async () => { throw new Error('unexpected public request'); },
      },
    ),
    /image\.dimensions\.exceeded/,
  );
  await assert.rejects(
    fetchCoverBytes(
      { imageUrl: '/cover.svg', libraryUrl: LIBRARY_URL },
      {
        fetchLibrary: async () => new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
        fetchPublic: async () => { throw new Error('unexpected public request'); },
      },
    ),
    /image\.content_type\.invalid/,
  );
  await assert.rejects(
    fetchCoverBytes(
      { imageUrl: '/cover.png', libraryUrl: LIBRARY_URL, maxRedirects: 1 },
      {
        fetchLibrary: async () => redirectResponse('/again.png'),
        fetchPublic: async () => { throw new Error('unexpected public request'); },
      },
    ),
    /image\.redirect\.exceeded/,
  );
});

test('正常同源封面与显式允许的公网 CDN 封面可加载', async () => {
  const library = await fetchCoverBytes(
    { imageUrl: '/cover.png', libraryUrl: LIBRARY_URL },
    {
      fetchLibrary: async () => imageResponse(pngHeader(600, 900)),
      fetchPublic: async () => { throw new Error('unexpected public request'); },
    },
  );
  assert.deepEqual(library.info, { format: 'png', width: 600, height: 900 });

  let resolvedHost = '';
  const cdn = await fetchCoverBytes(
    {
      imageUrl: 'https://cdn.example/book.webp',
      libraryUrl: LIBRARY_URL,
      allowPublicCrossOrigin: true,
    },
    {
      fetchLibrary: async () => { throw new Error('unexpected library request'); },
      fetchPublic: async () => imageResponse(pngHeader(400, 600)),
      resolvePublicHost: async (host) => { resolvedHost = host; return ['1.1.1.1']; },
    },
  );
  assert.equal(resolvedHost, 'cdn.example');
  assert.equal(cdn.info.height, 600);
});

test('书库与网络书封面统一经过安全组件并保留 object URL 回收与失败冷却', () => {
  for (const file of [
    'src/app/detail/page.tsx',
    'src/app/library/page.tsx',
    'src/app/network-book/page.tsx',
    'src/app/search/page.tsx',
    'src/app/shelf/page.tsx',
    'src/app/user/history/page.tsx',
    'src/components/book/BookTable.tsx',
  ]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /<AuthImage\b/, `${file} must use AuthImage for covers`);
    assert.doesNotMatch(
      source,
      /<img[\s\S]{0,160}src=\{(?:coverUrl|book\.(?:cover_url|img|thumb))\}/,
      `${file} must not hand a server cover URL directly to img`,
    );
  }

  const authImage = readFileSync(new URL('../src/components/ui/AuthImage.tsx', import.meta.url), 'utf8');
  assert.match(authImage, /fetchImageObjectUrl\(src, \{ serverUrl, allowPublicCrossOrigin \}\)/);
  assert.match(authImage, /URL\.revokeObjectURL\(ownedObjectUrl\)/);
  assert.match(authImage, /URL\.revokeObjectURL\(loaded\.objectUrl\)/);

  const api = readFileSync(new URL('../src/lib/api.ts', import.meta.url), 'utf8');
  assert.match(api, /const coverLoads = new Map<string, Promise<Blob>>\(\)/);
  assert.match(api, /COVER_FAILURE_COOLDOWN_MS/);
});
