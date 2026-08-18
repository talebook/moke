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

export function nativeBackFallback(pathname: string): string {
  return FALLBACK_ROUTES[pathname] ?? '/shelf';
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
