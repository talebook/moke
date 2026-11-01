import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeConnectionAuthority } from '../src/lib/native-connection.ts';
import { nativeHttpRequest } from '../src/lib/native-http.ts';

const A = { id: 'saved-a', entryRevision: 'revision-a', url: 'https://a.example:8443/team/books', status: 'ready' };
const B = { id: 'saved-b', entryRevision: 'revision-b', url: 'https://b.example:9443/team/books', status: 'ready' };
const sourceOf = (entry) => ({ id: entry.id, entryRevision: entry.entryRevision, baseUrl: entry.url });
const context = (attempt, sessionRevision = 7) => ({ attempt, sessionRevision, signal: new AbortController().signal });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const codeIs = (code, nativeCode) => (error) => error.code === code && (!nativeCode || error.nativeCode === nativeCode);

test('Reader taint is acknowledged without bootstrap and cannot be repaired by a new JS document claim', async () => {
  const calls = [];
  const authority = createNativeConnectionAuthority(async (command, args) => {
    calls.push({ command, args });
    assert.equal(command, 'moke_connection_mark_reader');
    assert.equal(args, undefined);
  });
  await authority.markReader();
  assert.equal(calls.length, 1);
  assert.equal(authority.isActive(), false);
  assert.match(authority.state.getState().message, /重新启动不会自动修复/);
  await assert.rejects(authority.initialize(), codeIs('source-in-use', 'source_provenance_tainted'));
  assert.equal(calls.length, 1);
});

test('legacy cookie provenance rejection gives a persistent migration message without minting a candidate', async () => {
  const f = fixture();
  f.before.moke_connection_begin = () => { throw { code: 'source_provenance_unknown' }; };
  await assert.rejects(f.authority.check(A, context(1)), codeIs('source-in-use', 'source_provenance_unknown'));
  assert.match(f.authority.state.getState().message, /独立干净配置/);
  assert.match(f.authority.state.getState().message, /不会清除现有 Cookie/);
  const calls = f.calls.length;
  await assert.rejects(f.authority.check(A, context(2)), codeIs('source-in-use', 'source_provenance_unknown'));
  assert.equal(f.calls.length, calls);
  assert.equal(f.host.grant, null);
});

test('a rejected durable source binding cannot dispatch HTTP and a confirmed pre-write failure can be retried', async () => {
  const f = fixture();
  await activate(f);
  const lease = f.authority.activeLease();
  f.before.moke_connection_dispatch = () => { throw { code: 'source_binding_write_failed' }; };
  await assert.rejects(f.authority.dispatch(lease, `${A.url}/api/user/info`, 'GET'), codeIs('source-in-use', 'source_binding_write_failed'));
  assert.equal(f.host.pending.size, 0);
  assert.equal(f.authority.isActive(), true);
  assert.match(f.authority.state.getState().message, /检查配置存储后重试/);
  delete f.before.moke_connection_dispatch;
  const ticket = await f.authority.dispatch(lease, `${A.url}/api/user/info`, 'GET');
  await f.authority.settle(ticket);
  assert.equal(f.host.pending.size, 0);
});

test('disconnect/offline local revoke rejects already captured active leases without resetting the host epoch', async () => {
  const f = fixture();
  await activate(f);
  const oldLease = f.authority.activeLease();
  const oldEpoch = f.host.epoch;
  f.authority.invalidateActive();
  assert.equal(f.authority.isActive(), false);
  assert.throws(() => f.authority.activeLease(), codeIs('source-in-use', 'invalid_lease'));
  const calls = f.count('moke_connection_dispatch');
  await assert.rejects(f.authority.dispatch(oldLease, `${A.url}/api/user/info`, 'GET'), codeIs('source-in-use', 'invalid_lease'));
  assert.equal(f.count('moke_connection_dispatch'), calls);
  await activate(f, B, context(2));
  assert.equal(f.authority.isActive(), true);
  assert.equal(f.host.active.id, B.id);
  assert.equal(f.host.epoch, oldEpoch + 2);
});

test('local revoke preserves pending A requests until exact settlement before B may begin', async () => {
  const f = fixture();
  await activate(f);
  const pending = await f.authority.dispatch(f.authority.activeLease(), `${A.url}/api/user/info`, 'GET');
  f.authority.invalidateActive();
  await assert.rejects(f.authority.check(B, context(2)), codeIs('source-in-use', 'source_busy'));
  assert.equal(f.host.pending.size, 1);
  assert.equal(f.host.active, null);
  await f.authority.settle(pending);
  await activate(f, B, context(3));
  assert.equal(f.host.active.id, B.id);
});

