import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrivacyBackButton } from './privacy-back-button';

function readPrivacyPolicy(): string {
  return readFileSync(join(process.cwd(), 'PRIVACY.md'), 'utf8')
    .replace(/^---[\s\S]*?---\s*/, '')
    .trim();
}

export default function PrivacyPage() {
  const policy = readPrivacyPolicy();

  return (
    <main className="min-h-dvh app-warm-bg px-4 py-6 sm:px-6 sm:py-10">
      <article className="mx-auto max-w-3xl rounded-[28px] border border-amber-950/10 bg-background p-6 shadow-xl sm:p-10">
        <PrivacyBackButton />
        <div className="mt-6 whitespace-pre-wrap text-sm leading-7 text-foreground/90">
          {policy}
        </div>
      </article>
    </main>
  );
}
