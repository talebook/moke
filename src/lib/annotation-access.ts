/**
 * Talebook's book-annotation endpoint contains personalized data and requires
 * authentication. A guest seeing a public book detail must never probe or load
 * this endpoint, because `user.need_login` is not a failure of the detail page.
 */
export function shouldRequestBookAnnotations(isLoggedIn: boolean): boolean {
  return isLoggedIn;
}