test('a local revoke racing native dispatch registration settles the known unused reservation and rejects the lease', async () => {
  const f = fixture();
  await activate(f);
  const lease = f.authority.activeLease();
  const registered = deferred();
  const released = deferred();
  f.after.moke_connection_dispatch = async (result) => {
    registered.resolve();
    await released.promise;
    return result;
  };
  const dispatching = f.authority.dispatch(lease, `${A.url}/api/user/info`, 'GET');
  await registered.promise;
  assert.equal(f.host.pending.size, 1);
  f.authority.invalidateActive();
  released.resolve();
  await assert.rejects(dispatching, codeIs('source-in-use', 'invalid_lease'));
  assert.equal(f.host.pending.size, 0);
  assert.equal(f.count('moke_connection_settle'), 1);
  await activate(f, B, context(2));
  assert.equal(f.host.active.id, B.id);
});

test('revoke after registration returned but before the transport continuation issues zero plugin HTTP', async () => {
  const f = fixture();
  await activate(f);
  const lease = f.authority.activeLease();
  let ticket;
  let httpCount = 0;
  const transport = nativeHttpRequest(`${A.url}/api/user/info`, {}, {
    async dispatch() {
      ticket = await f.authority.dispatch(lease, `${A.url}/api/user/info`, 'GET');
      queueMicrotask(() => f.authority.invalidateActive());
    },
    assertCurrent: () => f.authority.assertDispatchCurrent(ticket),
    settle: () => f.authority.settle(ticket),
    uncertain: () => f.authority.markUncertain(),
  }, async () => { httpCount++; throw new Error('HTTP must not begin'); });
  await assert.rejects(transport, codeIs('source-in-use', 'invalid_lease'));
  assert.equal(httpCount, 0);
  assert.equal(f.host.pending.size, 0);
  assert.equal(f.count('moke_connection_settle'), 1);
  assert.equal(f.authority.isActive(), false);
  await activate(f, B, context(2));
  assert.equal(f.host.active.id, B.id);
});

/** The real TS authority uses this deterministic IPC stand-in. These tests do
 * not establish Rust/Tauri dispatch, platform support, TLS or remote identity. */
function fixture() {
  const calls = [];
  const before = {};
  const after = {};
  const entries = new Map([[A.id, { ...A }], [B.id, { ...B }]]);
  const host = { epoch: 0, grant: null, receipt: null, active: null, pending: new Map(), sequence: 0 };
  const snapshot = (includeToken = false) => ({
    processId: 'fixture-process', documentGeneration: 1,
    ...(includeToken ? { documentToken: 'fixture-document' } : {}),
    epoch: host.epoch, phase: host.receipt ? 'unacked' : host.grant ? 'attempt' : host.active ? 'active' : 'idle',
    pendingCount: host.pending.size, active: host.active, reason: null,
  });
  const invoke = async (command, args) => {
    calls.push({ command, args: args && { ...args } });
    await before[command]?.(args);
    let result;
    if (command === 'moke_connection_document') result = snapshot(true);
    else {
      assert.equal(args.documentToken, 'fixture-document');
      if (command === 'moke_connection_begin') {
        if (host.grant || host.pending.size) throw { code: 'source_busy' };
        assert.equal(args.expectedEpoch, host.epoch);
        assert.deepEqual(Object.keys(args).sort(), ['documentToken', 'entryRevision', 'expectedEpoch', 'id']);
        const entry = entries.get(args.id);
        if (!entry) throw { code: 'entry_not_found' };
        if (entry.entryRevision !== args.entryRevision) throw { code: 'entry_changed' };
        host.grant = { attemptToken: `fixture-attempt-${++host.sequence}`, epoch: host.epoch, source: sourceOf(entry) };
        result = structuredClone(host.grant);
      } else if (command === 'moke_connection_check') {
        assert.equal(args.attemptToken, host.grant?.attemptToken);
        assert.equal(args.expectedEpoch, host.grant?.epoch);
        result = structuredClone(host.grant);
      } else if (command === 'moke_connection_commit') {
        assert.equal(args.attemptToken, host.grant?.attemptToken);
        assert.equal(args.expectedEpoch, host.grant?.epoch);
        if (host.pending.size) throw { code: 'source_busy' };
        host.receipt = { ...structuredClone(host.grant), epoch: ++host.epoch, sessionToken: `fixture-session-${host.epoch}` };
        host.active = { ...host.receipt.source, sessionToken: host.receipt.sessionToken, epoch: host.receipt.epoch };
        result = structuredClone(host.receipt);
      } else if (command === 'moke_connection_ack') {
        assert.equal(args.attemptToken, host.receipt?.attemptToken);
        assert.equal(args.sessionToken, host.receipt?.sessionToken);
        assert.equal(args.expectedEpoch, host.receipt?.epoch);
        result = structuredClone(host.receipt);
        host.receipt = null;
        host.grant = null;
      } else if (command === 'moke_connection_dispatch') {
        const lease = host.grant
          ? { token: host.grant.attemptToken, epoch: host.grant.epoch, source: host.grant.source }
          : host.active && { token: host.active.sessionToken, epoch: host.active.epoch, source: host.active };
        if (!lease || lease.token !== args.leaseToken || lease.epoch !== args.expectedEpoch || host.receipt) throw { code: 'invalid_lease' };
        if (!args.url.startsWith(`${lease.source.baseUrl}/`)) throw { code: 'invalid_request_url' };
        const requestId = `fixture-request-${++host.sequence}`;
        host.pending.set(requestId, { ...args });
        result = { requestId, epoch: args.expectedEpoch };
      } else if (command === 'moke_connection_settle') {
        const request = host.pending.get(args.requestId);
        if (!request || request.leaseToken !== args.leaseToken || request.expectedEpoch !== args.expectedEpoch) throw { code: 'invalid_request' };
        host.pending.delete(args.requestId);
      } else if (command === 'moke_connection_cancel') {
        if (args.sessionToken) {
          assert.equal(args.sessionToken, host.active?.sessionToken);
          assert.equal(host.receipt, null);
          host.active = null;
          host.grant = null;
          host.epoch++;
          result = snapshot();
          return result;
        }
        if (host.receipt?.attemptToken === args.attemptToken) throw { code: 'needs_restart' };
        if (host.grant?.attemptToken === args.attemptToken) host.grant = null;
        result = snapshot();
      } else if (command === 'moke_connection_status') result = snapshot();
      else assert.fail(`Unexpected fixture command ${command}`);
    }
    return after[command] ? after[command](result, args) : result;
  };
  const authority = createNativeConnectionAuthority(invoke);
  return { authority, calls, before, after, entries, host, count: (command) => calls.filter((call) => call.command === command).length };
}

