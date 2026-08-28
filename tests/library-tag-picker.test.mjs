import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const librarySource = readFileSync(
  fileURLToPath(new URL('../src/app/library/page.tsx', import.meta.url)),
  'utf8',
);

test('书库标签超过下拉上限后提供更多标签入口', () => {
  assert.match(librarySource, /const TAG_DROPDOWN_LIMIT = 12/);
  assert.match(librarySource, /options\.length > TAG_DROPDOWN_LIMIT/);
  assert.match(librarySource, /label: '更多标签…'/);
  assert.match(librarySource, /setShowAllTags\(true\)/);
});

test('全部标签弹窗在移动端可滚动并支持选择、关闭与 Esc', () => {
  assert.match(librarySource, /role="dialog"[\s\S]*aria-modal="true"/);
  assert.match(librarySource, /max-h-\[85dvh\][\s\S]*sm:max-w-2xl/);
  assert.match(librarySource, /options\.map\(\(tag\) =>/);
  assert.match(librarySource, /overflow-y-auto overscroll-contain/);
  assert.match(librarySource, /event\.key === 'Escape'/);
  assert.match(librarySource, /onSelect\(tag\);\s*onClose\(\)/);
});
