import test from 'node:test';
import assert from 'node:assert/strict';
import { OverlayBackStack } from '../src/lib/overlay-back.ts';

test('native back consumes only the top overlay; closing restores the previous owner', () => {
  const stack = new OverlayBackStack();
  const closed = [];
  const dialog = stack.register(() => closed.push('dialog'));
  const menu = stack.register(() => closed.push('menu'));
  assert.equal(dialog.isTop(), false);
  assert.equal(menu.isTop(), true);
  const back = new Event('moke:native-back', { cancelable: true });
  assert.equal(stack.consume(back, true), true);
  assert.equal(back.defaultPrevented, true);
  assert.deepEqual(closed, ['menu']);
  menu.remove();
  assert.equal(dialog.isTop(), true);
  stack.consume(new Event('moke:native-back'), true);
  assert.deepEqual(closed, ['menu', 'dialog']);
  dialog.remove();
  assert.equal(stack.consume(new Event('moke:native-back'), true), false);
});

test('preview, progress and cancellation are consumed without dismissing the dialog', () => {
  const stack = new OverlayBackStack();
  let closes = 0;
  const entry = stack.register(() => closes++);
  for (const type of ['start', 'progress', 'cancel']) {
    const event = new Event(`moke:predictive-back-${type}`, { cancelable: true });
    assert.equal(stack.consume(event, false), true);
    assert.equal(event.defaultPrevented, true);
  }
  assert.equal(closes, 0);
  entry.remove();
  entry.remove();
  assert.equal(entry.isTop(), false);
});
