import { installLibraryLayoutMock } from './library-layout.mjs';

/** Hold real frontend bridge promises so hydration cannot finish the gate early. */
export async function installFirstPaintMock(page, { runtime = 'android', appearance = 'light' } = {}) {
  await installLibraryLayoutMock(page, {
    offlineMode: true, nativeRuntime: runtime,
    theme: appearance === 'dark' ? 'dark' : 'light', eink: appearance === 'eink',
  });
  await page.addInitScript(({ runtime }) => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const insetWaiters = [], authWaiters = [];
    // Native mobile route changes load another document. Release decisions
    // belong to the test session, so the next document must not re-lock them.
    let insetReleased = sessionStorage.getItem('first-paint-inset-released') === 'true';
    let authReleased = sessionStorage.getItem('first-paint-auth-released') === 'true';
    window.firstPaintGate = {
      insetPending: false, authPending: false,
      releaseInset: () => { sessionStorage.setItem('first-paint-inset-released', 'true'); insetReleased = true; insetWaiters.splice(0).forEach((resolve) => resolve()); },
      releaseAuth: () => { sessionStorage.setItem('first-paint-auth-released', 'true'); authReleased = true; authWaiters.splice(0).forEach((resolve) => resolve()); },
    };
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === 'moke_preview_entitlement_status' && !authReleased) {
        window.firstPaintGate.authPending = true;
        await new Promise((resolve) => authWaiters.push(resolve));
      }
      if (command === 'plugin:native-bridge|get_status_bar_height' || command === 'plugin:native-bridge|get_safe_area_insets') {
        if (!insetReleased) {
          window.firstPaintGate.insetPending = true;
          await new Promise((resolve) => insetWaiters.push(resolve));
        }
        return runtime === 'ios' ? { top: 44 } : { height: 48 * window.devicePixelRatio };
      }
      return invoke(command, args);
    };
    window.firstPaintFrames = [];
    const sample = () => {
      const screen = document.querySelector('[data-testid="app-startup-screen"]');
      if (screen) {
        const spinner = screen.firstElementChild;
        const box = spinner.getBoundingClientRect();
        const frame = {
          x: box.x + box.width / 2, y: box.y + box.height / 2,
          width: spinner.offsetWidth, height: spinner.offsetHeight,
          padding: getComputedStyle(screen).paddingTop,
          background: getComputedStyle(document.documentElement).backgroundColor,
          message: screen.dataset.progressMessage,
        };
        if (!window.firstPaintFrames.some((old) => JSON.stringify(old) === JSON.stringify(frame))) window.firstPaintFrames.push(frame);
      }
      requestAnimationFrame(sample);
    };
    document.addEventListener('DOMContentLoaded', sample, { once: true });
  }, { runtime });
}