async function activate(fixture, entry = A, ctx = context(1)) {
  await fixture.authority.check(entry, ctx);
  const prepared = await fixture.authority.prepare(entry, ctx);
  await fixture.authority.acknowledge(entry, ctx, prepared);
  return { ctx, prepared };
}

test('document initialization is shared once and persisted values or bare URLs cannot mint request authority', async () => {
  const f = fixture();
  const pending = deferred();
  f.before.moke_connection_document = () => pending.promise;
  assert.equal(f.authority.state.getState().phase, 'unbound');
  assert.equal(f.authority.isActive(), false);
  assert.throws(() => f.authority.activeLease(), codeIs('source-in-use', 'invalid_lease'));
  const persisted = { documentToken: 'fixture-document', leaseToken: 'stored-token', epoch: 9, baseUrl: A.url };
  await assert.rejects(f.authority.dispatch(persisted, `${A.url}/api/welcome`, 'GET'), codeIs('source-in-use', 'invalid_lease'));
  assert.equal(f.calls.length, 0);
  const first = f.authority.initialize();
  const second = f.authority.initialize();
  assert.equal(f.count('moke_connection_document'), 1);
  pending.resolve();
  assert.equal((await first).documentToken, 'fixture-document');
  assert.equal((await second).documentToken, 'fixture-document');
  await f.authority.initialize();
  assert.equal(f.count('moke_connection_document'), 1);
  assert.equal(f.authority.state.getState().phase, 'idle');
  assert.equal(f.authority.isActive(), false);
  assert.throws(() => f.authority.activeLease(), codeIs('source-in-use', 'invalid_lease'));
});

test('begin and repeated check bind stable ID, revision and full authoritative base without supplying a caller base', async () => {
  const f = fixture();
  const ctx = context(12);
  assert.equal(await f.authority.check(A, ctx), true);
  assert.equal(await f.authority.check({ ...A }, ctx), true);
  assert.equal(f.count('moke_connection_begin'), 1);
  assert.equal(f.count('moke_connection_check'), 2);
  const begin = f.calls.find((call) => call.command === 'moke_connection_begin');
  assert.deepEqual(begin.args, { documentToken: 'fixture-document', expectedEpoch: 0, id: A.id, entryRevision: A.entryRevision });
  const lease = f.authority.candidateLease(ctx.attempt, A);
  assert.equal(lease.baseUrl, A.url);
  assert.equal(Object.isFrozen(lease), true);
  const ticket = await f.authority.dispatch(lease, `${A.url}/api/welcome`, 'GET');
  assert.equal(ticket.lease, lease);
  assert.equal(Object.isFrozen(ticket), true);
  assert.equal(f.host.pending.size, 1);
  await f.authority.settle(ticket);
  assert.equal(f.host.pending.size, 0);
  const status = await f.authority.status();
  assert.equal(status.documentToken, undefined);
  assert.equal(f.count('moke_connection_document'), 1);
});

