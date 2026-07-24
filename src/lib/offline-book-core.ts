export function makeOfflineBookKey(serverUrl: string, bookId: string): string {
  return `${serverUrl}::${bookId}`;
}

export function sanitizeOfflineFileName(fileName: string): string {
  const sanitized = fileName
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();

  return sanitized || 'book.epub';
}
