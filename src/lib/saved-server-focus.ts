/** Navigation carries only a local row selector, never a server URL or grant. */
// Match persisted identifiers, including preserved legacy IDs. This value is
// URL-encoded and resolved with getElementById, never a CSS selector or URL.
const validId = (id: string) => id.length > 0 && !/[\p{Cc}\p{Cs}]/u.test(id);

export function savedServerFocusHref(id: string): string {
  if (!validId(id)) throw new Error('invalid-saved-id');
  return `/welcome?focusSaved=${encodeURIComponent(id)}`;
}

export function savedServerFocusId(search: string, entries: readonly { id: string }[]): string | null {
  const id = new URLSearchParams(search).get('focusSaved');
  return id && validId(id) && entries.some((entry) => entry.id === id) ? id : null;
}
