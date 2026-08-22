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

type ShelfStateValue = boolean | number | null;

/** Read the optional shelf state embedded in Talebook's book-detail payload. */
export function bookDetailShelfState(book: {
  state?: { wants?: ShelfStateValue };
} | null | undefined): boolean | undefined {
  const wants = book?.state?.wants;
  return wants == null ? undefined : Boolean(wants);
}

/** Guests must never call Talebook's authenticated readstate endpoint. */
export function shouldLoadReadingStateFallback(
  detailShelfState: boolean | undefined,
  isLoggedIn: boolean,
): boolean {
  return isLoggedIn && detailShelfState === undefined;
}

/**
 * Read a shelf state from the authenticated readstate endpoint.
 *
 * Guests receive `user.need_login` from this optional personalization API.
 * That does not make the public book detail unavailable, so callers should
 * keep the detail page open when this function returns undefined.
 */
export function readStateShelfState(response: {
  err?: string;
  wants?: ShelfStateValue;
} | null | undefined): boolean | undefined {
  if (response?.err !== 'ok' || response.wants == null) return undefined;
  return Boolean(response.wants);
}

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

    // A comparison operator such as `3 < 5` is text, not the start of a tag.
    // Requiring an HTML-style name here also prevents a later `>` from making
    // us consume an arbitrary span of prose.
    const tagStart = value.slice(index + 1).match(/^\s*(\/?)\s*([a-z][a-z0-9-]*)/i);
    if (!tagStart) {
      output += '<';
      index += 1;
      continue;
    }

    // Find the end of the tag without treating `<` or `>` inside a quoted
    // attribute as markup. A `<` outside quotes is retained as a recovery
    // point for malformed nested input such as `<scr<script>`.
    let quote: '"' | "'" | null = null;
    let tagEnd = -1;
    let nestedTagAt = -1;
    for (let cursor = index + 1; cursor < value.length; cursor += 1) {
      const character = value[cursor];
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '<') {
        nestedTagAt = cursor;
        break;
      } else if (character === '>') {
        tagEnd = cursor;
        break;
      }
    }

    if (tagEnd === -1 && nestedTagAt === -1) {
      output += value.slice(index);
      break;
    }

    const closing = tagStart[1] === '/';
    const tagName = tagStart[2].toLowerCase();

    if (!closing && (tagName === 'script' || tagName === 'style')) {
      hiddenTag = tagName;
    } else if (tagName === 'br' || (closing && BLOCK_TAGS.has(tagName))) {
      output += '\n';
    } else if (!closing && tagName === 'li') {
      output += '• ';
    }

    index = nestedTagAt === -1 ? tagEnd + 1 : nestedTagAt;
  }

  return output;
}

/** Convert Talebook's HTML-formatted comments into safe, readable plain text. */
export function bookSummaryText(value: string | null | undefined): string {
  if (!value) return '';
  // Strip literal markup before decoding entities. Encoded tag examples such
  // as `&lt;div&gt;` are authored text, so they must not be parsed a second time.
  // The result is rendered as a React text node, never as executable HTML.
  return decodeHtmlEntities(htmlToPlainText(value))
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
