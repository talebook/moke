import type { SavedServer } from './saved-server-model.ts';

export type ConnectionEntry = Pick<SavedServer, 'id' | 'url' | 'entryRevision' | 'status'>;
export type ConnectionPhase = 'idle' | 'connecting' | 'failed' | 'cancelled' | 'connected';
export type ConnectionCode = '' | 'entry-not-found' | 'entry-changed' | 'entry-unavailable'
  | 'session-changed' | 'source-in-use' | 'read-failed' | 'guard-failed'
  | 'probe-failed' | 'activation-rejected' | 'access-required' | 'timeout' | 'cancelled' | 'authority-uncertain';

export interface ConnectionAttemptContext {
  attempt: number;
  sessionRevision: number;
  signal: AbortSignal;
}

export interface ServerConnectionState {
  phase: ConnectionPhase;
  entryId: string | null;
  entryRevision: string;
  sessionRevision: number;
  url: string;
  attempt: number;
  code: ConnectionCode;
  message: string;
  needsAccessCode: boolean;
}

export interface ServerConnectionControllerOptions {
  /** Return a fresh authoritative entry; a stale UI list is not sufficient. */
  readEntry: (id: string) => Promise<ConnectionEntry | null>;
  getSessionRevision: () => number;
  canConnect: (entry: ConnectionEntry, context: ConnectionAttemptContext) => Promise<boolean>;
  probe: (entry: ConnectionEntry, signal: AbortSignal, context: ConnectionAttemptContext) => Promise<{ needsAccessCode: boolean }>;
  /** Synchronous compare-and-activate; false must leave the live session intact. */
  activate: (entry: ConnectionEntry, expectedSessionRevision: number, prepared?: unknown) => boolean;
  /** Native prepares an unacknowledged receipt; Web keeps synchronous activation. */
  prepareActivation?: (entry: ConnectionEntry, context: ConnectionAttemptContext) => Promise<unknown>;
  acknowledgeActivation?: (entry: ConnectionEntry, context: ConnectionAttemptContext, prepared: unknown) => Promise<void>;
  cleanup?: (entry: ConnectionEntry, context: ConnectionAttemptContext, reason: ConnectionCode) => void | Promise<void>;
  onActivationUncertain?: () => void;
  onState?: (state: ServerConnectionState) => void;
  timeoutMs?: number;
}

export interface ServerConnectionController {
  getState(): ServerConnectionState;
  connect(entry: ConnectionEntry): Promise<ServerConnectionState>;
  /** A stale route cleanup can cancel its attempt without cancelling a newer one. */
  cancel(attempt?: number): ServerConnectionState;
}

const MESSAGES: Record<ConnectionCode, string> = {
  '': '',
  'entry-not-found': '该服务器已不在列表中，请重新选择。',
  'entry-changed': '该服务器条目已更改，请重新选择。',
  'entry-unavailable': '请先更正服务器条目或处理地址冲突。',
  'session-changed': '连接或登录状态已更改，请重试。',
  'source-in-use': '当前状态暂不允许连接，请稍后重试。',
  'read-failed': '无法确认已保存的服务器，请重新加载列表。',
  'guard-failed': '无法确认当前连接状态，请稍后重试。',
  'probe-failed': '连接失败，请检查服务器地址和网络后重试。',
  'activation-rejected': '连接未被确认，请重试。',
  'access-required': '该服务器需要访问码。',
  timeout: '连接超时，请重试。',
  cancelled: '连接已取消。',
  'authority-uncertain': '无法确认原生连接状态。请退出并重新启动应用后，从列表重新连接。',
};

class ConnectionFailure extends Error {
  readonly code: ConnectionCode;
  constructor(code: ConnectionCode) { super(code); this.code = code; }
}

interface Attempt {
  number: number;
  entry: ConnectionEntry;
  sessionRevision: number;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  promise: Promise<ServerConnectionState>;
  resolve: (state: ServerConnectionState) => void;
  settled: boolean;
  preparing: boolean;
  projectedRevision?: number;
}

function entrySnapshot(entry: ConnectionEntry): ConnectionEntry {
  return Object.freeze({ id: entry.id, url: entry.url, entryRevision: entry.entryRevision, status: entry.status });
}

/**
 * One candidate at a time. This module never saves entries, mutates auth, sends
 * requests, or activates before both authoritative reads and source guards pass.
 * Reader/source reservations and transport cancellation belong to the host.
 */
