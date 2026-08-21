/** Only mobile Readest -> Moke document navigation uses a cross-document animation. */
export function shouldAllowReaderExitTransition(
  runtimePlatform: string,
  fromUrl?: string,
): boolean {
  if (
    runtimePlatform !== 'android'
    && runtimePlatform !== 'ios'
    && runtimePlatform !== 'ohos'
  ) return false;
  if (!fromUrl) return false;

  try {
    const path = new URL(fromUrl).pathname.replace(/\/$/, '') || '/';
    return path === '/readest' || path.startsWith('/readest/');
  } catch {
    return false;
  }
}