test('a host-derived base mismatch cannot issue a lease or trust the UI-selected URL', async () => {
  const f = fixture();
  const altered = { ...A, url: 'https://attacker.example/team/books' };
  await assert.rejects(f.authority.check(altered, context(1)), codeIs('authority-uncertain', 'invalid_source'));
  assert.equal(f.authority.state.getState().phase, 'needs_restart');
  assert.throws(() => f.authority.candidateLease(1, altered), codeIs('authority-uncertain'));
  assert.equal(f.count('moke_connection_dispatch'), 0);
});

test('commit gates both active and candidate network until the exact receipt is acknowledged', async () => {
  const f = fixture();
  const ctx = context(1);
  await f.authority.check(A, ctx);
  const candidate = f.authority.candidateLease(ctx.attempt, A);
  const prepared = await f.authority.prepare(A, ctx);
  assert.equal(f.authority.state.getState().phase, 'unacked');
  assert.equal(f.authority.isActive(), false);
  assert.throws(() => f.authority.activeLease(), codeIs('source-in-use'));
  assert.throws(() => f.authority.candidateLease(ctx.attempt, A), codeIs('source-in-use'));
  await assert.rejects(f.authority.dispatch(candidate, `${A.url}/api/welcome`, 'GET'), codeIs('source-in-use'));
  assert.equal(f.count('moke_connection_dispatch'), 0);
  const checks = f.count('moke_connection_check');
  assert.equal(await f.authority.check(A, ctx), true);
  assert.equal(f.count('moke_connection_check'), checks);
  await f.authority.acknowledge(A, ctx, prepared);
  assert.equal(f.authority.state.getState().phase, 'active');
  assert.equal(f.authority.isActive(), true);
  const active = f.authority.activeLease();
  assert.equal(active.baseUrl, A.url);
  assert.equal(active.epoch, prepared.epoch);
  assert.equal(active.leaseToken, prepared.sessionToken);
  const ticket = await f.authority.dispatch(active, `${A.url}/api/user`, 'GET');
  await f.authority.settle(ticket);
});

test('lost commit, acknowledgement or settlement response is sticky and cannot blind-begin another candidate', async () => {
  for (const lostCommand of ['moke_connection_commit', 'moke_connection_ack', 'moke_connection_settle']) {
    const f = fixture();
    const ctx = context(1);
    await f.authority.check(A, ctx);
    f.after[lostCommand] = () => { throw new Error('fixture response disappeared after host mutation'); };
    if (lostCommand === 'moke_connection_commit') {
      await assert.rejects(f.authority.prepare(A, ctx), codeIs('authority-uncertain'));
      assert.equal(f.host.receipt.source.baseUrl, A.url);
    } else if (lostCommand === 'moke_connection_ack') {
      const prepared = await f.authority.prepare(A, ctx);
      await assert.rejects(f.authority.acknowledge(A, ctx, prepared), codeIs('authority-uncertain'));
      assert.equal(f.host.active.baseUrl, A.url);
    } else {
      const lease = f.authority.candidateLease(ctx.attempt, A);
      const ticket = await f.authority.dispatch(lease, `${A.url}/api/welcome`, 'GET');
      await assert.rejects(f.authority.settle(ticket), codeIs('authority-uncertain'));
      assert.equal(f.host.pending.size, 0);
    }
    assert.equal(f.authority.state.getState().phase, 'needs_restart');
    assert.equal(f.authority.isActive(), false);
    const calls = f.calls.length;
    await assert.rejects(f.authority.check(B, context(2)), codeIs('authority-uncertain'));
    await assert.rejects(f.authority.initialize(), codeIs('authority-uncertain'));
    assert.throws(() => f.authority.activeLease(), codeIs('authority-uncertain'));
    assert.equal(f.calls.length, calls);
  }
});

