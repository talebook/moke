import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { resolveTheme } from '../src/lib/store/settings.ts';

// The anti-flash head script in layout.tsx duplicates resolveTheme() (plus the
// e-ink / auto-e-ink gating) because it must run before hydration. This test
// executes that inline script against a mocked DOM for every
// (theme, prefersDark, eink, autoEink) combination and asserts it applies the
// .dark class and color-scheme exactly when resolveTheme + gating would. If
// the two drift, this fails — keep them in sync together.
//
// Coverage boundary: this only exercises the script's theme-resolution logic
// (which .dark class and which color-scheme it ends up with). It does NOT
// protect the colorScheme else-branch wording itself, arbitrary DOM side
// effects, or anything the script does beyond the resolution — if you extend
// the inline script, extend this test. The sentinel below also guards the
// extraction: the script body must still contain MOKE-THEME-INIT, so a stray
// earlier `__html:` template in layout.tsx or a template-literal split can't
// silently desync the two.

const __dirname = dirname(fileURLToPath(import.meta.url));
const layoutSrc = readFileSync(join(__dirname, '../src/app/layout.tsx'), 'utf8');

function extractInlineScript(src) {
  // The script body is inside __html: `...` in layout.tsx; the trailing
  // /*MOKE-THEME-INIT*/ marker anchors the regex to the theme script.
  const m = src.match(/__html:\s*`((?:[^`\\]|\\.)*\/\*MOKE-THEME-INIT\*\/)`/);
  assert.ok(m, 'inline head script with MOKE-THEME-INIT marker found in layout.tsx');
  return m[1].replace(/\\`/g, '`');
}

const inlineScript = extractInlineScript(layoutSrc);

function runScript({ theme, prefersDark, eink, autoEink }) {
  const classList = new Set();
  const document = {
    documentElement: {
      classList: {
        add: (c) => { classList.add(c); },
      },
      style: {},
    },
  };
  const matchMedia = (query) => {
    if (query === '(prefers-color-scheme: dark)') {
      return { matches: prefersDark };
    }
    if (query === '(update: slow), (max-color: 1)') {
      return { matches: autoEink };
    }
    throw new Error(`unexpected matchMedia query: ${query}`);
  };
  const localStorage = {
    getItem: () => JSON.stringify({
      state: { theme, eink },
      version: 0,
    }),
  };
  const fn = new Function('document', 'window', 'localStorage', inlineScript);
  fn(document, { matchMedia, getComputedStyle: () => ({}) }, localStorage);
  return {
    dark: classList.has('dark'),
    colorScheme: document.documentElement.style.colorScheme,
  };
}

const themes = ['light', 'dark', 'system'];
const prefersDarkValues = [false, true];
const einkValues = [false, true];
const autoEinkValues = [false, true];

for (const theme of themes) {
  for (const prefersDark of prefersDarkValues) {
    for (const eink of einkValues) {
      for (const autoEink of autoEinkValues) {
        test(`inline script matches resolveTheme (${theme}, prefersDark=${prefersDark}, eink=${eink}, autoEink=${autoEink})`, () => {
          const expected = !eink && !autoEink && resolveTheme(theme, prefersDark) === 'dark';
          const { dark, colorScheme } = runScript({ theme, prefersDark, eink, autoEink });
          assert.equal(dark, expected);
          assert.equal(colorScheme, expected ? 'dark' : 'light');
        });
      }
    }
  }
}
