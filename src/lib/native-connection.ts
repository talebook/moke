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
interface Candidate { grant: NativeGrant; context: ConnectionAttemptContext; committing: boolean; receipt?: NativeReceipt; cancellation?: Promise<void> }

export class NativeConnectionError extends Error {
  readonly code: 'source-in-use' | 'authority-uncertain';
  readonly nativeCode: string;
  constructor(nativeCode: string, uncertain = false) {
    super(uncertain ? '原生连接状态未确认，请退出并重新启动应用。' : '当前原生来源不可用于此操作，请返回列表重试。');
    this.code = uncertain ? 'authority-uncertain' : 'source-in-use';
    this.nativeCode = nativeCode;
  }
}
const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
const KNOWN_REJECTED = new Set(['unsupported', 'forbidden', 'document_unavailable', 'document_changed',
  'invalid_document', 'epoch_changed', 'source_busy', 'reader_in_use', 'entry_not_found', 'entry_changed',
  'entry_unavailable', 'registry_unavailable', 'invalid_source', 'same_hostname_conflict', 'invalid_attempt',
  'invalid_lease', 'invalid_request', 'invalid_request_url', 'invalid_method', 'unacked_commit', 'attempt_expired',
  'source_provenance_unknown', 'source_provenance_tainted', 'source_binding_unavailable', 'source_binding_write_failed']);
const matches = (source: NativeSource, entry: ConnectionEntry) => source.id === entry.id
  && source.entryRevision === entry.entryRevision && source.baseUrl === entry.url;
const sameContext = (candidate: Candidate, context: ConnectionAttemptContext) => candidate.context.attempt === context.attempt
  && candidate.context.sessionRevision === context.sessionRevision && candidate.context.signal === context.signal;
const invokeNative: NativeConnectionInvoke = async <T>(command: string, args?: Record<string, unknown>) =>
  (await import('@tauri-apps/api/core')).invoke<T>(command, args);

/** One controlled main document. Opaque tokens are host reservations, never
 * persisted authority or a proof against arbitrary callers/iframes. */
export function createNativeConnectionAuthority(invoke: NativeConnectionInvoke = invokeNative) {
  const state = createStore<{ phase: NativeSnapshot['phase'] | 'unbound' | 'unsupported'; message: string }>(() => ({ phase: 'unbound', message: '' }));
  let document: NativeSnapshot | null = null;
  let initialization: Promise<NativeSnapshot> | undefined;
  let active: NativeSession | null = null;
  let uncertain = false;
  let provenanceBlocked = '';
  let revocation: Promise<void> = Promise.resolve();
  const candidates = new Map<number, Candidate>();
  const leases = new WeakSet<object>();
  const dispatches = new WeakSet<object>();

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
  async function cancel(attempt: number): Promise<void> {
    const candidate = candidates.get(attempt);
    if (!candidate || !document) return;
    return candidate.cancellation ??= (async () => {
      if (candidate.committing || candidate.receipt) markUncertain();
      try { await invoke('moke_connection_cancel', { documentToken: document!.documentToken, attemptToken: candidate.grant.attemptToken }); }
      catch (error) { return rejected(error, true); }
      if (candidates.get(attempt) === candidate) candidates.delete(attempt);
      if (!uncertain) state.setState({ phase: active ? 'active' : 'idle', message: '' });
    })();
  }
  async function check(entry: ConnectionEntry, context: ConnectionAttemptContext): Promise<boolean> {
    entry = { ...entry }; context = { ...context };
    assertUsable(); await initialize(); assertUsable();
    await revocation; assertUsable();
    if (context.signal.aborted) throw new NativeConnectionError('invalid_attempt');
    let candidate = candidates.get(context.attempt);
    if (!candidate) {
      for (const attempt of candidates.keys()) await cancel(attempt);
      assertUsable();
      let grant: NativeGrant;
      try { grant = await invoke<NativeGrant>('moke_connection_begin', { documentToken: document!.documentToken,
        expectedEpoch: document!.epoch, id: entry.id, entryRevision: entry.entryRevision }); }
      catch (error) { return rejected(error); }
      if (!matches(grant.source, entry) || !grant.attemptToken || grant.epoch !== document!.epoch) {
        markUncertain(); throw new NativeConnectionError('invalid_source', true);
      }
      candidate = { grant, context, committing: false };
      candidates.set(context.attempt, candidate);
      context.signal.addEventListener('abort', () => { void cancel(context.attempt).catch(() => {}); }, { once: true });
      if (context.signal.aborted) { await cancel(context.attempt); throw new NativeConnectionError('invalid_attempt'); }
      state.setState({ phase: 'attempt', message: '' });
    } else if (!matches(candidate.grant.source, entry) || !sameContext(candidate, context)) {
      throw new NativeConnectionError('invalid_attempt');
    }
    // A prepared receipt pins the exact source until ack. Its epoch has already
    // advanced; the final synchronous JS guard must not begin another attempt.
    if (candidate.receipt) return true;
    let checked: NativeGrant;
    try { checked = await invoke<NativeGrant>('moke_connection_check', { documentToken: document!.documentToken,
      attemptToken: candidate.grant.attemptToken, expectedEpoch: candidate.grant.epoch }); }
    catch (error) { return rejected(error); }
    if (context.signal.aborted || !matches(checked.source, entry) || checked.attemptToken !== candidate.grant.attemptToken
        || checked.epoch !== candidate.grant.epoch) throw new NativeConnectionError('invalid_attempt');
    return true;
  }
  function candidateLease(attempt: number, entry: ConnectionEntry): NativeRequestLease {
    assertUsable();
    const candidate = candidates.get(attempt);
    if (!candidate || candidate.receipt || candidate.context.signal.aborted || !matches(candidate.grant.source, entry)) {
      throw new NativeConnectionError('invalid_attempt');
    }
    return makeLease(candidate.grant.attemptToken, candidate.grant.epoch, candidate.grant.source.baseUrl);
  }
  async function prepare(entry: ConnectionEntry, context: ConnectionAttemptContext): Promise<NativeReceipt> {
    entry = { ...entry }; context = { ...context };
    assertUsable();
    const candidate = candidates.get(context.attempt);
    if (!candidate || !sameContext(candidate, context) || candidate.context.signal.aborted || !matches(candidate.grant.source, entry)) throw new NativeConnectionError('invalid_attempt');
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
        || receipt.epoch <= candidate.grant.epoch || context.signal.aborted || uncertain) {
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
    state.setState({ phase: 'active', message: '' });
  }
  function ownsLease(lease: NativeRequestLease): boolean {
    return Boolean(active?.sessionToken === lease.leaseToken && active.epoch === lease.epoch)
      || [...candidates.values()].some((candidate) => candidate.grant.attemptToken === lease.leaseToken
        && candidate.grant.epoch === lease.epoch && !candidate.receipt && !candidate.cancellation && !candidate.context.signal.aborted);
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
    const candidate = candidates.get(attempt);
    if (!candidate || candidate.receipt || !matches(candidate.grant.source, entry)) throw new NativeConnectionError('invalid_attempt');
    const context = candidate.context;
    await cancel(attempt);
    await check(entry, context);
    return candidateLease(attempt, entry);
  }
  function invalidateActive(): void {
    // Disconnect/offline is a synchronous local revoke. Do not reset the host
    // epoch, pretend old IO settled, or reacquire an old session from status.
    const previous = active;
    active = null;
    for (const attempt of candidates.keys()) void cancel(attempt).catch(() => {});
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
    markUncertain, markReader, renewCandidate, invalidateActive,
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
