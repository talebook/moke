import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/app-imports.mjs';

const BASE_A = 'https://a.example:8443/team/books';
const BASE_B = 'https://b.example:9443/other/books';
const REGISTRY_PATH = 'server-registry/moke-saved-servers-v2.json';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/** This runs the real facade/storage/controller/API/native-http JS modules.
 * Every native FS, authority and transport command below is injected. Passing
 * does not establish real Tauri IPC, platform support, TLS or Talebook auth. */
function nativeFixture() {
  const files = new Map();
  const resources = new Map();
  const requests = new Map();
  const responses = new Map();
  const events = [];
  let sequence = 100;
  const host = { epoch: 0, grant: null, receipt: null, active: null, pending: new Map(),
    documentClaims: 0, dropAck: false, readBlock: null, accessRequired: new Set(), expired: new Set() };
  function source(id, revision) {
    const raw = files.get(REGISTRY_PATH);
    if (!raw) throw { code: 'registry_unavailable' };
    const entry = JSON.parse(new TextDecoder().decode(raw)).savedServers.find((row) => row.id === id);
    if (!entry) throw { code: 'entry_not_found' };
    if (entry.entryRevision !== revision) throw { code: 'entry_changed' };
    if (entry.status !== 'ready') throw { code: 'entry_unavailable' };
    return { id: entry.id, entryRevision: entry.entryRevision, baseUrl: entry.url };
  }
  const invoke = async (command, args = {}) => {
    events.push({ command, args: structuredClone(args) });
    if (command === 'plugin:fs|exists') return files.has(args.path);
    if (command === 'plugin:fs|mkdir') return;
    if (command === 'plugin:fs|open') {
      if (args.options.createNew) {
        assert.equal(files.has(args.path), false);
        files.set(args.path, new Uint8Array());
      } else assert.equal(files.has(args.path), true);
      const rid = ++sequence;
      resources.set(rid, { path: args.path, position: 0 });
      return rid;
    }
    if (command === 'plugin:fs|fstat') {
      const file = resources.get(args.rid);
      return { size: files.get(file.path).byteLength, mtime: null, atime: null, birthtime: null, isFile: true };
    }
    if (command === 'plugin:fs|read') {
      const file = resources.get(args.rid);
      const data = files.get(file.path).slice(file.position, file.position + args.len);
      file.position += data.byteLength;
      const frame = new Uint8Array(data.byteLength + 8);
      frame.set(data);
      new DataView(frame.buffer).setBigUint64(data.byteLength, BigInt(data.byteLength), false);
      return frame;
    }
    if (command === 'plugin:fs|write') {
      const file = resources.get(args.rid);
      const bytes = new Uint8Array(args.data);
      const current = files.get(file.path);
      const next = new Uint8Array(Math.max(current.byteLength, file.position + bytes.byteLength));
      next.set(current);
      next.set(bytes, file.position);
      file.position += bytes.byteLength;
      files.set(file.path, next);
      return bytes.byteLength;
    }
    if (command === 'plugin:resources|close') { resources.delete(args.rid); return; }
    if (command === 'plugin:fs|rename') {
      assert.equal(files.has(args.oldPath), true);
      files.set(args.newPath, files.get(args.oldPath));
      files.delete(args.oldPath);
      return;
    }
    if (command === 'plugin:fs|remove') { files.delete(args.path); return; }
    if (command === 'moke_connection_document') {
      assert.equal(++host.documentClaims, 1);
      return { processId: 'injected-process', documentGeneration: 1, documentToken: 'injected-document',
        epoch: host.epoch, phase: 'idle', pendingCount: 0, active: null, reason: null };
    }
    if (command.startsWith('moke_connection_')) {
      assert.equal(args.documentToken, 'injected-document');
      if (command === 'moke_connection_begin') {
        if (host.grant || host.pending.size || host.receipt) throw { code: 'source_busy' };
        assert.equal(args.expectedEpoch, host.epoch);
        assert.equal(Object.hasOwn(args, 'baseUrl'), false);
        host.grant = { attemptToken: `grant-${++sequence}`, epoch: host.epoch, source: source(args.id, args.entryRevision) };
        return structuredClone(host.grant);
      }
      if (command === 'moke_connection_check') {
        assert.equal(args.attemptToken, host.grant.attemptToken);
        assert.equal(args.expectedEpoch, host.grant.epoch);
        if (host.expired.has(args.attemptToken)) throw { code: 'attempt_expired' };
        assert.deepEqual(source(host.grant.source.id, host.grant.source.entryRevision), host.grant.source);
        return structuredClone(host.grant);
      }
      if (command === 'moke_connection_dispatch') {
        const selected = host.grant
          ? { token: host.grant.attemptToken, epoch: host.grant.epoch, source: host.grant.source }
          : host.active && { token: host.active.sessionToken, epoch: host.active.epoch, source: host.active };
        if (!selected || host.receipt || selected.token !== args.leaseToken || selected.epoch !== args.expectedEpoch) throw { code: 'invalid_lease' };
        if (host.expired.has(selected.token)) throw { code: 'attempt_expired' };
        if (!args.url.startsWith(`${selected.source.baseUrl}/`)) throw { code: 'invalid_request_url' };
        const requestId = `dispatch-${++sequence}`;
        host.pending.set(requestId, { ...args });
        return { requestId, epoch: args.expectedEpoch };
      }
      if (command === 'moke_connection_settle') {
        const pending = host.pending.get(args.requestId);
        assert.equal(pending?.leaseToken, args.leaseToken);
        assert.equal(pending?.expectedEpoch, args.expectedEpoch);
        host.pending.delete(args.requestId);
        return;
      }
      if (command === 'moke_connection_commit') {
        assert.equal(host.pending.size, 0, 'native body settlement must precede commit');
        assert.equal(args.attemptToken, host.grant.attemptToken);
        assert.equal(args.expectedEpoch, host.grant.epoch);
        host.receipt = { ...structuredClone(host.grant), epoch: ++host.epoch, sessionToken: `session-${host.epoch}` };
        host.active = { ...host.receipt.source, sessionToken: host.receipt.sessionToken, epoch: host.epoch };
        return structuredClone(host.receipt);
      }
      if (command === 'moke_connection_ack') {
        assert.equal(args.sessionToken, host.receipt.sessionToken);
        assert.equal(args.expectedEpoch, host.receipt.epoch);
        const receipt = structuredClone(host.receipt);
        host.receipt = null;
        host.grant = null;
        if (host.dropAck) throw new Error('Injected lost ack after host mutation');
        return receipt;
      }
      if (command === 'moke_connection_cancel') {
        if (host.receipt?.attemptToken === args.attemptToken) throw { code: 'needs_restart' };
        if (host.grant?.attemptToken === args.attemptToken) host.grant = null;
        return;
      }
      assert.fail(`Unexpected injected authority command ${command}`);
    }
    if (command === 'plugin:http|fetch') {
      const rid = ++sequence;
      requests.set(rid, args.clientConfig);
      assert.deepEqual(args.clientConfig.danger, { acceptInvalidCerts: false, acceptInvalidHostnames: false });
      assert.equal(args.clientConfig.maxRedirections, 0);
      return rid;
    }
    if (command === 'plugin:http|fetch_send') {
      const config = requests.get(args.rid);
      const rid = ++sequence;
      const isA = config.url.startsWith(`${BASE_A}/`);
      const base = isA ? BASE_A : BASE_B;
      let status = 200;
      let data;
      if (config.url.endsWith('/api/captcha/config')) {
        data = { err: 'ok', config: { provider: 'image', injectedLibrary: isA ? 'a' : 'b' } };
      } else if (config.url.endsWith('/api/captcha/image')) {
        data = { err: 'ok', image: isA ? 'injected-a-image' : 'injected-b-image' };
      } else if (config.url.endsWith('/api/welcome')) {
        if (config.method === 'POST') {
          const form = new URLSearchParams(new TextDecoder().decode(Uint8Array.from(config.data)));
          if (form.get('captcha_code') !== 'injected-captcha') {
            status = 403;
            data = { err: 'captcha.required', msg: 'Injected captcha challenge' };
          } else if (form.get('invite_code') !== 'injected-valid-code') {
            status = 403;
            data = { err: 'invite.invalid', msg: 'Injected code rejection' };
          } else {
            host.accessRequired.delete(base);
            data = { err: 'ok' };
          }
        } else data = { err: host.accessRequired.has(base) ? 'ok' : 'free' };
      } else data = { err: 'ok', sys: { title: isA ? 'Injected A' : 'Injected B', version: 'fixture' },
        user: { id: isA ? 'user-a' : 'user-b', username: isA ? 'a' : 'b', is_login: true } };
      responses.set(rid, { url: config.url, bytes: new TextEncoder().encode(JSON.stringify(data)), read: false });
      return { status, statusText: status === 200 ? 'OK' : 'Forbidden', url: config.url, headers: [['content-type', 'application/json']], rid };
    }
    if (command === 'plugin:http|fetch_read_body') {
      const response = responses.get(args.rid);
      if (!response.read) {
        if (host.readBlock?.url === response.url) {
          const block = host.readBlock;
          host.readBlock = null;
          block.started.resolve();
          await block.finished.promise;
        }
        response.read = true;
        return [...response.bytes, 0];
      }
      events.push({ command: 'fixture:body-terminal', url: response.url });
      return [1];
    }
    if (command === 'plugin:http|fetch_cancel' || command === 'plugin:http|fetch_cancel_body') return;
    assert.fail(`Unexpected injected native command ${command}`);
  };
  return { files, resources, events, host, invoke,
    httpCalls: () => events.filter((event) => event.command === 'plugin:http|fetch') };
}

