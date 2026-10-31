import test from 'node:test';
import assert from 'node:assert/strict';
import { MokeApiError } from '../src/lib/api-core.ts';
import { offlineDownloadErrorMessage } from '../src/lib/offline-download-error.ts';

const messages = [
  ['book.download.in_progress', '该书籍正在下载中，请稍候。'],
  ['book.download.paused', '下载已暂停，可在下载管理中继续。'],
  ['应用上次异常退出，可继续下载', '下载已暂停，可在下载管理中继续。'],
  ['book.download.cancelled', '下载已取消。'],
  ['book.download.invalid_response', '下载失败：服务器返回的内容不是有效书籍，请检查书库响应后重试。'],
  ['book.mobi.invalid', '下载失败：MOBI/AZW 文件格式异常，请重新下载；若仍失败，请检查书库中的原文件。'],
  ['book.epub.invalid', '下载失败：服务端返回的 EPUB 文件不完整或格式错误，请重新上传该书。'],
  ['book.download.range.invalid', '下载失败：服务器返回的断点续传信息异常，请重试。'],
  ['book.download.storage_failed', '下载失败：无法保存到本地，请检查存储空间或权限。'],
  ['Failed to save book to file system', '下载失败：无法保存到本地，请检查存储空间或权限。'],
];

for (const [code, expected] of messages) {
  test(`download errors localize ${code} in live and restored snapshots`, () => {
    for (const value of [new Error(code), code, `Error: ${code}`]) {
      assert.equal(offlineDownloadErrorMessage(value, 'tauri'), expected);
      assert.equal(offlineDownloadErrorMessage(value, 'web'), expected);
    }
  });
}

test('authentication messages support typed errors and known restored strings', () => {
  for (const error of [
    new MokeApiError('Server text must not be shown', 'user.need_login', 200),
    new MokeApiError('Please sign in', 'user.need_login', 403),
    new MokeApiError('Unauthorized', 'http.401', 401),
    new Error('http.401'), 'Error: http.401', 'user.need_login', 'Error: user.need_login',
    '请先登录', 'MokeApiError: 请先登录',
  ]) assert.equal(offlineDownloadErrorMessage(error, 'tauri'), '下载需要登录，请登录后重试。');
});

test('HTTP failures retain only the numeric status, including permission errors', () => {
  for (const error of [new Error('http.403'), 'Error: http.403',
    new MokeApiError('Internal account metadata', 'permission.denied', 403)]) {
    assert.equal(offlineDownloadErrorMessage(error, 'tauri'), '下载失败，服务器返回 403。');
  }
  assert.equal(offlineDownloadErrorMessage('http.503', 'web'), '下载失败，服务器返回 503。');
});

for (const [code, reason] of [
  ['book.download.transfer_failed', '接收文件内容时连接断开'],
  ['book.download.incomplete', '文件内容接收不完整'],
]) {
  test(`${code} offers native resume and browser retry without claiming corruption`, () => {
    for (const error of [new Error(code), `Error: ${code}`, code]) {
      assert.equal(offlineDownloadErrorMessage(error, 'tauri'), `下载中断：${reason}，可在下载管理中继续。`);
      assert.equal(offlineDownloadErrorMessage(error, 'web'), `下载中断：${reason}，请重试。`);
    }
  });
}

test('unknown errors cannot display arbitrary server text or malformed codes', () => {
  for (const error of [
    new Error('<html>server diagnostics and token</html>'), 'Error: book.mobi.invalid with secret text',
    'Error: http.403 internal account data', new MokeApiError('Secret response body', 'unknown.error', 200),
    'http.999', 'RandomPrefix: book.mobi.invalid', {}, null, undefined,
  ]) {
    assert.equal(offlineDownloadErrorMessage(error, 'tauri'), '下载失败，请检查服务器连接或登录状态后重试。');
    assert.equal(offlineDownloadErrorMessage(error, 'web'), '下载失败：当前浏览器模式下可能被跨域策略拦截。桌面版会走 Tauri 原生下载通道。');
  }
});
