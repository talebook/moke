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
  const lower = value.toLowerCase();

  for (let index = 0; index < value.length;) {
    if (hiddenTag) {
      // Inside script/style, `<` may be plain code (`if (a < b)`); scanning for
      // the next `>` would misread the closing tag and hide the rest of the
      // description. Locate the real closing tag instead.
      const closeStart = lower.indexOf(`</${hiddenTag}`, index);
      if (closeStart === -1) break;
      const closeEnd = value.indexOf('>', closeStart + 2);
      index = closeEnd === -1 ? value.length : closeEnd + 1;
      hiddenTag = null;
      continue;
    }

    if (value[index] !== '<') {
      output += value[index];
      index += 1;
      continue;
    }

    // HTML comments (and other `<!...>` declarations) are not content.
    if (value.startsWith('<!--', index)) {
      const commentEnd = value.indexOf('-->', index + 4);
      if (commentEnd === -1) break;
      index = commentEnd + 3;
      continue;
    }
    if (value.startsWith('<!', index)) {
      const declEnd = value.indexOf('>', index + 2);
      index = declEnd === -1 ? value.length : declEnd + 1;
      continue;
    }

    const tagEnd = value.indexOf('>', index + 1);
    if (tagEnd === -1) {
      output += value.slice(index);
      break;
    }

    // A nested `<` inside the scanned span (e.g. `<scr<script>`) means the
    // outer tag text was cut short; parse only up to that point so the inner
    // tag gets its own pass instead of being folded into the outer name.
    const rawTagFull = value.slice(index + 1, tagEnd);
    const innerTagAt = rawTagFull.indexOf('<');
    const rawTag = (innerTagAt === -1 ? rawTagFull : rawTagFull.slice(0, innerTagAt)).trim();
    const scanEnd = innerTagAt === -1 ? tagEnd : index + 1 + innerTagAt;
    const closing = rawTag.startsWith('/');
    const tagName = rawTag
      .slice(closing ? 1 : 0)
      .match(/^[a-z][a-z0-9-]*/i)?.[0]
      ?.toLowerCase();

    if (!tagName) {
      output += '<';
      index += 1;
      continue;
    }

    if (!closing && (tagName === 'script' || tagName === 'style')) {
      hiddenTag = tagName;
    } else if (tagName === 'br' || (closing && BLOCK_TAGS.has(tagName))) {
      output += '\n';
    } else if (!closing && tagName === 'li') {
      output += '• ';
    }

    index = scanEnd === tagEnd ? tagEnd + 1 : scanEnd;
  }

  return output;
}

/** Convert Talebook's HTML-formatted comments into safe, readable plain text. */
export function bookSummaryText(value: string | null | undefined): string {
  if (!value) return '';
  const text = htmlToPlainText(value);

  // Decode once, then parse once more so encoded markup is treated exactly like
  // literal markup without deleting comparison operators from ordinary text.
  // Trade-off: decoded text that merely resembles a tag (a tutorial writing
  // "&lt;div&gt;") is stripped like real markup; this is the accepted cost of
  // treating encoded hostile markup the same as literal hostile markup.
  return htmlToPlainText(decodeHtmlEntities(text))
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
