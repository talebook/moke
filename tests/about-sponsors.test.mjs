import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sponsors } from '../src/app/about/sponsors.ts';

const root = path.resolve(import.meta.dirname, '..');
const pageSource = readFileSync(path.join(root, 'src', 'app', 'about', 'page.tsx'), 'utf8');

test('赞助名单首批包含金海先生与千成', () => {
  assert.deepEqual(
    sponsors.map(({ name, amount }) => ({ name, amount })),
    [
      { name: '金海先生', amount: '¥20' },
      { name: '千成', amount: '¥10' },
    ],
  );
});

test('赞助名单字段完整且 id 唯一，便于后续追加', () => {
  assert.ok(sponsors.length > 0, '名单不应为空');
  for (const s of sponsors) {
    assert.equal(typeof s.id, 'string');
    assert.ok(s.id.length > 0, 'id 不能为空');
    assert.equal(typeof s.name, 'string');
    assert.ok(s.name.length > 0, 'name 不能为空');
    assert.equal(typeof s.amount, 'string');
    assert.match(s.amount, /^¥\s*\d+(\.\d+)?$/, '金额应形如 ¥20');
  }
  assert.equal(new Set(sponsors.map((s) => s.id)).size, sponsors.length, 'id 应唯一');
});

test('关于页渲染独立数据文件中的赞助名单，模板不写死姓名', () => {
  assert.match(pageSource, /赞助名单/);
  assert.match(pageSource, /from\s+['"]\.\/sponsors['"]/);
  assert.match(pageSource, /sponsors\.map/);
  // 具体赞助者应只存在于数据文件中，追加新赞助者无需改动页面模板
  assert.doesNotMatch(pageSource, /金海先生/);
  assert.doesNotMatch(pageSource, /千成/);
});