export function createServerConnectionController(options: ServerConnectionControllerOptions): ServerConnectionController {
  const host = { ...options };
  const timeoutMs = host.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('invalid_connection_timeout');
  }
  let state: ServerConnectionState = {
    phase: 'idle', entryId: null, entryRevision: '', sessionRevision: 0, url: '', attempt: 0, code: '', message: '', needsAccessCode: false,
  };
  let sequence = 0;
  let active: Attempt | null = null;
  let accessAttempt: Attempt | null = null;

  const contextFor = (attempt: Attempt): ConnectionAttemptContext => ({ attempt: attempt.number,
    sessionRevision: attempt.sessionRevision, signal: attempt.abort.signal });
  function cleanup(attempt: Attempt, reason: ConnectionCode): void {
    try { void Promise.resolve(host.cleanup?.(attempt.entry, contextFor(attempt), reason)).catch(() => {}); }
    catch { /* The native adapter retains its uncertain reservation on failure. */ }
  }
  function uncertain(): void { try { host.onActivationUncertain?.(); } catch { /* Fail closed in the adapter. */ } }

  function publish(next: ServerConnectionState): void {
    state = { ...next };
    // An observer cannot change controller state or turn its own rendering
    // failure into a failed connection after activation already succeeded.
    try { host.onState?.({ ...state }); } catch { /* State observation is best-effort. */ }
  }

  function resultFor(attempt: Attempt, phase: ConnectionPhase, code: ConnectionCode = ''): ServerConnectionState {
    return {
      phase, entryId: attempt.entry.id, entryRevision: attempt.entry.entryRevision, sessionRevision: attempt.sessionRevision, url: attempt.entry.url, attempt: attempt.number,
      code, message: MESSAGES[code], needsAccessCode: code === 'access-required',
    };
  }

  function finish(attempt: Attempt, result: ServerConnectionState, notify = true): void {
    if (attempt.settled) return;
    attempt.settled = true;
    if (attempt.timer !== null) clearTimeout(attempt.timer);
    if (active === attempt) {
      active = null;
      accessAttempt = result.code === 'access-required' ? attempt : null;
      if (notify) publish(result);
    }
    attempt.resolve({ ...result });
  }

  function assertCurrent(attempt: Attempt): void {
    if (active !== attempt || attempt.settled || attempt.abort.signal.aborted) {
      throw new ConnectionFailure('cancelled');
    }
    if (host.getSessionRevision() !== (attempt.projectedRevision ?? attempt.sessionRevision)) throw new ConnectionFailure('session-changed');
  }

  async function readSelectedEntry(attempt: Attempt): Promise<ConnectionEntry> {
    let entry: ConnectionEntry | null;
    try { entry = await host.readEntry(attempt.entry.id); }
    catch { assertCurrent(attempt); throw new ConnectionFailure('read-failed'); }
    assertCurrent(attempt);
    if (!entry) throw new ConnectionFailure('entry-not-found');
    if (entry.id !== attempt.entry.id || entry.url !== attempt.entry.url || entry.entryRevision !== attempt.entry.entryRevision) {
      throw new ConnectionFailure('entry-changed');
    }
    if (entry.status !== 'ready' || attempt.entry.status !== 'ready') throw new ConnectionFailure('entry-unavailable');
    return entrySnapshot(entry);
  }

  async function checkSource(attempt: Attempt, entry: ConnectionEntry): Promise<void> {
    let allowed: boolean;
    try { allowed = await host.canConnect(entry, contextFor(attempt)); }
    catch { assertCurrent(attempt); throw new ConnectionFailure('guard-failed'); }
    assertCurrent(attempt);
    if (!allowed) throw new ConnectionFailure('source-in-use');
  }

  async function run(attempt: Attempt): Promise<void> {
    try {
      assertCurrent(attempt);
      const before = await readSelectedEntry(attempt);
      await checkSource(attempt, before);
      let probe: { needsAccessCode: boolean };
      try { probe = await host.probe(before, attempt.abort.signal, contextFor(attempt)); }
      catch { assertCurrent(attempt); throw new ConnectionFailure('probe-failed'); }
      assertCurrent(attempt);
      const after = await readSelectedEntry(attempt);
      await checkSource(attempt, after);
      assertCurrent(attempt);
      if (!probe || typeof probe.needsAccessCode !== 'boolean') throw new ConnectionFailure('probe-failed');
      if (probe.needsAccessCode) throw new ConnectionFailure('access-required');
      let prepared: unknown;
      if (host.prepareActivation) {
        attempt.preparing = true;
        try { prepared = await host.prepareActivation(after, contextFor(attempt)); }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'source-in-use') {
            throw new ConnectionFailure('source-in-use');
          }
          uncertain();
          throw new ConnectionFailure('authority-uncertain');
        }
        assertCurrent(attempt);
        // An IPC receipt cannot make a subsequently edited local row current.
        await readSelectedEntry(attempt);
        await checkSource(attempt, after);
        assertCurrent(attempt);
      }
      // No await between the final identity check and the host's synchronous
      // compare-and-activate. The host owns the live session/source reservation.
      let activated: boolean;
      try { activated = host.activate(after, attempt.sessionRevision, prepared); }
      catch { throw new ConnectionFailure('activation-rejected'); }
      if (activated !== true) throw new ConnectionFailure('activation-rejected');
      attempt.projectedRevision = host.getSessionRevision();
      if (host.acknowledgeActivation) {
        try { await host.acknowledgeActivation(after, contextFor(attempt), prepared); }
        catch { uncertain(); throw new ConnectionFailure('authority-uncertain'); }
        try { assertCurrent(attempt); }
        catch { uncertain(); throw new ConnectionFailure('authority-uncertain'); }
      }
      finish(attempt, resultFor(attempt, 'connected'));
    } catch (error) {
      if (attempt.settled || active !== attempt) return;
      const code = error instanceof ConnectionFailure ? error.code : 'probe-failed';
      cleanup(attempt, code);
      finish(attempt, resultFor(attempt, code === 'cancelled' ? 'cancelled' : 'failed', code));
    }
  }

  function connect(entry: ConnectionEntry): Promise<ServerConnectionState> {
    const selected = entrySnapshot(entry);
    const revision = host.getSessionRevision();
    if (accessAttempt) {
      accessAttempt.abort.abort();
      cleanup(accessAttempt, 'cancelled');
      accessAttempt = null;
    }
    if (active && active.entry.id === selected.id && active.entry.url === selected.url
      && active.entry.entryRevision === selected.entryRevision && active.entry.status === selected.status
      && active.sessionRevision === revision) return active.promise;
    if (active) {
      const previous = active;
      previous.abort.abort();
      if (previous.preparing) uncertain();
      cleanup(previous, 'cancelled');
      // The superseded result settles immediately, but cannot replace the new
      // candidate's state when its transport eventually responds.
      finish(previous, resultFor(previous, 'cancelled', 'cancelled'), false);
    }
    let resolve!: (state: ServerConnectionState) => void;
    const promise = new Promise<ServerConnectionState>((done) => { resolve = done; });
    const attempt: Attempt = {
      number: ++sequence, entry: selected, sessionRevision: revision, abort: new AbortController(),
      timer: null, promise, resolve, settled: false, preparing: false,
    };
    active = attempt;
    attempt.timer = setTimeout(() => {
      if (active !== attempt || attempt.settled) return;
      attempt.abort.abort();
      if (attempt.preparing) uncertain();
      cleanup(attempt, 'timeout');
      finish(attempt, resultFor(attempt, 'failed', attempt.preparing ? 'authority-uncertain' : 'timeout'));
    }, timeoutMs);
    publish(resultFor(attempt, 'connecting'));
    void run(attempt);
    return promise;
  }

  return {
    getState: () => ({ ...state }),
    connect,
    cancel(expectedAttempt) {
      if (!active && state.code === 'access-required' && (expectedAttempt === undefined || expectedAttempt === state.attempt)) {
        if (accessAttempt) { accessAttempt.abort.abort(); cleanup(accessAttempt, 'cancelled'); accessAttempt = null; }
        publish({ ...state, phase: 'cancelled', code: 'cancelled', message: MESSAGES.cancelled, needsAccessCode: false, attempt: ++sequence });
      }
      if (active && (expectedAttempt === undefined || expectedAttempt === active.number)) {
        const attempt = active;
        attempt.abort.abort();
        if (attempt.preparing) uncertain();
        cleanup(attempt, 'cancelled');
        finish(attempt, resultFor(attempt, 'cancelled', attempt.preparing ? 'authority-uncertain' : 'cancelled'));
      }
      return { ...state };
    },
  };
}
