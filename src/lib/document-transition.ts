/**
 * Only mobile Readest -> Moke document navigation uses a cross-document animation.
 *
 * IMPORTANT: layout.tsx serializes this function with Function#toString for an
 * inline pre-hydration script. Keep it self-contained and do not reference
 * module-level constants or helpers.
 */
export function shouldAllowReaderExitTransition(
  runtimePlatform: string,
  fromUrl?: string,
  currentUrl?: string,
): boolean {
  if (
    runtimePlatform !== 'android'
    && runtimePlatform !== 'ios'
    && runtimePlatform !== 'ohos'
  ) return false;
  if (!fromUrl || !currentUrl) return false;

  try {
    const from = new URL(fromUrl);
    const current = new URL(currentUrl);
    if (from.protocol !== current.protocol || from.host !== current.host) return false;

    const path = from.pathname.replace(/\/$/, '') || '/';
    return path === '/readest' || path.startsWith('/readest/');
  } catch {
    return false;
  }
}
