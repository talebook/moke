import test from 'node:test';
import assert from 'node:assert/strict';

import { useToast } from '../src/lib/toast.ts';

test('toast 默认类型是 info，成功提示不再走红色 error 样式', () => {
  useToast.setState({ message: null, type: 'info' });
  useToast.getState().show('《书》已加入书架');
  assert.equal(useToast.getState().message, '《书》已加入书架');
  assert.equal(useToast.getState().type, 'info');
});

test('toast 显式传入 error 时仍使用错误类型', () => {
  useToast.setState({ message: null, type: 'info' });
  useToast.getState().show('下载失败', 'error');
  assert.equal(useToast.getState().message, '下载失败');
  assert.equal(useToast.getState().type, 'error');
});

test('toast 新消息会覆盖旧消息并重置类型', () => {
  useToast.setState({ message: null, type: 'info' });
  useToast.getState().show('先失败', 'error');
  assert.equal(useToast.getState().type, 'error');
  useToast.getState().show('后成功');
  assert.equal(useToast.getState().type, 'info');
  assert.equal(useToast.getState().message, '后成功');
});
