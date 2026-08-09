import test from 'node:test';
import assert from 'node:assert/strict';

import { LongPressController, LONG_PRESS_MS } from '../src/lib/long-press.ts';

test('长按达到阈值触发菜单回调，并吞掉随后的 click', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opened = [];
  const controller = new LongPressController((x, y) => opened.push([x, y]));

  controller.start(10, 20);
  assert.equal(controller.didLongPress, false);

  t.mock.timers.tick(LONG_PRESS_MS);
  assert.equal(controller.didLongPress, true);
  assert.deepEqual(opened, [[10, 20]]);

  // 长按后手指抬起触发的 click 应被吞掉
  assert.equal(controller.consumeClick(), true);
  assert.equal(controller.consumeClick(), false);

  t.mock.timers.reset();
});

test('跨渲染复用同一 controller：长按防护在重渲染后仍有效', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new LongPressController();
  controller.start(0, 0);
  t.mock.timers.tick(LONG_PRESS_MS);

  // 模拟长按开菜单触发 setState 重渲染后生成的新闭包：
  // 新闭包读取的是同一个 controller，didLongPress 仍为 true。
  const newRenderOnClick = () => controller.consumeClick();
  assert.equal(newRenderOnClick(), true);

  t.mock.timers.reset();
});

test('短按（touchEnd 提前取消）不会触发菜单，click 不被吞', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opened = 0;
  const controller = new LongPressController(() => opened++);

  controller.start(0, 0);
  controller.cancel();
  t.mock.timers.tick(LONG_PRESS_MS + 100);

  assert.equal(opened, 0);
  assert.equal(controller.didLongPress, false);
  assert.equal(controller.consumeClick(), false);

  t.mock.timers.reset();
});

test('滑动（touchMove 取消）会取消长按计时', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opened = 0;
  const controller = new LongPressController(() => opened++);

  controller.start(0, 0);
  controller.cancel();
  t.mock.timers.tick(LONG_PRESS_MS);
  assert.equal(opened, 0);

  t.mock.timers.reset();
});

test('短按后立即长按：上一次的计时器不会残留误触', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opened = 0;
  const controller = new LongPressController(() => opened++);

  controller.start(0, 0);
  controller.cancel();
  controller.start(1, 1);
  t.mock.timers.tick(LONG_PRESS_MS - 100);
  assert.equal(opened, 0);
  t.mock.timers.tick(200);
  assert.equal(opened, 1);

  t.mock.timers.reset();
});
