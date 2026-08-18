import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { PrivacyBackButton } from './privacy-back-button';

export const dynamic = 'force-static';

const POLICY_FALLBACK = `# Moke 隐私政策

完整隐私政策暂时无法载入。Moke 不会在你同意前连接 Talebook 服务器或同步个人信息。

如需帮助，请联系 shangzhen0831@163.com，或访问 https://github.com/talebook/moke。`;

function readPrivacyPolicy(): string {
  try {
    return readFileSync(join(process.cwd(), 'PRIVACY.md'), 'utf8')
      .replace(/^---[\s\S]*?---\s*/, '')
      .trim();
  } catch (error) {
    console.warn('Unable to load PRIVACY.md during static generation:', error);
    return POLICY_FALLBACK;
  }
}

function renderInline(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|<https?:\/\/[^>]+>|<[^<>\s]+@[^<>\s]+>)/g);
  return tokens.filter(Boolean).map((token, index) => {
    if (token.startsWith('**') && token.endsWith('**')) {
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith('<http') && token.endsWith('>')) {
      const href = token.slice(1, -1);
      return <a key={index} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">{href}</a>;
    }
    if (token.startsWith('<') && token.endsWith('>') && token.includes('@')) {
      const email = token.slice(1, -1);
      return <a key={index} href={`mailto:${email}`} className="text-primary underline">{email}</a>;
    }
    return token;
  });
}

function renderPolicy(markdown: string): ReactNode[] {
  const lines = markdown.split('\n');
  const blocks: ReactNode[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2]);
      if (level === 1) blocks.push(<h1 key={index} className="text-2xl font-semibold text-foreground">{content}</h1>);
      else if (level === 2) blocks.push(<h2 key={index} className="pt-4 text-xl font-semibold text-foreground">{content}</h2>);
      else blocks.push(<h3 key={index} className="pt-2 text-base font-semibold text-foreground">{content}</h3>);
      index += 1;
      continue;
    }

    if (line.startsWith('- ')) {
      const items: ReactNode[] = [];
      while (index < lines.length && lines[index].trim().startsWith('- ')) {
        items.push(<li key={index}>{renderInline(lines[index].trim().slice(2))}</li>);
        index += 1;
      }
      blocks.push(<ul key={`list-${index}`} className="list-disc space-y-1 pl-5">{items}</ul>);
      continue;
    }

    blocks.push(<p key={index}>{renderInline(line)}</p>);
    index += 1;
  }

  return blocks;
}

export default function PrivacyPage() {
  const policy = readPrivacyPolicy();

  return (
    <main className="min-h-dvh app-warm-bg px-4 py-6 sm:px-6 sm:py-10">
      <article className="mx-auto max-w-3xl rounded-[28px] border border-amber-950/10 bg-background p-6 shadow-xl sm:p-10">
        <PrivacyBackButton />
        <div className="mt-6 space-y-4 text-sm leading-7 text-foreground/90">
          {renderPolicy(policy)}
        </div>
      </article>
    </main>
  );
}
