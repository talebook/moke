import { resolveNativeBackTarget, trackNativeRoute } from './native-back.ts';

export interface NativeBackViewTransition {
  finished: Promise<unknown>;
  updateCallbackDone?: Promise<unknown>;
  skipTransition: () => void;
}

type TimerId = ReturnType<typeof globalThis.setTimeout>;

export interface NativeBackTransitionDependencies {
  navigate: (target: string) => void;
  canAnimate: () => boolean;
  startViewTransition: (update: () => Promise<void>) => NativeBackViewTransition;
  setTransitionActive: (active: boolean) => void;
  setTimeout?: (callback: () => void, delay: number) => TimerId;
  clearTimeout?: (timerId: TimerId) => void;
}

type BackRequest = {
  from: string;
  target: string;
};

type ActiveRequest = BackRequest & {
  navigateStarted: boolean;
  destinationCommitted: boolean;
  resolveUpdate?: () => void;
  timerId?: TimerId;
  transition?: NativeBackViewTransition;
};

export const NATIVE_BACK_TRANSITION_TIMEOUT_MS = 1_000;

export function shouldAnimateNativeBack(
  runtimePlatform: string,
  motionReduced: boolean,
  viewTransitionSupported: boolean,
): boolean {
  // Desktop uses a content-scoped Web Animation instead of WebView2's broken
  // document.startViewTransition implementation.
  const nativeRuntime = runtimePlatform === 'android'
    || runtimePlatform === 'ios'
    || runtimePlatform === 'ohos'
    || runtimePlatform === 'windows'
    || runtimePlatform === 'macos'
    || runtimePlatform === 'linux'
    || runtimePlatform === 'desktop';
  return nativeRuntime && !motionReduced && viewTransitionSupported;
}

/**
 * Serializes native BACK requests without dropping them. Targets are planned
 * when each event arrives, so two quick BACK presses still mean two levels
 * even if React has not committed the first destination yet.
 */
export class NativeBackTransitionController {
  private pathname: string;
  private plannedPathname: string;
  private routeStack: string[];
  private readonly queue: BackRequest[] = [];
  private active: ActiveRequest | null = null;
  private destroyed = false;
  private readonly dependencies: NativeBackTransitionDependencies;
  private readonly scheduleTimeout: NonNullable<NativeBackTransitionDependencies['setTimeout']>;
  private readonly cancelTimeout: NonNullable<NativeBackTransitionDependencies['clearTimeout']>;

  constructor(pathname: string, dependencies: NativeBackTransitionDependencies) {
    this.pathname = pathname;
    this.dependencies = dependencies;
    this.plannedPathname = pathname;
    this.routeStack = trackNativeRoute(pathname, []);
    // Browser timer functions require the Window/Worker global as receiver in
    // WebView2. Storing them and later calling through this controller would
    // otherwise use the controller as `this` and throw "Illegal invocation".
    this.scheduleTimeout = dependencies.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.cancelTimeout = dependencies.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  }

  pathnameChanged(pathname: string): void {
    if (this.destroyed) return;

    const previousPathname = this.pathname;
    this.pathname = pathname;
    const active = this.active;
    if (active) {
      if (pathname === active.target) {
        active.destinationCommitted = true;
        this.resolveUpdate(active);
      } else if (pathname !== active.from || active.destinationCommitted) {
        // A route other than the active BACK target is a manual navigation.
        // Returning to `from` after the target already committed is also a
        // new forward navigation (for example, immediately reopening a book
        // while the previous 260ms exit animation is still finishing).
        // It supersedes queued BACK requests and becomes the sole source of
        // truth for future planning.
        this.queue.length = 0;
        this.plannedPathname = pathname;
        this.routeStack = pathname === active.from && active.destinationCommitted
          ? trackNativeRoute(pathname, this.routeStack)
          : trackNativeRoute(pathname, []);
        try {
          active.transition?.skipTransition();
        } catch {
          // The transition may have completed concurrently.
        }
        this.finish(active);
        return;
      }
    }

    // A route not produced by a queued BACK is a normal forward/tab
    // navigation and becomes the new basis for future BACK planning.
    if (!active && this.queue.length === 0 && pathname !== this.plannedPathname) {
      this.plannedPathname = pathname;
      this.routeStack = trackNativeRoute(pathname, this.routeStack);
    } else if (!active && pathname !== previousPathname && pathname === this.plannedPathname) {
      this.routeStack = trackNativeRoute(pathname, this.routeStack);
    }
  }

