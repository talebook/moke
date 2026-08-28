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

test('复制成功提示会在短暂展示后自动复位', () => {
  assert.match(welcomeSource, /COPY_FEEDBACK_DURATION_MS\s*=\s*2000/);
  assert.match(welcomeSource, /setDemoLinkCopied\(false\)/);
  assert.match(welcomeSource, /copyFeedbackTimerRef\.current\s*=\s*setTimeout/);
});

test('连接页默认书库入口进入 Moke 离线模式而不是 Readest 书库', () => {
  assert.match(welcomeSource, /data-dom-id="btn-offline-mode"/);
  assert.match(welcomeSource, /enterOfflineMode\(\)/);
  assert.match(welcomeSource, /router\.push\('\/shelf'\)/);
  assert.match(welcomeSource, /进入离线模式/);
  assert.doesNotMatch(welcomeSource, /openEmbeddedReaderHome/);
});
