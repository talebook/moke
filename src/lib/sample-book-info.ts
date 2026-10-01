/** A single app-owned book, independent of the currently connected server. */
export const SAMPLE_BOOK = {
  serverUrl: 'moke-sample://bundled',
  bookId: 'moke-bundled-sample-v1',
  title: '墨客示例书',
  author: '墨客',
  format: 'epub',
  fileName: 'moke-sample.epub',
  mimeType: 'application/epub+zip',
  assetPath: '/samples/moke-sample.epub',
} as const;

export function isSampleBook(book: { serverUrl: string; bookId: string }): boolean {
  return book.serverUrl === SAMPLE_BOOK.serverUrl && book.bookId === SAMPLE_BOOK.bookId;
}