test('saved native servers traverse actual JS storage, controller, API and HTTP lifecycle', { timeout: 10000 }, async (t) => {
  const f = nativeFixture();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousPlatform = process.env.NEXT_PUBLIC_APP_PLATFORM;
  const persisted = new Map([['moke-active-session-v1', JSON.stringify({ version: 0, state: {
    savedServerId: 'old-profile-a', savedEntryRevision: 'old-revision', serverUrl: BASE_A,
    sessionRevision: 20, isConnected: true, token: 'injected-old-token', serverTitle: 'Old cached title',
    user: { id: 'cached-user' },
  } })]]);
  process.env.NEXT_PUBLIC_APP_PLATFORM = 'tauri';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    __TAURI_INTERNALS__: { invoke: f.invoke },
    localStorage: { getItem: (key) => persisted.get(key) ?? null,
      setItem: (key, value) => persisted.set(key, value), removeItem: (key) => persisted.delete(key) },
    setTimeout: () => 0, addEventListener() {}, removeEventListener() {},
  } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
    if (previousPlatform === undefined) delete process.env.NEXT_PUBLIC_APP_PLATFORM;
    else process.env.NEXT_PUBLIC_APP_PLATFORM = previousPlatform;
  });
  const { saveServer, loadSavedServers } = await import('../src/lib/saved-server-api.ts');
  const { useServerStore, captureServerProjection } = await import('../src/lib/store/server.ts');
  const { nativeConnection } = await import('../src/lib/native-connection.ts');
  const { savedServerConnection, submitSavedServerAccess, requestSavedServerCaptcha } = await import('../src/lib/saved-server-connection.ts');
  const api = await import('../src/lib/api.ts');
  let a;
  let b;

  await t.test('cold profile is presentation only; actual facade saves A/B without HTTP or activation', async () => {
    assert.equal(useServerStore.getState().serverUrl, BASE_A);
    assert.equal(useServerStore.getState().isConnected, false);
    assert.equal(useServerStore.getState().token, '');
    assert.equal(useServerStore.getState().user, null);
    assert.equal(useServerStore.getState().serverTitle, '');
    assert.equal(nativeConnection.isActive(), false);
    await assert.rejects(api.fetchCurrentUser(), (error) => error.code === 'source-in-use');
    assert.equal(f.events.filter((event) => event.command.startsWith('moke_connection_')).length, 0);
    const beforeSave = captureServerProjection();
    const savedA = await saveServer({ rawBaseUrl: BASE_A, displayName: 'A saved only' });
    const savedB = await saveServer({ rawBaseUrl: BASE_B, displayName: 'B saved only' });
    assert.equal(savedA.ok, true, JSON.stringify(savedA));
    assert.equal(savedB.ok, true, JSON.stringify(savedB));
    a = savedA.server;
    b = savedB.server;
    assert.notEqual(a.id, b.id);
    assert.equal(a.url, BASE_A);
    assert.equal(b.url, BASE_B);
    assert.deepEqual(captureServerProjection(), beforeSave);
    assert.equal(f.httpCalls().length, 0);
    assert.equal(f.host.documentClaims, 0);
    assert.equal(f.resources.size, 0);
    const loaded = await loadSavedServers();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.savedServers.map(({ id, url }) => ({ id, url })), [{ id: a.id, url: BASE_A }, { id: b.id, url: BASE_B }]);
  });

  await t.test('native list activation uses the saved ID/revision/full base after both probe bodies settle', async () => {
    const connected = await savedServerConnection.connect(a);
    assert.equal(connected.phase, 'connected', JSON.stringify(connected));
    assert.equal(useServerStore.getState().savedServerId, a.id);
    assert.equal(useServerStore.getState().savedEntryRevision, a.entryRevision);
    assert.equal(useServerStore.getState().serverUrl, BASE_A);
    assert.equal(nativeConnection.isActive(), true);
    assert.equal(nativeConnection.activeLease().baseUrl, BASE_A);
    assert.equal(f.host.pending.size, 0);
    const begin = f.events.find((event) => event.command === 'moke_connection_begin');
    assert.equal(begin.args.id, a.id);
    assert.equal(begin.args.entryRevision, a.entryRevision);
    assert.deepEqual(f.httpCalls().map((event) => event.args.clientConfig.url), [`${BASE_A}/api/user/info`, `${BASE_A}/api/welcome`]);
    const commitIndex = f.events.findIndex((event) => event.command === 'moke_connection_commit');
    const settled = f.events.map((event, index) => ({ event, index })).filter(({ event, index }) => event.command === 'moke_connection_settle' && index < commitIndex);
    assert.equal(settled.length, 2);
    for (const { index } of settled) assert.equal(f.events[index - 1].command, 'fixture:body-terminal');
  });

  await t.test('outstanding A body blocks switching; settled retry connects B and a late A URL cannot use B authority', async () => {
    const block = { url: `${BASE_A}/api/user/info`, started: deferred(), finished: deferred() };
    f.host.readBlock = block;
    const oldA = api.fetchCurrentUser(BASE_A);
    await block.started.promise;
    const refused = await savedServerConnection.connect(b);
    assert.equal(refused.phase, 'failed');
    assert.equal(useServerStore.getState().savedServerId, a.id);
    assert.equal(f.host.pending.size, 1);
    block.finished.resolve();
    assert.equal((await oldA).user.id, 'user-a');
    assert.equal(f.host.pending.size, 0);
    const connected = await savedServerConnection.connect(b);
    assert.equal(connected.phase, 'connected', JSON.stringify(connected));
    assert.equal(useServerStore.getState().savedServerId, b.id);
    assert.equal(useServerStore.getState().savedEntryRevision, b.entryRevision);
    assert.equal(useServerStore.getState().serverUrl, BASE_B);
    assert.equal(useServerStore.getState().token, '');
    assert.equal(useServerStore.getState().user, null);
    assert.equal(nativeConnection.activeLease().baseUrl, BASE_B);
    const beforeLate = f.httpCalls().length;
    const projection = captureServerProjection();
    await assert.rejects(api.fetchCurrentUser(BASE_A), (error) => error.code === 'source-in-use');
    assert.equal(f.httpCalls().length, beforeLate);
    assert.deepEqual(captureServerProjection(), projection);
    assert.equal(nativeConnection.isActive(), true);
  });

  await t.test('native access renews expired attempts and keeps A through captcha before settling POST and reprobe activation', async () => {
    assert.equal((await savedServerConnection.connect(a)).phase, 'connected');
    const previous = captureServerProjection();
    f.host.accessRequired.add(BASE_B);
    const beforeSelection = f.events.length;
    const needsCode = await savedServerConnection.connect(b);
    assert.equal(needsCode.code, 'access-required');
    assert.equal(needsCode.needsAccessCode, true);
    assert.deepEqual(captureServerProjection(), previous);
    const oldToken = f.host.grant.attemptToken;
    assert.equal(f.host.grant.source.id, b.id);
    assert.equal(f.events.slice(beforeSelection).some((event) => event.command === 'moke_connection_cancel'), false);
    assert.equal(f.host.pending.size, 0);

    // Simulate the host deadline without a real 15-second timer. Reusing this
    // token for check/dispatch would be rejected by the injected authority.
    f.host.expired.add(oldToken);
    const beforeChallenge = f.events.length;
    const challenge = await submitSavedServerAccess('injected-valid-code', undefined, new AbortController().signal);
    assert.deepEqual(challenge, { err: 'captcha.required', msg: 'Injected captcha challenge' });
    assert.deepEqual(captureServerProjection(), previous);
    assert.equal(savedServerConnection.getState().attempt, needsCode.attempt);
    assert.equal(savedServerConnection.getState().code, 'access-required');
    assert.equal(f.host.pending.size, 0);
    assert.notEqual(f.host.grant.attemptToken, oldToken);
    const challenged = f.events.slice(beforeChallenge);
    const renewalCancel = challenged.findIndex((event) => event.command === 'moke_connection_cancel');
    const renewalBegin = challenged.findIndex((event) => event.command === 'moke_connection_begin');
    const challengePost = challenged.findIndex((event) => event.command === 'plugin:http|fetch');
    assert.equal(challenged[renewalCancel].args.attemptToken, oldToken);
    assert.ok(renewalCancel >= 0 && renewalCancel < renewalBegin && renewalBegin < challengePost);
    assert.equal(challenged[challengePost].args.clientConfig.url, `${BASE_B}/api/welcome`);
    assert.equal(challenged[challengePost].args.clientConfig.method, 'POST');
    assert.equal(challenged.some((event) => event.command === 'moke_connection_commit'), false);

    const beforeRejectedCaptcha = f.events.length;
    const httpBeforeRejected = f.httpCalls().length;
    await assert.rejects(requestSavedServerCaptcha(`${BASE_A}/api/captcha/config`), { message: 'candidate-changed' });
    await assert.rejects(requestSavedServerCaptcha(`${BASE_B}/api/captcha/config`, { method: 'POST' }), { message: 'candidate-changed' });
    assert.equal(f.httpCalls().length, httpBeforeRejected);
    assert.equal(f.events.slice(beforeRejectedCaptcha).some((event) => event.command.startsWith('moke_connection_')), false);

    const beforeCaptcha = f.events.length;
    f.host.expired.add(f.host.grant.attemptToken);
    const configResponse = await requestSavedServerCaptcha(`${BASE_B}/api/captcha/config`);
    assert.deepEqual(await configResponse.json(), { err: 'ok', config: { provider: 'image', injectedLibrary: 'b' } });
    assert.equal(f.host.pending.size, 0);
    f.host.expired.add(f.host.grant.attemptToken);
    const imageResponse = await requestSavedServerCaptcha(`${BASE_B}/api/captcha/image`);
    assert.deepEqual(await imageResponse.json(), { err: 'ok', image: 'injected-b-image' });
    assert.equal(f.host.pending.size, 0);
    assert.deepEqual(captureServerProjection(), previous);
    assert.equal(savedServerConnection.getState().attempt, needsCode.attempt);
    assert.equal(savedServerConnection.getState().code, 'access-required');
    assert.equal(nativeConnection.isActive(), true);
    assert.equal(f.host.active.baseUrl, BASE_A);
    const captchaEvents = f.events.slice(beforeCaptcha);
    assert.deepEqual(captchaEvents.filter((event) => event.command === 'plugin:http|fetch')
      .map((event) => [event.args.clientConfig.method, event.args.clientConfig.url, event.args.clientConfig.maxRedirections, event.args.clientConfig.danger]), [
      ['GET', `${BASE_B}/api/captcha/config`, 0, { acceptInvalidCerts: false, acceptInvalidHostnames: false }],
      ['GET', `${BASE_B}/api/captcha/image`, 0, { acceptInvalidCerts: false, acceptInvalidHostnames: false }],
    ]);
    assert.equal(captchaEvents.filter((event) => event.command === 'moke_connection_begin').length, 2);
    assert.equal(captchaEvents.filter((event) => event.command === 'moke_connection_settle').length, 2);
    const captchaDispatches = captchaEvents.filter((event) => event.command === 'moke_connection_dispatch');
    assert.equal(captchaDispatches.length, 2);
    assert.equal(new Set(captchaDispatches.map((event) => event.args.leaseToken)).size, 2);
    assert.equal(captchaDispatches.some((event) => event.args.leaseToken === f.host.active.sessionToken), false);
    assert.equal(captchaEvents.some((event) => event.command === 'moke_connection_commit' || event.command === 'moke_connection_ack'), false);

    const challengeToken = f.host.grant.attemptToken;
    f.host.expired.add(challengeToken);
    const beforeAccepted = f.events.length;
    const accepted = await submitSavedServerAccess('injected-valid-code', {
      invite_code: 'must-not-replace-user-code', captcha_code: 'injected-captcha', provider: 'injected-provider',
    }, new AbortController().signal);
    assert.equal(accepted.err, 'ok');
    assert.equal(accepted.connection.phase, 'connected');
    assert.ok(accepted.connection.attempt > needsCode.attempt);
    assert.equal(useServerStore.getState().savedServerId, b.id);
    assert.equal(useServerStore.getState().serverUrl, BASE_B);
    assert.equal(nativeConnection.activeLease().baseUrl, BASE_B);
    assert.equal(f.host.pending.size, 0);
    const acceptedEvents = f.events.slice(beforeAccepted);
    const postIndex = acceptedEvents.findIndex((event) => event.command === 'plugin:http|fetch');
    const postConfig = acceptedEvents[postIndex].args.clientConfig;
    assert.equal(postConfig.url, `${BASE_B}/api/welcome`);
    assert.equal(postConfig.method, 'POST');
    const form = new URLSearchParams(new TextDecoder().decode(Uint8Array.from(postConfig.data)));
    assert.deepEqual(Object.fromEntries(form), { invite_code: 'injected-valid-code', captcha_code: 'injected-captcha', provider: 'injected-provider' });
    const postSettle = acceptedEvents.findIndex((event, index) => index > postIndex && event.command === 'moke_connection_settle');
    assert.equal(acceptedEvents[postSettle - 1].command, 'fixture:body-terminal');
    const afterPostCancel = acceptedEvents.findIndex((event, index) => index > postSettle && event.command === 'moke_connection_cancel');
    const reprobeBegin = acceptedEvents.findIndex((event, index) => index > afterPostCancel && event.command === 'moke_connection_begin');
    const reprobeCalls = acceptedEvents.filter((event, index) => index > reprobeBegin && event.command === 'plugin:http|fetch');
    assert.deepEqual(reprobeCalls.map((event) => [event.args.clientConfig.method, event.args.clientConfig.url]), [
      ['GET', `${BASE_B}/api/user/info`], ['GET', `${BASE_B}/api/welcome`],
    ]);
    const commit = acceptedEvents.findIndex((event) => event.command === 'moke_connection_commit');
    const ack = acceptedEvents.findIndex((event) => event.command === 'moke_connection_ack');
    assert.ok(postSettle > postIndex && afterPostCancel > postSettle && reprobeBegin > afterPostCancel && commit > reprobeBegin && ack > commit);
    assert.equal(acceptedEvents.filter((event, index) => index < commit && event.command === 'moke_connection_settle').length, 3);
    assert.equal(acceptedEvents.filter((event) => event.command === 'moke_connection_dispatch')
      .some((event) => event.args.leaseToken === oldToken || event.args.leaseToken === challengeToken), false);
  });

  await t.test('lost B acknowledgement restores A projection and permanently closes native request permission', async () => {
    assert.equal((await savedServerConnection.connect(a)).phase, 'connected');
    useServerStore.getState().setConnected('injected-a-token', { id: 'user-a', username: 'a', name: 'A', email: '', avatar: '', admin: false, permission: '' });
    useServerStore.getState().setServerTitle('A current session');
    const previous = captureServerProjection();
    const revision = useServerStore.getState().sessionRevision;
    f.host.dropAck = true;
    const failed = await savedServerConnection.connect(b);
    assert.equal(failed.phase, 'failed');
    assert.equal(failed.code, 'authority-uncertain');
    assert.deepEqual(captureServerProjection(), previous);
    assert.ok(useServerStore.getState().sessionRevision > revision);
    assert.equal(nativeConnection.isActive(), false);
    assert.equal(nativeConnection.state.getState().phase, 'needs_restart');
    const before = f.httpCalls().length;
    await assert.rejects(api.fetchCurrentUser(BASE_A), (error) => error.code === 'authority-uncertain');
    assert.equal(f.httpCalls().length, before);
    assert.equal((await loadSavedServers()).savedServers.length, 2);
    assert.equal(f.host.documentClaims, 1);
  });
});
