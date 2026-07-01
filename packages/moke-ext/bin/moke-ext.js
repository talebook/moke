#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const HELP = `
moke-ext v${pkg.version} — Moke extension CLI

Usage: moke-ext <command> [options]

Commands:
  init <name>      Create a new extension project
  build            Build the extension for distribution
  dev              Start development server for current extension
  package          Package extension as NSIS installer
  validate         Validate manifest.json

Options:
  -h, --help       Show this help
  -v, --version    Show version

Examples:
  moke-ext init reading-stats     Create a new extension
  moke-ext validate               Check manifest.json
  moke-ext build                  Build dist/
  moke-ext package                Create reading-stats-setup.exe
`;

const [, , cmd, ...args] = process.argv;

if (cmd === '-h' || cmd === '--help' || !cmd) {
  console.log(HELP);
  process.exit(0);
}

if (cmd === '-v' || cmd === '--version') {
  console.log(pkg.version);
  process.exit(0);
}

try {
  const mod = await import(`../src/commands/${cmd}.js`);
  await mod.default(args);
} catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(`Unknown command: ${cmd}`);
    console.error('Run moke-ext --help for usage.');
  } else {
    console.error(`Error: ${e.message}`);
  }
  process.exit(1);
}
