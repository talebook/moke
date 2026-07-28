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

export async function hasEpubCentralDirectory(blob: Blob): Promise<boolean> {
  const eocdLength = 22;
  const maxCommentLength = 0xffff;
  const tail = new Uint8Array(
    await blob.slice(Math.max(0, blob.size - eocdLength - maxCommentLength)).arrayBuffer(),
  );

  for (let index = tail.length - eocdLength; index >= 0; index--) {
    if (
      tail[index] === 0x50 &&
      tail[index + 1] === 0x4b &&
      tail[index + 2] === 0x05 &&
      tail[index + 3] === 0x06
    ) {
      const commentLength = tail[index + 20]! | (tail[index + 21]! << 8);
      return index + eocdLength + commentLength === tail.length;
    }
  }

  return false;
}
