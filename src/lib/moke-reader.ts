import type { ReadingProgressPayload } from './reading-progress';

export function buildEmbeddedReaderUrl({
  filePath,
  eink,
  mokeBookId,
  restoreProgress,
}: {
  filePath: string;
  eink: boolean;
  mokeBookId: string;
  restoreProgress: ReadingProgressPayload | null;
}): string {
  const params = new URLSearchParams({
    file: filePath,
    moke: '1',
    mokeEink: eink ? '1' : '0',
    mokeBookId,
  });

  if (restoreProgress) {
    params.set('mokeRestoreProgress', JSON.stringify(restoreProgress));
  }

  return `/readest/reader?${params.toString()}`;
}
