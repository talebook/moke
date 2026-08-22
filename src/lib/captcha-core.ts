export interface GeetestCaptchaConfig {
  captchaId?: string;
  sdkUrl?: unknown;
}

export const DEFAULT_GEETEST_SDK_URL = 'https://static.geetest.com/v4/gt4.js';
export const CAPTCHA_SANDBOX_ORIGIN = 'null';

const GEETEST_SDK_HOSTS = new Set(['static.geetest.com']);
const CAPTCHA_SANDBOX_MESSAGE_KIND = 'moke-captcha-sandbox-v1';

export type CaptchaSandboxMessage =
  | { type: 'success'; payload: unknown }
  | { type: 'error'; payload: unknown };

export interface ImageCaptchaRequestCallbacks {
  onImage: (image: string) => void;
  onError: (message: string) => void;
  onLoadingChange: (loading: boolean) => void;
}

export interface ImageCaptchaRequestLifecycle {
  load: (
    requestImage: (signal: AbortSignal) => Promise<unknown>,
    callbacks: ImageCaptchaRequestCallbacks,
  ) => Promise<void>;
  cancel: () => void;
}

interface ActiveImageCaptchaRequest {
  controller: AbortController;
  callbacks: ImageCaptchaRequestCallbacks;
}

/**
 * Keeps only the newest image-captcha request active. Aborting is best-effort
 * because a platform fetch may still settle after cancellation, so callback
 * delivery is also guarded by the active request identity.
 */
export function createImageCaptchaRequestLifecycle(): ImageCaptchaRequestLifecycle {
  let activeRequest: ActiveImageCaptchaRequest | null = null;

  const cancel = () => {
    const request = activeRequest;
    if (!request) return;

    activeRequest = null;
    request.controller.abort();
    request.callbacks.onLoadingChange(false);
  };

  const load = async (
    requestImage: (signal: AbortSignal) => Promise<unknown>,
    callbacks: ImageCaptchaRequestCallbacks,
  ) => {
    cancel();

    const request: ActiveImageCaptchaRequest = {
      controller: new AbortController(),
      callbacks,
    };
    activeRequest = request;
    callbacks.onLoadingChange(true);

    const isCurrent = () => (
      activeRequest === request && !request.controller.signal.aborted
    );
    const finish = () => {
      if (activeRequest !== request) return;
      activeRequest = null;
      callbacks.onLoadingChange(false);
    };

    let payload: unknown;
    try {
      payload = await requestImage(request.controller.signal);
    } catch {
      if (!isCurrent()) return;
      try {
        callbacks.onError('网络错误，无法加载验证码');
      } finally {
        finish();
      }
      return;
    }

    if (!isCurrent()) return;
    const data = payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : {};

    try {
      if (data.err === 'ok' && typeof data.image === 'string' && data.image) {
        callbacks.onImage(data.image);
      } else {
        callbacks.onError(
          typeof data.msg === 'string' && data.msg ? data.msg : '无法加载验证码',
        );
      }
    } finally {
      finish();
    }
  };

  return { load, cancel };
}

interface CaptchaMessageEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

export function buildGeetestOptions(config: GeetestCaptchaConfig, isOhos: boolean) {
  return {
    captchaId: config.captchaId,
    product: 'popup',
    language: 'zho',
    ...(isOhos
      ? {
          // GeeTest otherwise derives this from window.location.protocol.
          // The OHOS WebView uses Tauri's custom scheme, which produces
          // unusable scheme-handler URLs for GeeTest's follow-up requests.
          https: true,
          protocol: 'https://',
        }
      : {}),
  };
}

/**
 * GeeTest code is third-party JavaScript, so only its documented HTTPS host is
 * accepted. In particular, URL parsing must happen before assigning script.src
 * so javascript:/data: URLs and look-alike host names never reach the DOM.
 */
export function resolveGeetestSdkUrl(value: unknown): string {
  if (value == null || value === '') return DEFAULT_GEETEST_SDK_URL;
  if (typeof value !== 'string') throw new Error('极验 SDK 地址不受信任');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('极验 SDK 地址不受信任');
  }

  if (
    url.protocol !== 'https:'
    || !GEETEST_SDK_HOSTS.has(url.hostname.toLowerCase())
    || url.username !== ''
    || url.password !== ''
  ) {
    throw new Error('极验 SDK 地址不受信任');
  }

  return url.href;
}

