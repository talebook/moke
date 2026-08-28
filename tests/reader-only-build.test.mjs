import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readerPackage = JSON.parse(
  readFileSync(new URL('../readest/apps/readest-app/package.json', import.meta.url), 'utf8'),
);
const nextConfig = readFileSync(
  new URL('../readest/apps/readest-app/next.config.mjs', import.meta.url),
  'utf8',
);
const readerEntry = readFileSync(
  new URL('../readest/apps/readest-app/src/pages/reader.moke.tsx', import.meta.url),
  'utf8',
);

test('Moke 构建只暴露 Readest reader 页面', () => {
  assert.match(rootPackage.scripts['build:reader'], /build:moke-reader/);
  assert.match(readerPackage.scripts['build:moke-reader'], /\.env\.moke-reader/);
  assert.match(nextConfig, /embeddedProfile === 'moke-reader'/);
  assert.match(nextConfig, /\? \['moke\.tsx'\]/);
  assert.match(readerEntry, /<Reader \/>/);
  assert.doesNotMatch(readerEntry, /Library/);
});
