import { installLibraryLayoutMock, LAYOUT_SERVER_URL } from './library-layout.mjs';

// Snapshot the anonymous payload when the request starts. The bridge ignores
// cancellation so tests can deliver it after a successful sign-in.
export async function installLoginRaceMock(page, { holdConfirmation = false } = {}) {
  await installLibraryLayoutMock(page, { continueReading: false });
  await page.addInitScript(({ serverUrl, holdConfirmation }) => {
    const stored = JSON.parse(localStorage.getItem('moke-server-storage'));
    stored.state.user = null;
    stored.state.capabilities.checkedAt = null;
    localStorage.setItem('moke-server-storage', JSON.stringify(stored));
    localStorage.removeItem('moke-continue-reading');
    const original = window.__TAURI_INTERNALS__.invoke;
    const requests = new Map();
    const bodies = new Map();
    const anonymousWaiters = [];
    const confirmedWaiters = [];
    let nextId = 20000;
    let signedIn = false;
    let anonymousReleased = false;
    let confirmedReleased = !holdConfirmation;
    window.loginRace = { infoStarted: [], signIns: 0, anonymousCompleted: 0 };
    window.releaseAnonymousUser = () => {
      anonymousReleased = true;
      anonymousWaiters.splice(0).forEach((resolve) => resolve());
    };
    window.releaseConfirmedUser = () => {
      confirmedReleased = true;
      confirmedWaiters.splice(0).forEach((resolve) => resolve());
    };
    window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
      if (command === 'plugin:http|fetch') {
        const id = await original(command, args);
        requests.set(id, args.clientConfig.url);
        return id;
      }
      if (command === 'plugin:http|fetch_send') {
        const url = requests.get(args.rid);
        const parsed = new URL(url);
        let payload;
        if (parsed.pathname === '/api/user/sign_in') {
          signedIn = true;
          window.loginRace.signIns++;
          payload = { err: 'ok' };
        } else if (parsed.pathname === '/api/user/info') {
          const authenticated = signedIn;
          payload = { err: 'ok', sys: { title: authenticated ? '登录回归书库' : '旧匿名书库' }, user: authenticated
            ? { is_login: true, id: 7, username: 'race-reader', nickname: '回归读者', extra: {} }
            : { is_login: false } };
          if (!parsed.search) {
            window.loginRace.infoStarted.push(authenticated ? 'confirmed' : 'anonymous');
            if (!authenticated && !anonymousReleased) await new Promise((resolve) => anonymousWaiters.push(resolve));
            if (authenticated && !confirmedReleased) await new Promise((resolve) => confirmedWaiters.push(resolve));
            if (!authenticated) window.loginRace.anonymousCompleted++;
          }
        }
        if (payload) {
          const rid = nextId++;
          bodies.set(rid, JSON.stringify(payload));
          return { status: 200, statusText: 'OK', url: `${serverUrl}${parsed.pathname}`, rid, headers: [['content-type', 'application/json']] };
        }
      }
      if (command === 'plugin:http|fetch_read_body' && bodies.has(args.rid)) {
        const body = bodies.get(args.rid);
        bodies.delete(args.rid);
        return [...new TextEncoder().encode(body), 0];
      }
      return original(command, args);
    };
  }, { serverUrl: LAYOUT_SERVER_URL, holdConfirmation });
}

export async function openLoginWithAnonymousRequest(page, appUrl) {
  await page.goto(`${appUrl}/shelf`);
  await page.waitForFunction(() => window.loginRace.infoStarted.includes('anonymous'));
  // Mobile reaches login through the personal panel; desktop has a sidebar
  // link. Use visible controls so the hidden mobile tab cannot stall desktop.
  if (page.viewportSize().width < 1024) {
    await page.getByRole('link', { name: '我的', exact: true }).click();
  }
  await page.getByRole('link', { name: '登录', exact: true }).last().click();
  await page.getByPlaceholder('请输入用户名').fill('race-reader');
  await page.getByPlaceholder('请输入密码').fill('fictional-test-password');
  await page.getByPlaceholder('请输入密码').press('Enter');
}
