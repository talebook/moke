import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { useServerStore } from '../src/lib/store/server.ts';
import { registerReaderProgressFlush, withClosedReaderSession } from '../src/lib/reader-source.ts';

// Exercise the component's actual callback with captured hook values and the
// production session boundary. No React/native rendering claim is made here.
const source = ts.createSourceFile('developer.tsx', readFileSync(new URL('../src/app/settings/developer/page.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'viewOfflineLibrary') callback = node.initializer.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(callback, 'the sample library button must have its guarded callback');
const createCallback = new Function('busyRef', 'setBusy', 'setError', 'useServerStore', 'navigateFullDocument', 'router', ts.transpile(`return (${callback});`, { target: ts.ScriptTarget.ES2022 }));

function fixture() {
  const state = { busy: false, error: '', navigations: [] };
  const navigate = async (path) => { state.navigations.push(path); };
  const handler = createCallback({ current: false }, value => { state.busy = value; }, value => { state.error = value; }, useServerStore, navigate, { push() {} });
  return { state, handler };
}

test('sample library waits for offline entry, blocks duplicate clicks, then navigates once', async () => {
  useServerStore.getState().disconnect();
  const { state, handler } = fixture();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const remove = registerReaderProgressFlush(async () => { entered(); await gate; });
  try {
    const opening = handler();
    await started;
    assert.equal(state.busy, true);
    assert.equal(useServerStore.getState().offlineMode, false);
    await handler();
    assert.deepEqual(state.navigations, []);
    release(); await opening;
    assert.equal(state.busy, false);
    assert.equal(useServerStore.getState().offlineMode, true);
    assert.deepEqual(state.navigations, ['/library']);
  } finally { remove(); release(); useServerStore.getState().disconnect(); }
});

test('sample library reports rejected offline entry without navigation and can retry', async () => {
  useServerStore.getState().setServer('http', 'a.test', '');
  const before = useServerStore.getState();
  const { state, handler } = fixture();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const changing = withClosedReaderSession(async () => { entered(); await gate; });
  await started;
  try {
    await handler();
    assert.match(state.error, /状态正在变更/);
    assert.deepEqual(state.navigations, []);
    assert.equal(state.busy, false);
    assert.equal(useServerStore.getState().sessionId, before.sessionId);
    assert.equal(useServerStore.getState().serverUrl, before.serverUrl);
    release(); await changing;
    await handler();
    assert.equal(state.error, '');
    assert.deepEqual(state.navigations, ['/library']);
  } finally { release(); await changing; useServerStore.getState().disconnect(); }
});
