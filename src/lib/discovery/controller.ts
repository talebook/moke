import type { DiscoveryAdapter, DiscoverySnapshot, DiscoveryState, DiscoveryStatus } from './types.ts';

interface DiscoveryScheduler {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface DiscoveryControllerOptions {
  adapter: DiscoveryAdapter;
  supported: boolean;
  onChange(state: DiscoveryState): void;
  createSessionId?: () => string;
  scheduler?: DiscoveryScheduler;
}

const scheduler: DiscoveryScheduler = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function errorStatus(error: unknown): DiscoveryStatus {
  // Only explicit backend codes may identify a permission error. Silence and
  // timeouts are not evidence that local-network permission was denied.
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'permission_denied' || code === 'network_unavailable' || code === 'unsupported') return code;
  return 'error';
}

/** Owns page lifetime only. Native RR state owns expiry and source removal. */
export class DiscoveryController {
  private generation = 0;
  private sessionId: string | null = null;
  private pollTimer: unknown;
  private emptyTimer: unknown;
  private waitElapsed = false;
  private disposed = false;
  private visible = true;
  private online = true;
  private state: DiscoveryState;
  private readonly clock: DiscoveryScheduler;
  private readonly createSessionId: () => string;
  private readonly options: DiscoveryControllerOptions;
  private operations: Promise<unknown> = Promise.resolve();

  constructor(options: DiscoveryControllerOptions) {
    this.options = options;
    this.clock = options.scheduler ?? scheduler;
    this.createSessionId = options.createSessionId ?? (() => crypto.randomUUID());
    this.state = { status: options.supported ? 'searching' : 'unsupported', rows: [] };
  }

  getState(): DiscoveryState {
    return this.state;
  }

  select(rowId: string, baseUrl: string) {
    if (this.disposed || !this.sessionId || this.state.status !== 'searching') return null;
    const candidate = this.state.rows.find((row) => row.id === rowId)?.candidates
      .find((item) => item.baseUrl === baseUrl && item.joinable);
    return candidate ? { sessionId: this.sessionId, generation: this.generation, rowId, baseUrl } : null;
  }

  isSelectionCurrent(selection: import('./types.ts').DiscoverySelection): boolean {
    return this.isCurrent(selection.generation, selection.sessionId)
      && this.select(selection.rowId, selection.baseUrl) !== null;
  }

  start(): void {
    if (this.disposed) return;
    this.cancelSession();
    if (!this.options.supported) return this.publish('unsupported');
    if (!this.visible) return this.publish('paused');
    if (!this.online) return this.publish('network_unavailable');

    const generation = this.generation;
    let sessionId: string;
    try {
      sessionId = this.createSessionId();
    } catch {
      return this.publish('error');
    }
    this.sessionId = sessionId;
    this.waitElapsed = false;
    this.publish('searching');
    this.emptyTimer = this.clock.setTimeout(() => {
      if (!this.isCurrent(generation, sessionId)) return;
      this.emptyTimer = undefined;
      this.waitElapsed = true;
      if (this.state.rows.length === 0) this.publish('empty');
    }, 10_000);

    void this.launch(generation, sessionId);
  }

  retry(): void {
    this.start();
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (visible) this.start();
    else {
      this.cancelSession();
      this.publish(this.options.supported ? 'paused' : 'unsupported');
    }
  }

  setOnline(online: boolean): void {
    if (this.disposed || this.online === online) return;
    this.online = online;
    this.start();
  }

  networkChanged(): void {
    this.start();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelSession();
    this.state = { status: 'paused', rows: [] };
  }

  private publish(status: DiscoveryStatus, rows = this.state.rows): void {
    if (this.disposed) return;
    this.state = { status, rows: status === 'searching' || status === 'empty' ? rows : [] };
    this.options.onChange(this.state);
  }

  private isCurrent(generation: number, sessionId: string): boolean {
    return !this.disposed && generation === this.generation && sessionId === this.sessionId;
  }

  private stop(sessionId: string): void {
    void this.enqueue(() => this.options.adapter.stop(sessionId)).catch(() => {});
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operations.then(operation);
    // Preserve command order even if an earlier command rejected. A late old
    // start must never run after a newer start and replace its native session.
    this.operations = pending.catch(() => {});
    return pending;
  }

  private cancelSession(): void {
    this.generation += 1;
    if (this.pollTimer !== undefined) this.clock.clearTimeout(this.pollTimer);
    if (this.emptyTimer !== undefined) this.clock.clearTimeout(this.emptyTimer);
    this.pollTimer = undefined;
    this.emptyTimer = undefined;
    const sessionId = this.sessionId;
    this.sessionId = null;
    this.state = { ...this.state, rows: [] };
    if (sessionId) this.stop(sessionId);
  }

  private async launch(generation: number, sessionId: string): Promise<void> {
    try {
      await this.enqueue(async () => {
        if (!this.isCurrent(generation, sessionId)) return;
        await this.options.adapter.start(sessionId);
        if (!this.isCurrent(generation, sessionId)) {
          // Native start may finish after page cleanup. Stop before allowing
          // any next generation's start to enter the native service.
          await this.options.adapter.stop(sessionId);
        }
      });
      if (!this.isCurrent(generation, sessionId)) {
        return;
      }
      await this.poll(generation, sessionId);
    } catch (error) {
      this.fail(generation, sessionId, errorStatus(error));
    }
  }

  private fail(generation: number, sessionId: string, status: DiscoveryStatus): void {
    if (!this.isCurrent(generation, sessionId)) return;
    this.cancelSession();
    this.publish(status);
  }

  private async poll(generation: number, sessionId: string): Promise<void> {
    try {
      const snapshot: DiscoverySnapshot = await this.options.adapter.snapshot(sessionId);
      if (!this.isCurrent(generation, sessionId)) return;
      if (snapshot.sessionId !== undefined && snapshot.sessionId !== sessionId) {
        this.fail(generation, sessionId, 'error');
        return;
      }
      if (snapshot.status !== 'searching') {
        this.fail(generation, sessionId, snapshot.status === 'stopped' ? 'error' : snapshot.status);
        return;
      }
      this.publish(snapshot.rows.length === 0 && this.waitElapsed ? 'empty' : 'searching', snapshot.rows);
      // Schedule after completion: slow IPC never stacks snapshot calls.
      this.pollTimer = this.clock.setTimeout(() => {
        if (!this.isCurrent(generation, sessionId)) return;
        this.pollTimer = undefined;
        void this.poll(generation, sessionId);
      }, 1000);
    } catch (error) {
      this.fail(generation, sessionId, errorStatus(error));
    }
  }
}
