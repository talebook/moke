import type { DiscoveryController } from './controller.ts';

interface NetworkConnection extends EventTarget {
  type?: string;
}

/** Event ownership is separate from native RR subscriptions, making both releasable. */
export function bindDiscoveryLifecycle(
  controller: DiscoveryController,
  page: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> & { hasFocus?: () => boolean },
  browser: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  network: Pick<Navigator, 'onLine'> & { connection?: NetworkConnection },
): () => void {
  const isVisible = () => !page.hidden && (page.hasFocus?.() ?? true);
  const onVisibility = () => controller.setVisible(isVisible());
  const onHide = () => controller.setVisible(false);
  const onShow = () => controller.setVisible(isVisible());
  const onOnline = () => controller.setOnline(true);
  const onOffline = () => controller.setOnline(false);
  const onNetworkChange = () => controller.networkChanged();

  page.addEventListener('visibilitychange', onVisibility);
  browser.addEventListener('pagehide', onHide);
  browser.addEventListener('pageshow', onShow);
  browser.addEventListener('blur', onHide);
  browser.addEventListener('focus', onShow);
  browser.addEventListener('online', onOnline);
  browser.addEventListener('offline', onOffline);
  network.connection?.addEventListener('change', onNetworkChange);

  // Apply initial conditions before start so hidden/offline entry opens no socket.
  controller.setVisible(isVisible());
  controller.setOnline(network.onLine);
  controller.start();

  return () => {
    page.removeEventListener('visibilitychange', onVisibility);
    browser.removeEventListener('pagehide', onHide);
    browser.removeEventListener('pageshow', onShow);
    browser.removeEventListener('blur', onHide);
    browser.removeEventListener('focus', onShow);
    browser.removeEventListener('online', onOnline);
    browser.removeEventListener('offline', onOffline);
    network.connection?.removeEventListener('change', onNetworkChange);
    controller.dispose();
  };
}
