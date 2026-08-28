import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const fallback = read('../src/components/book/BookCoverFallback.tsx');
const shelf = read('../src/app/shelf/page.tsx');
const library = read('../src/app/library/page.tsx');
const search = read('../src/app/search/page.tsx');

test('书架、书库和搜索共享相同的默认封面组件', () => {
  assert.match(fallback, /export function BookCoverFallback/);
  assert.match(fallback, /\(title \|\| '\?'\)\.charAt\(0\)/);
  for (const source of [shelf, library, search]) {
    assert.match(source, /import \{ BookCoverFallback \}/);
    assert.match(source, /<BookCoverFallback title=\{book\.title\} seed=\{bookId\}/);
  }
  assert.doesNotMatch(shelf, /from-emerald-800\/20/);
});
