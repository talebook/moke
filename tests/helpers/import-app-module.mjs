import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../src/', import.meta.url));
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      const path = resolve(root, specifier.slice(2));
      for (const extension of ['.ts', '.tsx', '/index.ts']) {
        if (existsSync(path + extension)) return next(pathToFileURL(path + extension).href, context);
      }
    }
    return next(specifier, context);
  },
});
