import { test } from 'node:test';
import { checkKomgaReader } from '../scripts/build-komga-reader.mjs';

test('komga browser resources, local source patch and licenses match pinned provenance', () => {
  checkKomgaReader();
});
