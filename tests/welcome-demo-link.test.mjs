import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const welcomeSource = readFileSync(
  fileURLToPath(new URL('../src/app/welcome/page.tsx', import.meta.url)),
  'utf8',
);

test('连接页只复制演示书库链接，不再直接连接或打开站点', () => {
  assert.match(welcomeSource, /copyTextToClipboard\(DEMO_LIBRARY_URL\)/);
  assert.match(welcomeSource, /data-dom-id="btn-copy-demo-link"/);
  assert.match(welcomeSource, /'复制链接'/);
  assert.doesNotMatch(
    welcomeSource,
    /handleConnect\(['"]https:\/\/demo\.talebook\.org['"]\)/,
  );
});
