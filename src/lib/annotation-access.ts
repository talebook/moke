/**
 * Talebook's book-annotation endpoint contains personalized data and requires
 * authentication. A guest seeing a public book detail must never probe or load
 * this endpoint, because `user.need_login` is not a failure of the detail page.
 *
 * Keep every decision to access `/api/book/:id/annotations` behind this rule.
 * Add future session or permission constraints here so discovery and detail
 * rendering cannot drift apart.
 */
export function shouldRequestBookAnnotations(isLoggedIn: boolean): boolean {
  return isLoggedIn;
}
