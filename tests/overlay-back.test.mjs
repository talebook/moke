import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_BACK_EVENT } from '../src/lib/native-back.ts';
import { OverlayBackStack, overlayBackStack } from '../src/lib/overlay-back.ts';

// Execute the actual listeners without mounting Next.js/React in Node. This
// catches route-listener regressions that testing the stack alone would miss.
function listenerBody(path, declaration) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `listener declaration exists in ${path}`);
  const bodyStart = start + declaration.length;
  const end = source.indexOf('\n    };', bodyStart);
  assert.notEqual(end, -1, `listener closing brace exists in ${path}`);
  return source.slice(bodyStart, end);
}

const routeBody = listenerBody('../src/components/providers/NativeBackNavigation.tsx',
  'const handleNativeBack = (event: NativeBackEvent) => {');
const overlayBody = listenerBody('../src/components/ui/use-overlay-back.ts',
  'const consume = (event: Event) => {');
const routeListener = (requestBack) => new Function('overlayBackStack', 'controller', 'requestedBackTarget',
  `return (event) => {${routeBody}}`)(overlayBackStack, { requestBack }, () => '/library');
const overlayListener = (entry) => new Function('overlayBackStack', 'entry',
  `return (event) => {${overlayBody}}`)(overlayBackStack, entry);

test('native back consumes only the top overlay; closing restores the previous owner', () => {
  const stack = new OverlayBackStack();
  const closed = [];
  assert.equal(stack.hasOpenEntry(), false);
  const dialog = stack.register(() => closed.push('dialog'));
  const menu = stack.register(() => closed.push('menu'));
  assert.equal(stack.hasOpenEntry(), true);
  assert.equal(dialog.isTop(), false);
  assert.equal(menu.isTop(), true);
  const back = new Event(APP_BACK_EVENT, { cancelable: true });
  assert.equal(stack.consume(back), true);
  assert.equal(back.defaultPrevented, true);
  assert.deepEqual(closed, ['menu']);
  menu.remove();
  assert.equal(dialog.isTop(), true);
  stack.consume(new Event(APP_BACK_EVENT));
  assert.deepEqual(closed, ['menu', 'dialog']);
  dialog.remove();
  assert.equal(stack.hasOpenEntry(), false);
  assert.equal(stack.consume(new Event(APP_BACK_EVENT)), false);
});

test('overlay cleanup is idempotent and removes ownership', () => {
  const stack = new OverlayBackStack();
  const entry = stack.register(() => assert.fail('removed overlay cannot close'));
  entry.remove();
  entry.remove();
  assert.equal(entry.isTop(), false);
  assert.equal(stack.hasOpenEntry(), false);
  assert.equal(stack.consume(new Event(APP_BACK_EVENT)), false);
});

for (const routeFirst of [true, false]) {
  for (const cancelable of [true, false]) {
    test(`native BACK closes the overlay without routing (routeFirst=${routeFirst}, cancelable=${cancelable})`, () => {
      const target = new EventTarget();
      const routes = [];
      let closed = 0;
      const entry = overlayBackStack.register(() => closed++);
      const route = routeListener((path) => routes.push(path));
      const overlay = overlayListener(entry);
      if (routeFirst) target.addEventListener(APP_BACK_EVENT, route);
      target.addEventListener(APP_BACK_EVENT, overlay, true);
      if (!routeFirst) target.addEventListener(APP_BACK_EVENT, route);
      try {
        // A window-targeted event reaches listeners in registration order;
        // capture alone cannot protect against an earlier route listener.
        const event = new Event(APP_BACK_EVENT, { cancelable });
        assert.equal(target.dispatchEvent(event), !cancelable);
        assert.equal(closed, 1);
        assert.deepEqual(routes, []);
        assert.equal(event.defaultPrevented, cancelable);

        // Match the hook's close/unmount cleanup; the next BACK must route.
        entry.remove();
        target.removeEventListener(APP_BACK_EVENT, overlay, true);
        target.dispatchEvent(new Event(APP_BACK_EVENT, { cancelable }));
        assert.deepEqual(routes, ['/library']);
        assert.equal(closed, 1);
      } finally {
        entry.remove();
      }
    });
  }
}

test('an already-consumed native BACK cannot route even without an open overlay', () => {
  const target = new EventTarget();
  target.addEventListener(APP_BACK_EVENT, routeListener(() => assert.fail('consumed event cannot route')));
  const event = new Event(APP_BACK_EVENT, { cancelable: true });
  event.preventDefault();
  target.dispatchEvent(event);
});
