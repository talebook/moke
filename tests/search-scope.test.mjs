import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const shelf = read('../src/app/shelf/page.tsx');
const library = read('../src/app/library/page.tsx');
const search = read('../src/app/search/page.tsx');

test('书架与书库搜索携带不同范围', () => {
  assert.match(shelf, /\/search\?scope=shelf&q=/);
  assert.match(library, /\/search\?scope=library&q=/);
  assert.match(search, /searchParams\.get\('scope'\) === 'shelf'/);
});

test('书架搜索在线读取书架接口，离线只读取书架标记记录', () => {
  assert.match(search, /isShelfScope\s*\?\s*`\$\{serverUrl\}\/api\/shelf`/);
  assert.match(search, /!isShelfScope \|\| record\.inShelf === true/);
  assert.match(search, /isShelfScope \? '搜索书架' : '搜索书库'/);
});
