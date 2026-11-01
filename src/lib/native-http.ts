type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type NativeResponse = {
  status: number;
  statusText: string;
  url: string;
  headers: [string, string][];
  rid: number;
};

type Lifecycle = {
  dispatch(): Promise<void>;
  assertCurrent?(): void;
  registerCancellation?(cancel: () => void): () => void;
  settle(): Promise<void>;
  uncertain(): void;
};

const abortError = () => new DOMException('The request was aborted.', 'AbortError');
const unknownCompletion = () => Object.assign(new Error('无法确认原生请求已结束，请退出并重新启动应用。'), {
  code: 'authority-uncertain' as const,
  nativeCode: 'http_completion_unknown',
});
const unknownMutation = () => Object.assign(new Error('此操作可能已改变服务器会话，结果尚未确认。请退出并重新启动应用后重新确认状态。'), {
  code: 'authority-uncertain' as const,
  nativeCode: 'http_mutation_result_unknown',
});

type Timing = { deadlineMs?: number; cancellationGraceMs?: number };

/**
 * Uses the installed plugin-http transport and cookie jar, while retaining the
 * host's request lease until native body IO (including cancellation) has ended.
 * A rejected IPC is not evidence of cancellation: its lease stays uncertain.
 */
export async function nativeHttpRequest(
  url: string,
  options: RequestInit & { maxRedirections?: number; connectTimeout?: number; proxy?: unknown; danger?: unknown },
  lifecycle: Lifecycle,
  invokeOverride?: Invoke,
  timing: Timing = {},
): Promise<Response> {
  const { maxRedirections, connectTimeout, proxy, danger, ...init } = options;
  const callerSignal = init.signal;
  if (callerSignal?.aborted) throw abortError();
  const deadlineMs = timing.deadlineMs ?? 30_000;
  const cancellationGraceMs = timing.cancellationGraceMs ?? 5_000;
  if (![deadlineMs, cancellationGraceMs].every((value) => Number.isFinite(value) && value > 0 && value <= 2_147_483_647)) {
    throw new Error('Invalid native HTTP deadline.');
  }

  // No transport has been registered yet. Finish every preparation await first.
  const backend: Invoke = invokeOverride ?? (await import('@tauri-apps/api/core')).invoke;
  const invoke: Invoke = async <T>(command: string, args?: Record<string, unknown>) => backend<T>(command, args);
  const request = new Request(url, init);
  const buffer = await request.arrayBuffer();
  const data = buffer.byteLength ? Array.from(new Uint8Array(buffer)) : null;
  const headers = Array.from(request.headers.entries());
  if (callerSignal?.aborted) throw abortError();
  const mutatesSession = !['GET', 'HEAD'].includes(request.method)
    || new URL(request.url).pathname.replace(/\/+$/, '').endsWith('/api/user/sign_out');

  const controller = new AbortController();
  const signal = controller.signal;
  let unknown = false;
  let settlement: Promise<void> | undefined;
  let requestRid: number | undefined;
  let responseRid: number | undefined;
  let requestCancellation: Promise<void> | undefined;
  let bodyCancellation: Promise<void> | undefined;
  let pendingRead: Promise<Uint8Array> | undefined;
  let nativeBodyFinished = false;
  let pluginIssued = false;
  let streamFinished = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  let unregisterCancellation: (() => void) | undefined;
  let rejectBoundary!: (error: unknown) => void;
  const boundary = new Promise<never>((_, reject) => { rejectBoundary = reject; });
  // The initial request race also observes this rejection after Response headers
  // have returned. Body readers/cancel callers get their own bounded exit below.
  const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, boundary]);
  const cancellationError = () => signal.reason ?? abortError();
  const finishControls = () => {
    clearTimeout(deadlineTimer);
    clearTimeout(cancellationTimer);
    callerSignal?.removeEventListener('abort', cancel);
    signal.removeEventListener('abort', onAbort);
    unregisterCancellation?.();
    unregisterCancellation = undefined;
  };

  const markUncertain = (error: unknown = unknownCompletion()) => {
    if (!unknown) {
      unknown = true;
      finishControls();
      lifecycle.uncertain();
      rejectBoundary(error);
      failStream(error);
    }
  };
  const settle = () => {
    if (unknown) return Promise.reject(new Error('Native HTTP completion is uncertain.'));
    if (!settlement) {
      settlement = lifecycle.settle().then(() => {
        finishControls();
        // Confirmed transport cancellation does not roll back a server-side
        // mutation. Its ticket may finish, but no new authority is inferred.
        if (signal.aborted && pluginIssued && mutatesSession) {
          const error = unknownMutation();
          markUncertain(error);
          throw error;
        }
      }).catch((error: unknown) => {
        markUncertain(error);
        throw error;
      });
    }
    return bounded(settlement);
  };
  const failStream = (error: unknown) => {
    if (streamController && !streamFinished) {
      streamFinished = true;
      streamController.error(error);
    }
  };
  const cancelRequest = () => {
    if (!requestCancellation) {
      requestCancellation = invoke<void>('plugin:http|fetch_cancel', { rid: requestRid })
        .catch((error: unknown) => {
          markUncertain(error);
          throw error;
        });
    }
    return requestCancellation;
  };
  const cancelBody = () => {
    if (!bodyCancellation) {
      bodyCancellation = (async () => {
        // Closing the resource table entry does not stop a read holding its Arc.
        // Await BOTH operations before declaring this transport quiescent.
        const read = pendingRead;
        const close = nativeBodyFinished
          ? Promise.resolve()
          : invoke<void>('plugin:http|fetch_cancel_body', { rid: responseRid });
        const results = await Promise.allSettled([close, read, requestCancellation]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') {
          markUncertain(failure.reason);
          throw failure.reason;
        }
        nativeBodyFinished = true;
        await settle();
      })();
    }
    return bodyCancellation;
  };
  function onAbort() {
    if (!cancellationTimer && !unknown) {
      // Cancellation ACK alone cannot prove native IO ended. This is a UI
      // bound, never permission to settle or remove a host pending record.
      cancellationTimer = setTimeout(() => markUncertain(), cancellationGraceMs);
    }
    // EventTarget cannot await a listener. These tracked operations are also
    // awaited by send/pull/cancel; rejection marks uncertainty, never releases it.
    if (responseRid !== undefined) {
      cancelBody().then(() => failStream(cancellationError()), failStream);
    } else if (requestRid !== undefined) {
      cancelRequest().catch(failStream);
    }
  }
  function cancel() { controller.abort(abortError()); }

  // A revoke may synchronously call cancel while registering. Install the
  // listener first and bind this handle before the first dispatch await.
  signal.addEventListener('abort', onAbort);
  callerSignal?.addEventListener('abort', cancel, { once: true });
  try { unregisterCancellation = lifecycle.registerCancellation?.(cancel); }
  catch (error) { finishControls(); throw error; }
  deadlineTimer = setTimeout(() => {
    controller.abort(new DOMException('Native HTTP request timed out.', 'TimeoutError'));
  }, deadlineMs);
  if (callerSignal?.aborted) cancel();
  if (signal.aborted) {
    finishControls();
    throw cancellationError();
  }

  const run = async (): Promise<Response> => {
    try {
      await lifecycle.dispatch();
    } catch (error) {
      // The authority adapter gives this code only for a confirmed rejection,
      // before dispatch. Unknown IPC and authority-uncertain remain fail closed.
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'source-in-use')) {
        markUncertain(error);
      } else {
        finishControls();
      }
      throw error;
    }
    if (signal?.aborted) {
      // dispatch finished, but no plugin request has been issued.
      await settle();
      throw cancellationError();
    }
    try {
      // Revoke can run in the promise continuation after registration resolved.
      // Keep this last synchronous check adjacent to the first plugin dispatch.
      lifecycle.assertCurrent?.();
    } catch (error) {
      await settle();
      throw error;
    }
    try {
      pluginIssued = true;
      requestRid = await invoke<number>('plugin:http|fetch', {
        clientConfig: {
          method: request.method,
          url: request.url,
          headers,
          data,
          maxRedirections,
          connectTimeout,
          proxy,
          danger,
        },
      });
    } catch (error) {
      markUncertain(error);
      throw error;
    }

    // fetch_cancel merely sends a signal. Drain fetch_send even if already aborted
    // so a confirmed cancellation, or a racing response body, is accounted for.
    if (signal?.aborted) cancelRequest().catch(failStream);
    let metadata: NativeResponse;
    try {
      metadata = await invoke<NativeResponse>('plugin:http|fetch_send', { rid: requestRid });
    } catch (error) {
      if (signal?.aborted && requestCancellation) {
        await requestCancellation;
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'Request canceled' || message === 'Request cancelled') {
          await settle();
          throw cancellationError();
        }
      }
      markUncertain(error);
      throw error;
    }
    responseRid = metadata.rid;
    if (signal?.aborted) {
      await cancelBody();
      throw cancellationError();
    }

    const nullBody = request.method === 'HEAD' || [101, 103, 204, 205, 304].includes(metadata.status);
    if (nullBody) {
      await cancelBody();
      if (signal.aborted) throw cancellationError();
    }
    const body = nullBody ? null : new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      async pull(controller) {
        if (bodyCancellation || streamFinished) return;
        const read = invoke<ArrayBuffer | number[]>('plugin:http|fetch_read_body', { rid: responseRid })
          .then((chunk) => {
            const bytes = new Uint8Array(chunk);
            const flag = bytes.at(-1);
            if (!bytes.length || (flag !== 0 && flag !== 1)) {
              throw new Error('Invalid native HTTP body frame.');
            }
            if (flag === 1) nativeBodyFinished = true;
            return bytes;
          });
        pendingRead = read;
        try {
          const bytes = await read;
          if (pendingRead === read) pendingRead = undefined;
          if (bodyCancellation) {
            await bodyCancellation;
            return;
          }
          if (signal?.aborted) {
            await cancelBody();
            failStream(cancellationError());
          } else if (nativeBodyFinished) {
            await settle();
            if (!streamFinished) {
              streamFinished = true;
              controller.close();
            }
          } else if (!streamFinished) {
            controller.enqueue(bytes.slice(0, -1));
          }
        } catch (error) {
          if (pendingRead === read) pendingRead = undefined;
          markUncertain(error);
          // Try to close a known body, but a failed read can never release its lease.
          try { await cancelBody(); } catch { /* uncertainty is retained */ }
          failStream(error);
        }
      },
      cancel() {
        streamFinished = true;
        // Stream cancellation itself also needs a bound, including when the
        // native resource close or an outstanding Arc read never replies.
        if (!signal.aborted) controller.abort(abortError());
        return bounded(cancelBody());
      },
    }, { highWaterMark: 0 });

    const decorate = (response: Response): Response => {
      Object.defineProperty(response, 'url', { value: metadata.url });
      Object.defineProperty(response, 'headers', { value: new Headers(metadata.headers) });
      const clone = response.clone.bind(response);
      Object.defineProperty(response, 'clone', { value: () => decorate(clone()) });
      return response;
    };
    try {
      return decorate(new Response(body, { status: metadata.status, statusText: metadata.statusText }));
    } catch (error) {
      // A synchronous Response/Headers validation error still owns a native body.
      await cancelBody();
      throw error;
    }
  };
  return bounded(run());
}
