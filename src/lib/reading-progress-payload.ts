const TRANSIENT_NAVIGATION_KEYS = new Set([
  'moke_navigation_id',
  'moke_navigation_kind',
  'moke_navigation_phase',
]);

type TransientNavigationKey =
  | 'moke_navigation_id'
  | 'moke_navigation_kind'
  | 'moke_navigation_phase';

/** Keep annotation-navigation correlation local to the active reader session. */
export function readingProgressForPersistence<T extends object>(
  progress: T,
): Omit<T, TransientNavigationKey> {
  return Object.fromEntries(
    Object.entries(progress).filter(([key]) => !TRANSIENT_NAVIGATION_KEYS.has(key)),
  ) as Omit<T, TransientNavigationKey>;
}
