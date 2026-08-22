import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sidebarSource = readFileSync(
  fileURLToPath(new URL('../src/components/layout/Sidebar.tsx', import.meta.url)),
  'utf8',
);

test('侧边栏标题过长时图标保持固定尺寸且标题截断', () => {
  assert.match(
    sidebarSource,
    /<div className="[^"]*\bshrink-0\b[^"]*">\s*<BookOpen/,
  );
  assert.match(
    sidebarSource,
    /<span\s+className="[^"]*\bmin-w-0\b[^"]*\bflex-1\b[^"]*\btruncate\b/,
  );
});
