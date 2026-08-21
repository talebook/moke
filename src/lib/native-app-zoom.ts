type ZoomShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey'
>;

const ZOOM_KEYS = new Set(['+', '=', '-', '_', '0']);
const ZOOM_CODES = new Set([
  'Equal',
  'Minus',
  'Digit0',
  'NumpadAdd',
  'NumpadSubtract',
  'Numpad0',
]);

/** Return whether a key event is a browser/WebView zoom shortcut. */
export function shouldPreventNativeAppZoomShortcut(
  event: ZoomShortcutEvent,
): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  return ZOOM_KEYS.has(event.key) || ZOOM_CODES.has(event.code);
}