  requestBack(requestedTarget?: string): void {
    if (this.destroyed) return;

    const { target, nextStack } = resolveNativeBackTarget(
      this.plannedPathname,
      this.routeStack,
      requestedTarget,
    );
    const request = { from: this.plannedPathname, target };
    this.plannedPathname = target;
    this.routeStack = nextStack;
    this.queue.push(request);
    this.drain();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.queue.length = 0;
    const active = this.active;
    if (active) {
      this.clearTimer(active);
      this.resolveUpdate(active);
      try {
        active.transition?.skipTransition();
      } catch {
        // The transition may already be finished.
      }
    }
    this.active = null;
    this.dependencies.setTransitionActive(false);
  }

  private drain(): void {
    if (this.destroyed || this.active) return;
    const request = this.queue.shift();
    if (!request) return;

    const active: ActiveRequest = { ...request, navigateStarted: false, destinationCommitted: false };
    this.active = active;

    // Replacing the current pathname cannot produce a committed destination
    // snapshot. It must not acquire the animation lock.
    if (request.target === request.from || !this.dependencies.canAnimate()) {
      this.ensureNavigation(active);
      this.finish(active);
      return;
    }

    this.dependencies.setTransitionActive(true);
    const destinationCommitted = new Promise<void>((resolve) => {
      active.resolveUpdate = resolve;
    });
    try {
      active.transition = this.dependencies.startViewTransition(() => {
        if (this.destroyed || this.active !== active) return Promise.resolve();
        this.ensureNavigation(active);
        return destinationCommitted;
      });
    } catch {
      // startViewTransition can synchronously throw while another document
      // transition is active. Fall back to navigation and always release state.
      this.ensureNavigation(active);
      this.finish(active);
      return;
    }

    // Do not depend on the WebView invoking the transition update callback.
    // Some Windows WebView2 versions expose startViewTransition but can leave
    // that callback pending, which previously swallowed every BACK request.
    this.ensureNavigation(active);

    active.timerId = this.scheduleTimeout(() => {
      if (this.active !== active) return;
      // A slow route must not animate two snapshots of the old page. Skip the
      // visual transition, let router.replace finish normally, then service
      // any queued BACK request.
      this.ensureNavigation(active);
      this.resolveUpdate(active);
      try {
        active.transition?.skipTransition();
      } catch {
        // A concurrently completed transition needs no further action.
      }
      this.finish(active);
    }, NATIVE_BACK_TRANSITION_TIMEOUT_MS);

    void active.transition.updateCallbackDone?.catch(() => {
      if (this.active === active) this.ensureNavigation(active);
    });
    void active.transition.finished
      .catch(() => undefined)
      .then(() => {
        if (this.active !== active) return;
        // A skipped transition is allowed to omit its update callback.
        this.ensureNavigation(active);
        this.finish(active);
      });
  }

  private ensureNavigation(active: ActiveRequest): void {
    if (active.navigateStarted || this.destroyed) return;
    active.navigateStarted = true;
    try {
      this.dependencies.navigate(active.target);
    } catch {
      // Navigation failures must not leave BACK permanently locked.
    }
  }

  private resolveUpdate(active: ActiveRequest): void {
    const resolve = active.resolveUpdate;
    active.resolveUpdate = undefined;
    resolve?.();
  }

  private clearTimer(active: ActiveRequest): void {
    if (active.timerId === undefined) return;
    this.cancelTimeout(active.timerId);
    active.timerId = undefined;
  }

  private finish(active: ActiveRequest): void {
    if (this.active !== active) return;
    this.clearTimer(active);
    this.resolveUpdate(active);
    this.active = null;
    this.dependencies.setTransitionActive(false);
    this.drain();
  }
}
