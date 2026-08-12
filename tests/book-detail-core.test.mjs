import test from 'node:test';
import assert from 'node:assert/strict';

import { bookSummaryText } from '../src/lib/book-detail-core.ts';

test('书籍简介会把 Talebook HTML 转成可读纯文本', () => {
  assert.equal(
    bookSummaryText('<p>第一段&nbsp;内容</p><p>第二段<br>换行 &amp; 符号</p>'),
    '第一段 内容\n第二段\n换行 & 符号',
  );
});

test('书籍简介会清除脚本和样式内容', () => {
  assert.equal(
    bookSummaryText('<style>.bad{display:none}</style><p>正文</p><script>alert(1)</script>'),
    '正文',
  );
});

test('书籍简介兼容普通文本与空值', () => {
  assert.equal(bookSummaryText('  普通简介  '), '普通简介');
  assert.equal(bookSummaryText(undefined), '');
});
