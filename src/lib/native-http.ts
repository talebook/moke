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
  settle(): Promise<void>;
  uncertain(): void;
};

const abortError = () => new DOMException('The request was aborted.', 'AbortError');

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
): Promise<Response> {
  const { maxRedirections, connectTimeout, proxy, danger, ...init } = options;
  const signal = init.signal;
  if (signal?.aborted) throw abortError();

  // No transport has been registered yet. Finish every preparation await first.
  const backend: Invoke = invokeOverride ?? (await import('@tauri-apps/api/core')).invoke;
  const invoke: Invoke = async <T>(command: string, args?: Record<string, unknown>) => backend<T>(command, args);
  const request = new Request(url, init);
  const buffer = await request.arrayBuffer();
  const data = buffer.byteLength ? Array.from(new Uint8Array(buffer)) : null;
  const headers = Array.from(request.headers.entries());
  if (signal?.aborted) throw abortError();

  let unknown = false;
  let settlement: Promise<void> | undefined;
  let requestRid: number | undefined;
  let responseRid: number | undefined;
  let requestCancellation: Promise<void> | undefined;
  let bodyCancellation: Promise<void> | undefined;
  let pendingRead: Promise<Uint8Array> | undefined;
  let nativeBodyFinished = false;
  let streamFinished = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const markUncertain = () => {
    if (!unknown) {
      unknown = true;
      signal?.removeEventListener('abort', onAbort);
      lifecycle.uncertain();
    }
  };
  const settle = () => {
    if (unknown) return Promise.reject(new Error('Native HTTP completion is uncertain.'));
    if (!settlement) {
      settlement = lifecycle.settle().then(() => {
        signal?.removeEventListener('abort', onAbort);
      }).catch((error: unknown) => {
        markUncertain();
        throw error;
      });
    }
    return settlement;
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
          markUncertain();
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
          markUncertain();
          throw failure.reason;
        }
        nativeBodyFinished = true;
        await settle();
      })();
    }
    return bodyCancellation;
  };
  function onAbort() {
    // EventTarget cannot await a listener. These tracked operations are also
    // awaited by send/pull/cancel; rejection marks uncertainty, never releases it.
    if (responseRid !== undefined) {
      cancelBody().then(() => failStream(abortError()), failStream);
    } else if (requestRid !== undefined) {
      cancelRequest().catch(failStream);
    }
  }

  try {
    await lifecycle.dispatch();
  } catch (error) {
    // The authority adapter gives this code only for a confirmed rejection,
    // before dispatch. Unknown IPC and authority-uncertain remain fail closed.
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'source-in-use')) {
      markUncertain();
    }
    throw error;
  }
  if (signal?.aborted) {
    // dispatch finished, but no plugin request has been issued.
    await settle();
    throw abortError();
  }
  try {
    // Revoke can run in the promise continuation after registration resolved.
    // Keep this last synchronous check adjacent to the first plugin dispatch.
    lifecycle.assertCurrent?.();
  } catch (error) {
    await settle();
    throw error;
  }
  signal?.addEventListener('abort', onAbort);
  try {
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
    markUncertain();
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
        throw abortError();
      }
    }
    markUncertain();
    throw error;
  }
  responseRid = metadata.rid;
  if (signal?.aborted) {
    await cancelBody();
    throw abortError();
  }

  const nullBody = request.method === 'HEAD' || [101, 103, 204, 205, 304].includes(metadata.status);
  if (nullBody) {
    await cancelBody();
    if (signal?.aborted) throw abortError();
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
          failStream(abortError());
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
        markUncertain();
        // Try to close a known body, but a failed read can never release its lease.
        try { await cancelBody(); } catch { /* uncertainty is retained */ }
        failStream(error);
      }
    },
    cancel() {
      streamFinished = true;
      return cancelBody();
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
}
