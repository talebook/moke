import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_MAP_REFERENCE =
  /(?:\r?\n)?[ \t]*(?:\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*|\/\*[#@][ \t]*sourceMappingURL=.*?\*\/)[ \t]*(?=\r?\n|$)/gs;

export function stripSourceMapReferences(source) {
  return source.replace(SOURCE_MAP_REFERENCE, '');
}

export function stripReaderSourceMaps(root) {
  if (!existsSync(root)) {
    throw new Error(`Reader output does not exist: ${root}`);
  }

  const result = {
    removedFiles: 0,
    removedBytes: 0,
    rewrittenFiles: 0,
  };

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }

      if (/\.(?:[cm]?js|css)\.map$/.test(entry.name)) {
        result.removedBytes += statSync(fullPath).size;
        rmSync(fullPath);
        result.removedFiles += 1;
        continue;
      }

      if (!/\.(?:[cm]?js|css)$/.test(entry.name)) continue;

      const source = readFileSync(fullPath, 'utf8');
      const stripped = stripSourceMapReferences(source);
      if (stripped === source) continue;

      writeFileSync(fullPath, stripped);
      result.rewrittenFiles += 1;
    }
  };

  visit(root);
  return result;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function main() {
  const target = process.argv[2];
  if (!target) {
    throw new Error('Usage: node scripts/strip-reader-sourcemaps.mjs <reader-output>');
  }

  const root = path.resolve(target);
  const result = stripReaderSourceMaps(root);
  console.log(
    `Reader sourcemaps: removed ${result.removedFiles} file(s) (${formatBytes(result.removedBytes)}), ` +
      `rewrote ${result.rewrittenFiles} asset(s).`,
  );
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
