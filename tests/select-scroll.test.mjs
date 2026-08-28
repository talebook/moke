import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const selectSource = readFileSync(
  fileURLToPath(new URL('../src/components/ui/Select.tsx', import.meta.url)),
  'utf8',
);

test('Select keeps its dropdown open while the options panel scrolls', () => {
  assert.match(
    selectSource,
    /target instanceof Node && panelRef\.current\?\.contains\(target\)/,
  );
  assert.match(selectSource, /overflow-y-auto overscroll-contain/);
});

test('Select still closes when the page or an ancestor scrolls', () => {
  assert.match(selectSource, /window\.addEventListener\('scroll', onScroll, true\)/);
  assert.match(selectSource, /if \(target instanceof Node[\s\S]*return;[\s\S]*setOpen\(false\)/);
});

test('Select expands for long option labels without overflowing the viewport', () => {
  assert.match(selectSource, /minWidth: pos\.minWidth/);
  assert.match(selectSource, /w-max max-w-\[calc\(100vw-1rem\)\]/);
  assert.match(selectSource, /whitespace-normal break-words/);
});
