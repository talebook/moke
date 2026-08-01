export interface GeetestCaptchaConfig {
  captchaId?: string;
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
