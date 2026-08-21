import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bookDetailShelfState,
  bookSummaryText,
  readStateShelfState,
  shouldLoadReadingStateFallback,
} from '../src/lib/book-detail-core.ts';

test('详情页优先使用书籍详情中已有的书架状态', () => {
  assert.equal(bookDetailShelfState({ state: { wants: 1 } }), true);
  assert.equal(bookDetailShelfState({ state: { wants: 0 } }), false);
  assert.equal(bookDetailShelfState({}), undefined);
});

test('游客无法读取个性化状态时不要求详情页登录', () => {
  assert.equal(readStateShelfState({ err: 'user.need_login' }), undefined);
  assert.equal(readStateShelfState({ err: 'ok', wants: true }), true);
  assert.equal(readStateShelfState({ err: 'ok', wants: false }), false);
});

test('游客详情页不请求需要登录的 readstate 接口', () => {
  assert.equal(shouldLoadReadingStateFallback(undefined, false), false);
  assert.equal(shouldLoadReadingStateFallback(undefined, true), true);
  assert.equal(shouldLoadReadingStateFallback(false, true), false);
});

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

test('书籍简介不会让嵌套或编码的输入重新组成 HTML 标签', () => {
  const nested = '<scr<script>alert(1)</script>ipt>正文</scr</script>ipt>';
  const encoded = '&lt;script&gt;alert(2)&lt;/script&gt;';

  assert.doesNotMatch(bookSummaryText(nested), /<\/?(?:script|style)\b/i);
  // 脚本载荷不能以纯文本形式泄漏：即使输出只渲染为 React 文本节点，
  // 也要防止未来被用于 dangerouslySetInnerHTML 之类的场景。
  assert.doesNotMatch(bookSummaryText(nested), /alert/i);
  assert.equal(bookSummaryText(encoded), '');
});

test('书籍简介会跳过 HTML 注释内容', () => {
  assert.equal(bookSummaryText('<!-- 隐藏注释 -->正文'), '正文');
  assert.equal(bookSummaryText('前言<!-- 多行\n注释 -->正文'), '前言正文');
});

test('脚本或样式代码中的比较符号不会吞掉后续正文', () => {
  assert.equal(bookSummaryText('<script>if (a < b) x()</script>正文'), '正文');
  assert.equal(bookSummaryText('<style>a < b { color: red }</style>正文'), '正文');
  assert.equal(bookSummaryText('<script>未闭合的脚本'), '');
});

test('书籍简介保留正文中的比较符号和非标签尖括号内容', () => {
  assert.equal(bookSummaryText('当 3 < 5 且 5 > 3 时'), '当 3 < 5 且 5 > 3 时');
  assert.equal(bookSummaryText('当 3 &lt; 5 且 5 &gt; 3 时'), '当 3 < 5 且 5 > 3 时');
});

test('书籍简介不会因超范围数字实体崩溃', () => {
  assert.equal(bookSummaryText('<p>&#1114112; 与 &#x110000;</p>'), '&#1114112; 与 &#x110000;');
});

test('书籍简介兼容普通文本与空值', () => {
  assert.equal(bookSummaryText('  普通简介  '), '普通简介');
  assert.equal(bookSummaryText(undefined), '');
});
