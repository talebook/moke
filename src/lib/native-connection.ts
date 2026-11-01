import { createStore } from 'zustand/vanilla';
import type { ConnectionAttemptContext, ConnectionEntry } from './server-connection-controller.ts';

export interface NativeSource { id: string; entryRevision: string; baseUrl: string }
export interface NativeSession extends NativeSource { sessionToken: string; epoch: number }
export interface NativeSnapshot {
  processId: string; documentGeneration: number; documentToken: string; epoch: number;
  phase: 'idle' | 'attempt' | 'unacked' | 'active' | 'needs_restart';
  pendingCount: number; active: NativeSession | null; reason: string | null;
}
export interface NativeGrant { attemptToken: string; epoch: number; source: NativeSource }
export interface NativeReceipt extends NativeGrant { sessionToken: string }
export interface NativeRequestLease { readonly documentToken: string; readonly leaseToken: string;
  readonly epoch: number; readonly baseUrl: string }
export interface NativeDispatch { readonly lease: NativeRequestLease; readonly requestId: string; readonly epoch: number }
export type NativeConnectionInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface Candidate { grant: NativeGrant; context: ConnectionAttemptContext; committing: boolean; retiring: boolean;
  receipt?: NativeReceipt; cancellation?: Promise<void> }
// This is a local selection to retry, never a request/commit permit. Retiring a
// grant cannot revoke the developer's still-current selection of the same row.
interface RetryIntent { entry: ConnectionEntry; context: ConnectionAttemptContext;
  starting?: Promise<Candidate>; renewal?: Promise<NativeRequestLease> }

export class NativeConnectionError extends Error {
  readonly code: 'source-in-use' | 'authority-uncertain';
  readonly nativeCode: string;
  constructor(nativeCode: string, uncertain = false) {
    super(uncertain ? '原生连接状态未确认，请退出并重新启动应用。'
      : nativeCode === 'source_busy' ? '前一请求仍在结束，请稍后重试。'
      : nativeCode === 'operation_busy' ? '正在处理前一操作，请稍后重试。' : '当前原生来源不可用于此操作，请返回列表重试。');
    this.code = uncertain ? 'authority-uncertain' : 'source-in-use';
    this.nativeCode = nativeCode;
  }
}
export const isNativeSourceBusy = (error: unknown): error is NativeConnectionError => error instanceof NativeConnectionError
  && error.code === 'source-in-use' && error.nativeCode === 'source_busy';
export function nativeConnectionErrorMessage(error: unknown, fallback: string): string {
  if ((error && typeof error === 'object' && 'code' in error && error.code === 'authority-uncertain')
      || nativeConnection.state.getState().phase === 'needs_restart') {
    return '原生连接状态未确认，请退出并重新启动应用。';
  }
  return error instanceof NativeConnectionError ? error.message : fallback;
}
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
const KNOWN_REJECTED = new Set(['unsupported', 'forbidden', 'document_unavailable', 'document_changed',
  'invalid_document', 'epoch_changed', 'source_busy', 'reader_in_use', 'entry_not_found', 'entry_changed',
  'entry_unavailable', 'registry_unavailable', 'invalid_source', 'same_hostname_conflict', 'invalid_attempt',
  'invalid_lease', 'invalid_request', 'invalid_request_url', 'invalid_method', 'unacked_commit', 'attempt_expired',
  'source_provenance_unknown', 'source_provenance_tainted', 'source_binding_unavailable', 'source_binding_write_failed']);
const matches = (source: NativeSource, entry: ConnectionEntry) => source.id === entry.id
  && source.entryRevision === entry.entryRevision && source.baseUrl === entry.url;
const sameContext = (candidate: { context: ConnectionAttemptContext }, context: ConnectionAttemptContext) => candidate.context.attempt === context.attempt
  && candidate.context.sessionRevision === context.sessionRevision && candidate.context.signal === context.signal;
const invokeNative: NativeConnectionInvoke = async <T>(command: string, args?: Record<string, unknown>) =>
  (await import('@tauri-apps/api/core')).invoke<T>(command, args);

