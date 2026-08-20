const FALLBACK_ROUTES: Record<string, string> = {
  '/about': '/settings',
  '/access': '/welcome',
  '/detail': '/library',
  '/extensions/detail': '/extensions',
  '/extensions/view': '/extensions',
  '/library': '/shelf',
  '/login': '/welcome',
  '/network-book': '/library',
  '/privacy': '/',
  '/register': '/welcome',
  '/reset-password': '/login',
  '/search': '/shelf',
  '/settings': '/shelf',
  '/settings/developer': '/settings',
  '/user': '/shelf',
  '/user/history': '/user',
};

const APP_ROOT_ROUTES = new Set(['/shelf', '/library', '/user']);

export const APP_BACK_EVENT = 'moke:native-back';

/** Routes page-level back controls through the same animated path as Android BACK. */
export function requestAnimatedBack(target?: string): void {
  window.dispatchEvent(new CustomEvent(APP_BACK_EVENT, {
    detail: { target },
  }));
}

export function nativeBackFallback(pathname: string): string {
  return FALLBACK_ROUTES[pathname] ?? '/shelf';
}

/** Home tabs are peers, so switching tabs starts a fresh app-navigation stack. */
export function trackNativeRoute(pathname: string, routeStack: readonly string[]): string[] {
  if (APP_ROOT_ROUTES.has(pathname)) return [pathname];
  if (routeStack.at(-1) === pathname) return [...routeStack];
  return [...routeStack, pathname];
}

export function resolveNativeBackTarget(
  pathname: string,
  routeStack: readonly string[],
): { target: string; nextStack: string[] } {
  const nextStack = [...routeStack];
  if (nextStack.at(-1) !== pathname) nextStack.push(pathname);
  if (nextStack.at(-1) === pathname) nextStack.pop();

  const previous = nextStack.at(-1);
  return {
    target: previous && previous !== pathname ? previous : nativeBackFallback(pathname),
    nextStack,
  };
}
