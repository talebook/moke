import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveServerAssetUrl } from '../src/lib/utils.ts';

test('resolveServerAssetUrl keeps complete remote and local image sources unchanged', () => {
  assert.equal(
    resolveServerAssetUrl('https://books.example.com', 'https://cdn.example.com/cover.jpg'),
    'https://cdn.example.com/cover.jpg',
  );
  assert.equal(
    resolveServerAssetUrl('https://books.example.com', 'data:image/jpeg;base64,cover'),
    'data:image/jpeg;base64,cover',
  );
  assert.equal(
    resolveServerAssetUrl('https://books.example.com', 'data:application/octet-stream;base64,cover'),
    'data:application/octet-stream;base64,cover',
  );
  assert.equal(
    resolveServerAssetUrl('https://books.example.com', 'blob:https://app.example.com/cover'),
    'blob:https://app.example.com/cover',
  );
});

test('resolveServerAssetUrl resolves server-relative image paths', () => {
  assert.equal(
    resolveServerAssetUrl('https://books.example.com', '/get/cover.jpg'),
    'https://books.example.com/get/cover.jpg',
  );
  assert.equal(
    resolveServerAssetUrl('https://books.example.com', 'get/cover.jpg'),
    'https://books.example.com/get/cover.jpg',
  );
});
