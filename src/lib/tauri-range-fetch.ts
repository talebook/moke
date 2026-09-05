type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type PluginFetchResponse = {
  status: number;
  statusText: string;
  url: string;
  headers: Array<[string, string]>;
  rid: number;
};

const BODYLESS_STATUS = new Set([101, 103, 204, 205, 304]);

function headerEntries(headers?: HeadersInit): Array<[string, string]> {
  if (!headers) return [];
  if (headers instanceof Headers) return [...headers.entries()];
  if (Array.isArray(headers)) return headers.map(([name, value]) => [name, String(value)]);
  return Object.entries(headers).map(([name, value]) => [name, String(value)]);
}

function responseWithNativeMetadata(
  body: BodyInit | null,
  metadata: PluginFetchResponse,
): Response {
  const response = new Response(body, {
    status: metadata.status,
    statusText: metadata.statusText,
    headers: metadata.headers,
  });
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: metadata.url,
  });
  return response;
}

/**
 * A narrow bridge to tauri-plugin-http for HEAD and single-range GET requests.
 *
 * The public plugin wrapper constructs a browser `Request` before invoking
 * Rust. Some mobile WebViews remove `Range` while doing that normalization,
 * so the authenticated request reaches Talebook as an ordinary GET and its
 * valid full 200 response is then (correctly) rejected by Reader. This bridge
 * serializes the already validated headers directly to the same native plugin;
 * URL ACL and the shared native cookie jar still apply.
 */
export function createTauriRangeFetch(invoke: TauriInvoke) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method || 'GET').toUpperCase();
    if (method !== 'HEAD' && method !== 'GET') {
      throw new Error('online.request_invalid');
    }
    if (init.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');

    const headers = headerEntries(init.headers);
    const allowedHeaders = new Set(['accept-encoding', 'range']);
    if (headers.some(([name]) => !allowedHeaders.has(name.toLowerCase()))) {
      throw new Error('online.request_invalid');
    }

    let requestRid: number | null = null;
    let responseRid: number | null = null;
    let settled = false;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const cancelNative = async (): Promise<void> => {
      if (responseRid !== null) {
        const rid = responseRid;
        responseRid = null;
        await invoke('plugin:http|fetch_cancel_body', { rid }).catch(() => undefined);
      } else if (requestRid !== null && !settled) {
        const rid = requestRid;
        requestRid = null;
        await invoke('plugin:http|fetch_cancel', { rid }).catch(() => undefined);
      }
    };
    const abort = () => {
      void cancelNative();
      try {
        streamController?.error(new DOMException('Request aborted', 'AbortError'));
      } catch {
        // The stream may already be closed while the page is being replaced.
      }
    };
    init.signal?.addEventListener('abort', abort, { once: true });

    try {
      requestRid = await invoke<number>('plugin:http|fetch', {
        clientConfig: {
          method,
          url,
          headers,
          data: null,
          maxRedirections: 0,
          connectTimeout: 8_000,
          proxy: null,
          danger: {
            acceptInvalidCerts: true,
            acceptInvalidHostnames: true,
          },
        },
      });
      if (init.signal?.aborted) {
        await cancelNative();
        throw new DOMException('Request aborted', 'AbortError');
      }

      const metadata = await invoke<PluginFetchResponse>('plugin:http|fetch_send', {
        rid: requestRid,
      });
      settled = true;
      responseRid = metadata.rid;
      if (init.signal?.aborted) {
        await cancelNative();
        throw new DOMException('Request aborted', 'AbortError');
      }

      if (method === 'HEAD' || BODYLESS_STATUS.has(metadata.status)) {
        await cancelNative();
        init.signal?.removeEventListener('abort', abort);
        return responseWithNativeMetadata(null, metadata);
      }

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        async pull(controller) {
          if (responseRid === null) {
            controller.close();
            return;
          }
          try {
            const data = new Uint8Array(
              await invoke<ArrayBuffer | number[]>('plugin:http|fetch_read_body', {
                rid: responseRid,
              }),
            );
            if (data.byteLength === 0) throw new Error('online.response_invalid');
            const completed = data[data.byteLength - 1] === 1;
            const chunk = data.slice(0, -1);
            if (chunk.byteLength) controller.enqueue(chunk);
            if (completed) {
              responseRid = null;
              streamController = null;
              init.signal?.removeEventListener('abort', abort);
              controller.close();
            }
          } catch (error) {
            await cancelNative();
            streamController = null;
            init.signal?.removeEventListener('abort', abort);
            controller.error(error);
          }
        },
        async cancel() {
          await cancelNative();
          streamController = null;
          init.signal?.removeEventListener('abort', abort);
        },
      }, { highWaterMark: 0 });

      return responseWithNativeMetadata(body, metadata);
    } catch (error) {
      await cancelNative();
      init.signal?.removeEventListener('abort', abort);
      throw error;
    }
  };
}

export async function tauriRangeFetch(url: string, init?: RequestInit): Promise<Response> {
  const { invoke } = await import('@tauri-apps/api/core');
  return createTauriRangeFetch(invoke)(url, init);
}
