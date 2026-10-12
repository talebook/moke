/** AbortSignal.throwIfAborted is unavailable in the supported Chrome 96 runtime. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
  }
}