test('precommit cancel keeps acknowledged A but cannot erase B pending IO before its exact settlement', async () => {
  const f = fixture();
  await activate(f);
  const ctxB = context(2, 8);
  await f.authority.check(B, ctxB);
  const candidateB = f.authority.candidateLease(ctxB.attempt, B);
  const ticketB = await f.authority.dispatch(candidateB, `${B.url}/api/welcome`, 'GET');
  await f.authority.cancel(ctxB.attempt);
  assert.equal(f.authority.isActive(), true);
  assert.equal(f.authority.activeLease().baseUrl, A.url);
  assert.equal(f.host.active.baseUrl, A.url);
  assert.equal(f.host.pending.size, 1);
  assert.throws(() => f.authority.candidateLease(ctxB.attempt, B), codeIs('source-in-use', 'invalid_attempt'));
  await assert.rejects(f.authority.check(B, context(3, 8)), codeIs('source-in-use', 'source_busy'));
  assert.equal(f.host.pending.size, 1);
  await f.authority.settle(ticketB);
  assert.equal(f.host.pending.size, 0);
  const settle = f.calls.find((call) => call.command === 'moke_connection_settle');
  assert.deepEqual(settle.args, { documentToken: candidateB.documentToken, leaseToken: candidateB.leaseToken,
    requestId: ticketB.requestId, expectedEpoch: ticketB.epoch });
  assert.equal(await f.authority.check(B, context(4, 8)), true);
});

test('cloned receipt and forged lease cannot acknowledge or dispatch', async () => {
  const f = fixture();
  const ctx = context(1);
  await f.authority.check(A, ctx);
  const lease = f.authority.candidateLease(ctx.attempt, A);
  await assert.rejects(f.authority.dispatch({ ...lease }, `${A.url}/api/welcome`, 'GET'), codeIs('source-in-use', 'invalid_lease'));
  assert.equal(f.count('moke_connection_dispatch'), 0);
  const prepared = await f.authority.prepare(A, ctx);
  await assert.rejects(f.authority.acknowledge(A, ctx, { ...prepared }), codeIs('authority-uncertain', 'invalid_receipt'));
  assert.equal(f.count('moke_connection_ack'), 0);
  assert.equal(f.authority.isActive(), false);
});

test('an aborted old context cannot reserve, prepare or dispatch after cancellation', async () => {
  const f = fixture();
  const abort = new AbortController();
  const old = { attempt: 1, sessionRevision: 7, signal: abort.signal };
  await f.authority.check(A, old);
  abort.abort();
  await f.authority.cancel(old.attempt);
  const begins = f.count('moke_connection_begin');
  await assert.rejects(f.authority.check(A, old), codeIs('source-in-use', 'invalid_attempt'));
  await assert.rejects(f.authority.prepare(A, old), codeIs('source-in-use', 'invalid_attempt'));
  assert.throws(() => f.authority.candidateLease(old.attempt, A), codeIs('source-in-use', 'invalid_attempt'));
  assert.equal(f.count('moke_connection_begin'), begins);
  assert.equal(f.count('moke_connection_commit'), 0);
  assert.equal(f.count('moke_connection_dispatch'), 0);
});

test('check, prepare and acknowledgement cannot reuse an attempt with a different JS session or signal', async () => {
  for (const stage of ['check', 'prepare', 'acknowledge']) {
    for (const changed of [{ sessionRevision: 8 }, { signal: new AbortController().signal }]) {
      const f = fixture();
      const current = context(1, 7);
      await f.authority.check(A, current);
      const prepared = stage === 'acknowledge' ? await f.authority.prepare(A, current) : undefined;
      const calls = f.calls.length;
      await assert.rejects(f.authority[stage](A, { ...current, ...changed }, prepared), stage === 'acknowledge'
        ? codeIs('authority-uncertain', 'invalid_receipt') : codeIs('source-in-use', 'invalid_attempt'));
      assert.equal(f.calls.length, calls);
      assert.equal(f.count('moke_connection_commit'), stage === 'acknowledge' ? 1 : 0);
    }
  }
});

test('backend unsupported remains a source rejection and never falls back to bare native URL authority', async () => {
  const f = fixture();
  f.before.moke_connection_document = () => { throw { code: 'unsupported' }; };
  await assert.rejects(f.authority.initialize(), codeIs('source-in-use', 'unsupported'));
  assert.equal(f.authority.state.getState().phase, 'unsupported');
  assert.equal(f.authority.isActive(), false);
  await assert.rejects(f.authority.check(A, context(1)), codeIs('source-in-use', 'unsupported'));
  assert.equal(f.count('moke_connection_document'), 1);
  assert.equal(f.count('moke_connection_begin'), 0);
  assert.equal(f.count('moke_connection_dispatch'), 0);
});
