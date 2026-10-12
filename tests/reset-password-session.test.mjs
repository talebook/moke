import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

// Execute the production form handlers/effects with deferred HTTP responses.
// The synthetic hooks let a transport deliberately ignore cancellation so the
// connection/session guards are tested independently of fetch's AbortSignal.
const moduleUrl = source => 'data:text/javascript,' + encodeURIComponent(source);
const mocks = new Map([
  ['react', `
    export const useState = value => globalThis.__resetPasswordHarness.useState(value);
    export const useRef = value => globalThis.__resetPasswordHarness.useRef(value);
    export const useEffect = (effect, deps) => globalThis.__resetPasswordHarness.useEffect(effect, deps);
  `],
  ['react/jsx-runtime', 'export const jsx = (type, props) => ({type, props}); export const jsxs = jsx;'],
  ['lucide-react', 'export const BookOpen = () => null;'],
  ['@/lib/store/server', `
    export const useServerStore = () => globalThis.__resetPasswordHarness.store;
    useServerStore.getState = useServerStore;
  `],
  ['@/lib/api', 'export const request = (...args) => globalThis.__resetPasswordHarness.request(...args);'],
  ['@/components/auth/CaptchaModal', 'export const CaptchaModal = () => null;'],
  ['@/components/auth/ServerConnectionNotice', 'export const ServerConnectionNotice = () => null;'],
  ['@/lib/native-back', 'export const requestAnimatedBack = () => {};'],
]);
registerHooks({resolve(specifier, context, next) {
  if (mocks.has(specifier)) return {url:moduleUrl(mocks.get(specifier)),shortCircuit:true};
  return next(specifier, context);
}});
const compiled = ts.transpileModule(readFileSync(new URL('../src/app/reset-password/page.tsx', import.meta.url), 'utf8'), {
  compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
const {default:ResetPasswordPage} = await import(moduleUrl(compiled));

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {resolve = done; reject = fail;});
  return {promise,resolve,reject};
}
function find(node, matches) {
  if (!node || typeof node !== 'object') return null;
  if (matches(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = find(child, matches);
    if (result) return result;
  }
  return null;
}
function createForm() {
  const slots = [], refs = [], effects = [], requests = [], updates = [];
  let cursor = 0, refCursor = 0, effectCursor = 0, tree;
  const h = globalThis.__resetPasswordHarness = {
    store:{serverTitle:'A',serverUrl:'https://a.test',connectionId:1,sessionId:1,hasHydrated:true},
    requests, updates,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => {slots[index] = value; updates.push({index,value});}];
    },
    useRef(initial) {const index = refCursor++; return refs[index] ??= {current:initial};},
    useEffect(effect, deps) {
      const index = effectCursor++;
      if (effects[index]?.deps.every((value, i) => value === deps[i])) return;
      effects[index]?.cleanup?.();
      effects[index] = {deps,cleanup:effect()};
    },
    request(url, options) {
      const pending = deferred();
      requests.push({url,options,...pending});
      return pending.promise;
    },
    render() {cursor = 0; refCursor = 0; effectCursor = 0; tree = ResetPasswordPage(); return tree;},
    fill() {
      h.render();
      find(tree, node => node.props?.placeholder === '请输入注册时的邮箱').props.onChange({target:{value:'reader@example.test'}});
      find(tree, node => node.props?.placeholder === '请输入用户名').props.onChange({target:{value:'reader'}});
      h.render();
    },
    submit() {h.render(); return find(tree, node => node.type === 'form').props.onSubmit({preventDefault(){}});},
    unmount() {for (const effect of effects) effect.cleanup?.();},
    get status() {return {loading:slots[2],error:slots[3],success:slots[4],captcha:slots[5]};},
  };
  h.fill();
  return h;
}
async function settle(request, data) {
  request.resolve({json:async () => data});
  await new Promise(resolve => setImmediate(resolve));
}

test('reset submits to the selected server with a signal and handles success/captcha/current errors', async () => {
  const h = createForm();
  try {
    h.submit();
    const first = h.requests[0];
    assert.equal(first.url, 'https://a.test/api/user/reset');
    assert.equal(first.options.method, 'POST');
    assert.equal(first.options.credentials, 'include');
    assert.equal(first.options.body.get('email'), 'reader@example.test');
    assert.equal(first.options.body.get('username'), 'reader');
    assert.ok(first.options.signal instanceof AbortSignal);
    await settle(first, {err:'captcha.required',msg:'验证码需求'});
    assert.deepEqual(h.status, {loading:false,error:'验证码需求',success:false,captcha:true});
    h.render();
    const modal = find(h.render(), node => node.type?.name === 'CaptchaModal');
    const confirmation = modal.props.onSuccess('captcha-fixture');
    assert.equal(h.requests[1].options.body.get('captcha_code'), 'captcha-fixture');
    await settle(h.requests[1], {err:'ok'});
    await confirmation;
    assert.deepEqual(h.status, {loading:false,error:'',success:true,captcha:false});
    h.submit();
    h.requests[2].reject(new Error('unavailable'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.status, {loading:false,error:'无法连接服务器',success:false,captcha:false});
  } finally {h.unmount();}
});

for (const change of ['connection', 'session']) {
  for (const outcome of ['success', 'captcha', 'error']) {
    test(`late reset ${outcome} after ${change} change cannot update a new pending form`, async () => {
      const h = createForm();
      try {
        h.submit();
        const old = h.requests[0];
        if (change === 'connection') {
          h.store = {...h.store,connectionId:2,sessionId:2,serverUrl:'https://b.test'};
        } else h.store = {...h.store,sessionId:2};
        h.render();
        assert.equal(old.options.signal.aborted, true);
        assert.deepEqual(h.status, {loading:false,error:'',success:false,captcha:false});
        h.submit();
        const current = h.requests[1];
        assert.equal(h.status.loading, true);
        const before = h.updates.length;
        if (outcome === 'error') old.reject(new Error('late failure'));
        else old.resolve({json:async () => ({err:outcome === 'success' ? 'ok' : 'captcha.required',msg:'旧服务器响应'})});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(h.updates.length, before, 'late result/catch/finally must not touch the new form');
        assert.deepEqual(h.status, {loading:true,error:'',success:false,captcha:false});
        assert.equal(current.options.signal.aborted, false);
        await settle(current, {err:'ok'});
        assert.equal(h.status.success, true);
        assert.equal(h.status.loading, false);
      } finally {h.unmount();}
    });
  }
}

test('a reset body finishing after unmount is aborted and makes no state updates', async () => {
  const h = createForm();
  h.submit();
  const body = deferred(), pending = h.requests[0];
  pending.resolve({json:() => body.promise});
  await new Promise(resolve => setImmediate(resolve));
  h.unmount();
  assert.equal(pending.options.signal.aborted, true);
  const before = h.updates.length;
  body.resolve({err:'captcha.required'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.updates.length, before);
});

test('the store context guard rejects a stale body even before effect cleanup runs', async () => {
  const h = createForm();
  try {
    h.submit();
    const pending = h.requests[0], before = h.updates.length;
    h.store = {...h.store,sessionId:2};
    await settle(pending, {err:'ok'});
    assert.equal(pending.options.signal.aborted, false, 'effect has not replayed');
    assert.equal(h.updates.length, before);
    h.render();
    assert.equal(pending.options.signal.aborted, true);
    assert.equal(h.status.loading, false);
  } finally {h.unmount();}
});
