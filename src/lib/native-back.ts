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
  requestedTarget?: string,
): { target: string; nextStack: string[] } {
  const currentStack = trackNativeRoute(pathname, routeStack);
  if (requestedTarget === pathname) {
    return { target: pathname, nextStack: currentStack };
  }

  const parentStack = currentStack.at(-1) === pathname
    ? currentStack.slice(0, -1)
    : [...currentStack];
  const previous = parentStack.at(-1);
  const target = requestedTarget
    ?? (previous && previous !== pathname ? previous : nativeBackFallback(pathname));
  const existingTargetIndex = parentStack.lastIndexOf(target);
  const nextStack = existingTargetIndex >= 0
    ? parentStack.slice(0, existingTargetIndex + 1)
    : trackNativeRoute(target, parentStack);

  return { target, nextStack };
}