export function createCaptchaSandboxChannel(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  throw new Error('无法创建安全验证码通道');
}

/**
 * A sandboxed srcdoc frame without allow-same-origin has an opaque origin,
 * serialized as "null" in MessageEvent.origin. Source-window and per-render
 * channel checks ensure messages from any other opaque frame are ignored.
 */
export function parseCaptchaSandboxMessage(
  event: CaptchaMessageEvent,
  expectedSource: unknown,
  expectedChannel: string,
): CaptchaSandboxMessage | null {
  if (!expectedSource || event.source !== expectedSource || event.origin !== CAPTCHA_SANDBOX_ORIGIN) {
    return null;
  }

  if (!event.data || typeof event.data !== 'object') return null;
  const data = event.data as Record<string, unknown>;
  if (data.kind !== CAPTCHA_SANDBOX_MESSAGE_KIND || data.channel !== expectedChannel) return null;
  if (data.type !== 'success' && data.type !== 'error') return null;

  return { type: data.type, payload: data.payload };
}

function serializeForInlineScript(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return 'null';

  return serialized
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildCaptchaBridge(channel: string): string {
  const messageKind = serializeForInlineScript(CAPTCHA_SANDBOX_MESSAGE_KIND);
  const serializedChannel = serializeForInlineScript(channel);

  return `<script>
(() => {
  'use strict';
  const kind = ${messageKind};
  const channel = ${serializedChannel};
  const send = (type, payload) => {
    try {
      window.parent.postMessage({ kind, channel, type, payload }, '*');
    } catch {
      window.parent.postMessage({
        kind,
        channel,
        type: 'error',
        payload: '验证码返回了无法读取的结果',
      }, '*');
    }
  };

  window.__moke_captcha_success = (data) => send('success', data);
  window.__moke_captcha_error = (error) => send(
    'error',
    typeof error === 'string' ? error : '验证码验证失败',
  );
})();
</script>`;
}

/**
 * The supplied body is deliberately not sanitized: captcha provider scripts
 * need to run, but they run only in the opaque-origin sandbox frame. The
 * trusted bridge is installed first and exposes just success/error messages.
 */
export function buildCaptchaSandboxDocument(bodyHtml: string, channel: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body { margin: 0; min-height: 100%; background: transparent; }
    body { display: flex; align-items: center; justify-content: center; font-family: sans-serif; }
    #geetest-container { width: 100%; display: flex; justify-content: center; }
  </style>
  ${buildCaptchaBridge(channel)}
</head>
<body>${bodyHtml}</body>
</html>`;
}

export function buildGeetestSandboxDocument(
  config: GeetestCaptchaConfig,
  channel: string,
): string {
  const sdkUrl = resolveGeetestSdkUrl(config.sdkUrl);
  // srcdoc has an about: URL on every platform, so GeeTest must always use
  // HTTPS rather than deriving a request protocol from window.location.
  const options = buildGeetestOptions(config, true);

  const body = `<div id="geetest-container"></div>
<script>
(() => {
  'use strict';
  const fail = (message) => window.__moke_captcha_error(message);
  const sdk = document.createElement('script');
  sdk.src = ${serializeForInlineScript(sdkUrl)};
  sdk.async = true;
  sdk.onerror = () => fail('极验 SDK 加载失败');
  sdk.onload = () => {
    try {
      if (typeof window.initGeetest4 !== 'function') {
        fail('极验 SDK 加载失败');
        return;
      }

      window.initGeetest4(${serializeForInlineScript(options)}, (gt) => {
        try {
          gt.appendTo('#geetest-container')
            .onSuccess(() => {
              const result = gt.getValidate() || {};
              window.__moke_captcha_success({
                provider: 'geetest',
                lot_number: result.lot_number,
                captcha_output: result.captcha_output,
                pass_token: result.pass_token,
                gen_time: result.gen_time,
              });
            })
            .onError(() => fail('极验验证失败'));
          gt.showCaptcha();
        } catch {
          fail('极验初始化失败');
        }
      });
    } catch {
      fail('极验初始化失败');
    }
  };
  document.head.appendChild(sdk);
})();
</script>`;

  return buildCaptchaSandboxDocument(body, channel);
}
