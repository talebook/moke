const HTML_ENTITY_MAP: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith('#')) {
      const hex = code[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    }
    return HTML_ENTITY_MAP[code.toLowerCase()] ?? entity;
  });
}

const BLOCK_TAGS = new Set(['blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'p']);

function htmlToPlainText(value: string): string {
  let output = '';
  let hiddenTag: 'script' | 'style' | null = null;

  for (let index = 0; index < value.length;) {
    if (value[index] !== '<') {
      if (!hiddenTag) output += value[index];
      index += 1;
      continue;
    }

    const tagEnd = value.indexOf('>', index + 1);
    if (tagEnd === -1) {
      if (!hiddenTag) output += value.slice(index);
      break;
    }

    const rawTag = value.slice(index + 1, tagEnd).trim();
    const closing = rawTag.startsWith('/');
    const tagName = rawTag
      .slice(closing ? 1 : 0)
      .match(/^[a-z][a-z0-9-]*/i)?.[0]
      ?.toLowerCase();

    if (!tagName) {
      if (!hiddenTag) output += '<';
      index += 1;
      continue;
    }

    if (hiddenTag) {
      if (closing && tagName === hiddenTag) hiddenTag = null;
    } else if (!closing && (tagName === 'script' || tagName === 'style')) {
      hiddenTag = tagName;
    } else if (tagName === 'br' || (closing && tagName && BLOCK_TAGS.has(tagName))) {
      output += '\n';
    } else if (!closing && tagName === 'li') {
      output += '• ';
    }

    index = tagEnd + 1;
  }

  return output;
}

/** Convert Talebook's HTML-formatted comments into safe, readable plain text. */
export function bookSummaryText(value: string | null | undefined): string {
  if (!value) return '';
  const text = htmlToPlainText(value);

  // Decode once, then parse once more so encoded markup is treated exactly like
  // literal markup without deleting comparison operators from ordinary text.
  return htmlToPlainText(decodeHtmlEntities(text))
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