/** One controlled main document. Opaque tokens are host reservations, never
 * persisted authority or a proof against arbitrary callers/iframes. */
export function createNativeConnectionAuthority(backend: NativeConnectionInvoke = invokeNative,
  options: { controlTimeoutMs?: number } = {}) {
  const controlTimeoutMs = options.controlTimeoutMs ?? 5_000;
  if (!Number.isFinite(controlTimeoutMs) || controlTimeoutMs <= 0 || controlTimeoutMs > 2_147_483_647) {
    throw new Error('invalid_native_control_timeout');
  }
  const state = createStore<{ phase: NativeSnapshot['phase'] | 'unbound' | 'unsupported'; message: string }>(() => ({ phase: 'unbound', message: '' }));
  let document: NativeSnapshot | null = null;
  let initialization: Promise<NativeSnapshot> | undefined;
  let active: NativeSession | null = null;
  let uncertain = false;
  let provenanceBlocked = '';
  let revocation: Promise<void> = Promise.resolve();
  const candidates = new Map<number, Candidate>();
  const intents = new Map<number, RetryIntent>();
  const cancellations = new Set<{ lease: NativeRequestLease; cancel: () => void }>();
  const leases = new WeakSet<object>();
  const dispatches = new WeakSet<object>();

  async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    // An IPC that never replies is still unknown, including when the host has
    // already performed the operation. Bound only the caller's wait, never the
    // host reservation, and never apply a late reply to local authority.
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        markUncertain();
        reject(new NativeConnectionError('ipc_timeout', true));
      }, controlTimeoutMs);
      let reply: Promise<T>;
      try { reply = backend<T>(command, args); }
      catch (error) { reply = Promise.reject(error); }
      void reply.then((value) => {
        if (finished) return;
        finished = true; clearTimeout(timer); resolve(value);
      }, (error: unknown) => {
        if (finished) return;
        finished = true; clearTimeout(timer); reject(error);
      });
    });
  }
  function markUncertain(): void {
    uncertain = true;
    if (provenanceBlocked) { provenanceFailure(provenanceBlocked); return; }
    state.setState({ phase: 'needs_restart', message: '无法确认原生连接状态。请退出并重新启动应用后，从列表重新连接。' });
  }
  function assertUsable(): void {
    if (provenanceBlocked) throw new NativeConnectionError(provenanceBlocked);
    if (uncertain) throw new NativeConnectionError('needs_restart', true);
  }
  function provenanceFailure(code: string): void {
    provenanceBlocked = code;
    state.setState({ phase: 'needs_restart', message: '此配置的既有 Cookie 来源无法确认。请使用独立干净配置，或完成明确的来源迁移；重新启动不会自动修复，也不会清除现有 Cookie。' });
  }
  function rejected(error: unknown, mayHaveCommitted = false): never {
    if (error instanceof NativeConnectionError && error.code === 'authority-uncertain') throw error;
    const code = errorCode(error);
    if (mayHaveCommitted || ['needs_restart', 'document_changed', 'invalid_document', 'unacked_commit'].includes(code) || !KNOWN_REJECTED.has(code)) {
      markUncertain(); throw new NativeConnectionError(code || 'ipc_unknown', true);
    }
    if (code === 'unsupported') state.setState({ phase: 'unsupported', message: '当前平台尚未验证原生列表连接。' });
    if (code === 'source_provenance_unknown' || code === 'source_provenance_tainted') provenanceFailure(code);
    if (code === 'reader_in_use') provenanceFailure('source_provenance_tainted');
    if (code === 'same_hostname_conflict') state.setState({ message: '此配置暂不支持切换同一主机或共享 Cookie 域的不同书库。请选择独立主机，或使用独立干净配置并完成明确的来源迁移。' });
    if (code === 'source_binding_unavailable' || code === 'source_binding_write_failed') {
      state.setState({ message: '无法核实或保存此配置的来源记录，请检查配置存储后重试；若仍受限，请重新启动应用。现有 Cookie 会保留。' });
    }
    throw new NativeConnectionError(code);
  }
  async function initialize(): Promise<NativeSnapshot> {
    assertUsable();
    return initialization ??= (async () => {
      let snapshot: NativeSnapshot;
      try { snapshot = await invoke<NativeSnapshot>('moke_connection_document'); }
      catch (error) { return rejected(error); }
      if (!snapshot.documentToken || snapshot.phase === 'needs_restart' || snapshot.active) {
        if (snapshot.reason === 'source_provenance_unknown' || snapshot.reason === 'source_provenance_tainted') {
          provenanceFailure(snapshot.reason); throw new NativeConnectionError(snapshot.reason);
        }
        markUncertain(); throw new NativeConnectionError('document_unavailable', true);
      }
      document = snapshot;
      state.setState({ phase: snapshot.phase, message: '' });
      return snapshot;
    })();
  }
  function makeLease(token: string, epoch: number, baseUrl: string): NativeRequestLease {
    const lease = Object.freeze({ documentToken: document!.documentToken, leaseToken: token, epoch, baseUrl });
    leases.add(lease); return lease;
  }
  function activeLease(): NativeRequestLease {
    assertUsable();
    if (!document || !active || state.getState().phase === 'unacked') throw new NativeConnectionError('invalid_lease');
    return makeLease(active.sessionToken, active.epoch, active.baseUrl);
  }
  function abortLease(token: string, epoch: number): void {
    for (const registration of cancellations) {
      if (registration.lease.documentToken === document?.documentToken
          && registration.lease.leaseToken === token && registration.lease.epoch === epoch) {
        try { registration.cancel(); } catch { markUncertain(); }
      }
    }
  }
  async function retireCandidate(attempt: number, candidate: Candidate): Promise<void> {
    if (!document) return;
    if (candidate.cancellation) return candidate.cancellation;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    candidate.cancellation = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    // Invalidate the old permit synchronously, before asking any transport to
    // abort. A cancellation callback can itself run promise continuations.
    candidate.retiring = true;
    abortLease(candidate.grant.attemptToken, candidate.grant.epoch);
    void (async () => {
      if (candidate.committing || candidate.receipt) markUncertain();
      try { await invoke('moke_connection_cancel', { documentToken: document!.documentToken, attemptToken: candidate.grant.attemptToken }); }
      catch (error) { return rejected(error, true); }
      if (candidates.get(attempt) === candidate) candidates.delete(attempt);
      if (!uncertain) {
        const remaining = [...candidates.values()].filter((current) => !current.retiring);
        state.setState({ phase: remaining.some((current) => current.committing || current.receipt) ? 'unacked'
          : remaining.length ? 'attempt' : active ? 'active' : 'idle', message: '' });
      }
    })().then(resolve, reject);
    return candidate.cancellation;
  }
  async function cancel(attempt: number): Promise<void> {
    const intent = intents.get(attempt);
    intents.delete(attempt);
    const candidate = candidates.get(attempt);
    if (candidate) await retireCandidate(attempt, candidate);
    else if (intent?.starting) {
      // A late begin result is retired by startCandidate, never made usable.
      try { await intent.starting; }
      catch (error) { if (uncertain) throw error; }
    }
  }
  function assertIntent(intent: RetryIntent): void {
    assertUsable();
    if (intents.get(intent.context.attempt) !== intent || intent.context.signal.aborted) {
      throw new NativeConnectionError('invalid_attempt');
    }
  }
  async function startCandidate(intent: RetryIntent): Promise<Candidate> {
    assertIntent(intent);
    if (intent.starting) return intent.starting;
    const { entry, context } = intent;
    const starting = (async () => {
      let grant: NativeGrant;
      try { grant = await invoke<NativeGrant>('moke_connection_begin', { documentToken: document!.documentToken,
        expectedEpoch: document!.epoch, id: entry.id, entryRevision: entry.entryRevision }); }
      catch (error) { return rejected(error); }
      if (!matches(grant.source, entry) || !grant.attemptToken || grant.epoch !== document!.epoch) {
        markUncertain(); throw new NativeConnectionError('invalid_source', true);
      }
      const candidate: Candidate = { grant, context, committing: false, retiring: false };
      if (intents.get(context.attempt) !== intent || context.signal.aborted || uncertain || provenanceBlocked) {
        await retireCandidate(context.attempt, candidate);
        assertUsable();
        throw new NativeConnectionError('invalid_attempt');
      }
      candidates.set(context.attempt, candidate);
      state.setState({ phase: 'attempt', message: '' });
      return candidate;
    })();
    intent.starting = starting;
    try { return await starting; }
    finally { if (intent.starting === starting) intent.starting = undefined; }
  }
  async function checkCandidate(entry: ConnectionEntry, context: ConnectionAttemptContext, candidate: Candidate): Promise<boolean> {
    if (candidate.retiring || candidates.get(context.attempt) !== candidate) throw new NativeConnectionError('invalid_attempt');
    // A prepared receipt pins the exact source until ack. Its epoch has already
    // advanced; the final synchronous JS guard must not begin another attempt.
    if (candidate.receipt) return true;
    let checked: NativeGrant;
    try { checked = await invoke<NativeGrant>('moke_connection_check', { documentToken: document!.documentToken,
      attemptToken: candidate.grant.attemptToken, expectedEpoch: candidate.grant.epoch }); }
    catch (error) { return rejected(error); }
    assertUsable();
    if (candidate.retiring || candidates.get(context.attempt) !== candidate || context.signal.aborted
        || !matches(checked.source, entry) || checked.attemptToken !== candidate.grant.attemptToken
        || checked.epoch !== candidate.grant.epoch) throw new NativeConnectionError('invalid_attempt');
    return true;
  }
  async function check(entry: ConnectionEntry, context: ConnectionAttemptContext): Promise<boolean> {
    entry = { ...entry }; context = { ...context };
    assertUsable(); await initialize(); assertUsable();
    await revocation; assertUsable();
    if (context.signal.aborted) throw new NativeConnectionError('invalid_attempt');
    let intent = intents.get(context.attempt);
    if (intent && (!matches({ id: intent.entry.id, entryRevision: intent.entry.entryRevision, baseUrl: intent.entry.url }, entry)
        || !sameContext(intent, context))) throw new NativeConnectionError('invalid_attempt');
    if (intent?.renewal) throw new NativeConnectionError('operation_busy');
    if (!intent) {
      for (const attempt of new Set([...intents.keys(), ...candidates.keys()])) await cancel(attempt);
      assertUsable();
      if (context.signal.aborted) throw new NativeConnectionError('invalid_attempt');
      intent = { entry, context };
      intents.set(context.attempt, intent);
      const ownedIntent = intent;
      context.signal.addEventListener('abort', () => {
        if (intents.get(context.attempt) === ownedIntent) void cancel(context.attempt).catch(() => {});
      }, { once: true });
    }
    const candidate = candidates.get(context.attempt) ?? await startCandidate(intent);
    if (!matches(candidate.grant.source, entry) || !sameContext(candidate, context)) {
      throw new NativeConnectionError('invalid_attempt');
    }
    return checkCandidate(entry, context, candidate);
  }
  function candidateLease(attempt: number, entry: ConnectionEntry): NativeRequestLease {
    assertUsable();
    const candidate = candidates.get(attempt);
    if (!candidate || candidate.retiring || candidate.receipt || candidate.context.signal.aborted || !matches(candidate.grant.source, entry)) {
      throw new NativeConnectionError('invalid_attempt');
    }
    return makeLease(candidate.grant.attemptToken, candidate.grant.epoch, candidate.grant.source.baseUrl);
  }
  async function prepare(entry: ConnectionEntry, context: ConnectionAttemptContext): Promise<NativeReceipt> {
    entry = { ...entry }; context = { ...context };
    assertUsable();
    const candidate = candidates.get(context.attempt);
    if (!candidate || candidate.retiring || !sameContext(candidate, context) || candidate.context.signal.aborted || !matches(candidate.grant.source, entry)) throw new NativeConnectionError('invalid_attempt');
    candidate.committing = true;
    state.setState({ phase: 'unacked', message: '' });
    let receipt: NativeReceipt;
    try { receipt = await invoke<NativeReceipt>('moke_connection_commit', { documentToken: document!.documentToken,
      attemptToken: candidate.grant.attemptToken, expectedEpoch: candidate.grant.epoch }); }
    catch (error) {
      candidate.committing = false;
      if (!uncertain && KNOWN_REJECTED.has(errorCode(error))) state.setState({ phase: active ? 'active' : 'attempt', message: '' });
      return rejected(error);
    }
    if (!matches(receipt.source, entry) || receipt.attemptToken !== candidate.grant.attemptToken || !receipt.sessionToken
        || receipt.epoch <= candidate.grant.epoch || context.signal.aborted || uncertain || candidate.retiring
        || candidates.get(context.attempt) !== candidate) {
      markUncertain(); throw new NativeConnectionError('invalid_receipt', true);
    }
    document!.epoch = receipt.epoch;
    candidate.receipt = receipt;
    return receipt;
  }
  async function acknowledge(entry: ConnectionEntry, context: ConnectionAttemptContext, prepared: unknown): Promise<void> {
    entry = { ...entry }; context = { ...context };
    assertUsable();
    const candidate = candidates.get(context.attempt);
    if (!candidate?.receipt || !sameContext(candidate, context) || candidate.receipt !== prepared || context.signal.aborted || !matches(candidate.receipt.source, entry)) {
      markUncertain(); throw new NativeConnectionError('invalid_receipt', true);
    }
    const receipt = candidate.receipt;
    let ack: NativeReceipt;
    try { ack = await invoke<NativeReceipt>('moke_connection_ack', { documentToken: document!.documentToken,
      attemptToken: receipt.attemptToken, sessionToken: receipt.sessionToken, expectedEpoch: receipt.epoch }); }
    catch (error) { return rejected(error, true); }
    if (context.signal.aborted || uncertain || ack.epoch !== receipt.epoch || ack.sessionToken !== receipt.sessionToken || !matches(ack.source, entry)) {
      markUncertain(); throw new NativeConnectionError('invalid_receipt', true);
    }
    active = { ...receipt.source, sessionToken: receipt.sessionToken, epoch: receipt.epoch };
    candidates.delete(context.attempt);
    intents.delete(context.attempt);
    state.setState({ phase: 'active', message: '' });
  }
  function ownsLease(lease: NativeRequestLease): boolean {
    return Boolean(active?.sessionToken === lease.leaseToken && active.epoch === lease.epoch)
      || [...candidates.values()].some((candidate) => candidate.grant.attemptToken === lease.leaseToken
        && candidate.grant.epoch === lease.epoch && !candidate.receipt && !candidate.retiring && !candidate.context.signal.aborted);
  }
  function assertLeaseCurrent(lease: NativeRequestLease): void {
    assertUsable();
    if (!leases.has(lease) || !document || lease.documentToken !== document.documentToken || state.getState().phase === 'unacked' || !ownsLease(lease)) {
      throw new NativeConnectionError('invalid_lease');
    }
  }
  function assertDispatchCurrent(ticket: NativeDispatch): void {
    if (!dispatches.has(ticket)) throw new NativeConnectionError('invalid_request');
    assertLeaseCurrent(ticket.lease);
  }
  function registerCancellation(lease: NativeRequestLease, cancel: () => void): () => void {
    assertLeaseCurrent(lease);
    const registration = { lease, cancel };
    cancellations.add(registration);
    return () => { cancellations.delete(registration); };
  }
  async function dispatch(lease: NativeRequestLease, url: string, method: string): Promise<NativeDispatch> {
    assertLeaseCurrent(lease);
    let dispatch: { requestId: string; epoch: number };
    try { dispatch = await invoke('moke_connection_dispatch', { documentToken: lease.documentToken,
      leaseToken: lease.leaseToken, expectedEpoch: lease.epoch, url, method }); }
    catch (error) { return rejected(error); }
    if (!dispatch.requestId || dispatch.epoch !== lease.epoch) { markUncertain(); throw new NativeConnectionError('invalid_request', true); }
    const ticket = Object.freeze({ lease, ...dispatch });
    dispatches.add(ticket);
    if (!ownsLease(lease) || uncertain || provenanceBlocked) {
      // Revoke raced the registration reply; no plugin request exists yet.
      // Release only this known reservation, preserving all other pending IO.
      await settle(ticket);
      throw new NativeConnectionError('invalid_lease');
    }
    return ticket;
  }
  async function settle(ticket: NativeDispatch): Promise<void> {
    try { await invoke('moke_connection_settle', { documentToken: ticket.lease.documentToken,
      leaseToken: ticket.lease.leaseToken, requestId: ticket.requestId, expectedEpoch: ticket.epoch }); }
    catch (error) { return rejected(error, true); }
    dispatches.delete(ticket);
  }
  async function markReader(): Promise<void> {
    // Every known launch must await this before any import/window/IPC dispatch.
    try { await invoke('moke_connection_mark_reader'); }
    catch (error) { return rejected(error); }
    provenanceFailure('source_provenance_tainted');
  }
  async function renewCandidate(attempt: number, entry: ConnectionEntry): Promise<NativeRequestLease> {
    assertUsable();
    entry = { ...entry };
    const intent = intents.get(attempt);
    const candidate = candidates.get(attempt);
    if (!intent || intent.context.signal.aborted || candidate?.receipt || candidate?.committing
        || intent.entry.id !== entry.id || intent.entry.entryRevision !== entry.entryRevision || intent.entry.url !== entry.url) {
      throw new NativeConnectionError('invalid_attempt');
    }
    // Reject overlapping explicit operations instead of queueing or sharing a
    // permit with a later captcha request or a mutation.
    if (intent.renewal || intent.starting) throw new NativeConnectionError('operation_busy');
    const renewal = (async () => {
      await (candidate ? retireCandidate(attempt, candidate) : Promise.resolve());
      assertIntent(intent);
      const fresh = await startCandidate(intent);
      assertIntent(intent);
      await checkCandidate(entry, intent.context, fresh);
      assertIntent(intent);
      return candidateLease(attempt, entry);
    })();
    intent.renewal = renewal;
    try { return await renewal; }
    finally { if (intent.renewal === renewal) intent.renewal = undefined; }
  }
  function invalidateActive(): void {
    // Disconnect/offline is a synchronous local revoke. Do not reset the host
    // epoch, pretend old IO settled, or reacquire an old session from status.
    const previous = active;
    active = null;
    if (previous) abortLease(previous.sessionToken, previous.epoch);
    for (const attempt of new Set([...intents.keys(), ...candidates.keys()])) void cancel(attempt).catch(() => {});
    if (!uncertain && !provenanceBlocked) state.setState({ phase: 'idle', message: '' });
    if (previous && document) {
      revocation = revocation.then(async () => {
        try {
          const snapshot = await invoke<NativeSnapshot>('moke_connection_cancel', {
            documentToken: document!.documentToken, sessionToken: previous.sessionToken });
          if (!snapshot || snapshot.active || snapshot.epoch <= previous.epoch || snapshot.phase === 'needs_restart') {
            markUncertain(); throw new NativeConnectionError('invalid_revocation', true);
          }
          document!.epoch = snapshot.epoch;
        } catch (error) { return rejected(error, true); }
      });
      // The tracked promise is awaited before every subsequent begin. A
      // synchronous store action cannot await it, so observe rejection here.
      void revocation.catch(() => {});
    }
  }
  return { state, initialize, check, prepare, acknowledge, cancel, activeLease, candidateLease, dispatch, assertDispatchCurrent, settle,
    markUncertain, markReader, renewCandidate, invalidateActive, registerCancellation,
    isActive: () => !uncertain && !provenanceBlocked && active !== null
      && (state.getState().phase === 'active' || state.getState().phase === 'attempt'),
    async status() {
      await initialize();
      try { return await invoke<NativeSnapshot>('moke_connection_status', { documentToken: document!.documentToken }); }
      catch (error) { return rejected(error, true); }
    } };
}

export const nativeConnection = createNativeConnectionAuthority();
export const isNativeConnectionRuntime = () => process.env.NEXT_PUBLIC_APP_PLATFORM === 'tauri';
