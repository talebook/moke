import { register } from 'node:module';

// Exercise the real application modules with the same aliases as tsconfig.
register('./app-alias-loader.mjs', import.meta.url);
