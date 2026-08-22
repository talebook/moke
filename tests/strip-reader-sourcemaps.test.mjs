import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  stripReaderSourceMaps,
  stripSourceMapReferences,
} from '../scripts/strip-reader-sourcemaps.mjs';

test('stripSourceMapReferences handles JavaScript and CSS comments', () => {
  assert.equal(
    stripSourceMapReferences('const value = 1;\n//# sourceMappingURL=app.js.map'),
    'const value = 1;',
  );
  assert.equal(
    stripSourceMapReferences('body { color: black; }\r\n/*# sourceMappingURL=app.css.map */\r\n'),
    'body { color: black; }\r\n',
  );
});

test('stripReaderSourceMaps removes maps recursively and preserves runtime assets', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'moke-reader-sourcemaps-'));
  const chunks = path.join(root, '_next', 'static', 'chunks');
  mkdirSync(chunks, { recursive: true });

  writeFileSync(path.join(chunks, 'app.js'), 'console.log("app");\n//# sourceMappingURL=app.js.map');
  writeFileSync(path.join(chunks, 'app.js.map'), '{"version":3}');
  writeFileSync(path.join(chunks, 'styles.css'), 'body{}\n/*# sourceMappingURL=styles.css.map */');
  writeFileSync(path.join(chunks, 'styles.css.map'), '{"version":3,"sources":[]}');
  writeFileSync(path.join(root, 'navigation.map'), 'runtime data');
  writeFileSync(path.join(root, 'runtime.json'), '{"required":true}');

  const result = stripReaderSourceMaps(root);

  assert.deepEqual(result, {
    removedFiles: 2,
    removedBytes: 39,
    rewrittenFiles: 2,
  });
  assert.equal(existsSync(path.join(chunks, 'app.js.map')), false);
  assert.equal(existsSync(path.join(chunks, 'styles.css.map')), false);
  assert.equal(readFileSync(path.join(chunks, 'app.js'), 'utf8'), 'console.log("app");');
  assert.equal(readFileSync(path.join(chunks, 'styles.css'), 'utf8'), 'body{}');
  assert.equal(readFileSync(path.join(root, 'navigation.map'), 'utf8'), 'runtime data');
  assert.equal(readFileSync(path.join(root, 'runtime.json'), 'utf8'), '{"required":true}');
});

test('stripReaderSourceMaps fails when the expected reader output is absent', () => {
  assert.throws(
    () => stripReaderSourceMaps(path.join(os.tmpdir(), 'moke-reader-output-does-not-exist')),
    /Reader output does not exist/,
  );
});
