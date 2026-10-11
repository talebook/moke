export interface ComicPageSize { width: number; height: number }

/** Shared bounds for manifest validation and the image adapter's own guard. */
export function isUsablePageSize(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const { width, height } = value as Partial<ComicPageSize>;
  return typeof width === 'number' && typeof height === 'number'
    && Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width > 0 && height > 0 && width <= 40000 && height <= 40000
    && width * height <= 40000000;
}
