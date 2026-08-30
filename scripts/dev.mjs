import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const readerRoot = path.join(root, 'readest', 'apps', 'readest-app');
const readerNext = path.join(readerRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const mokeNext = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');

function readEnvFile(filePath) {
  const env = {};
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim().replace(/^export\s+/, '');
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function devEnv(directory, envFile = '.env.tauri', overrides = {}) {
  return {
    ...process.env,
    ...readEnvFile(path.join(directory, envFile)),
    ...overrides,
  };
}

// Run Next directly instead of through `pnpm --filter ... dev`. On Windows,
// terminating that pnpm wrapper during a normal Tauri shutdown reports the
// child's -1 status as ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL / 4294967295.
const reader = spawn(process.execPath, [readerNext, 'dev', '--turbo', '--port', '3001'], {
  cwd: readerRoot,
  stdio: 'inherit',
  env: devEnv(readerRoot, '.env.moke-reader', {
    NEXT_PUBLIC_EMBEDDED_BASE_PATH: '/readest',
  }),
});

let shuttingDown = false;
let moke;

function cleanup(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reader.exitCode === null) reader.kill();
  if (moke?.exitCode === null) moke.kill();
  process.exitCode = exitCode;
}

reader.on('exit', (code, signal) => {
  if (!shuttingDown) cleanup(signal ? 1 : (code ?? 1));
});

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));

async function waitForReader(url) {
  console.log('正在等待 Readest 首次编译完成…');
  while (!shuttingDown) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      return true;
    } catch {
      await delay(250);
    }
  }
  return false;
}

if (await waitForReader('http://localhost:3001/readest/reader')) {
  moke = spawn(process.execPath, [mokeNext, 'dev', '--turbo'], {
    cwd: root,
    stdio: 'inherit',
    env: devEnv(root, '.env.tauri'),
  });
  moke.on('exit', (code, signal) => {
    if (!shuttingDown) cleanup(signal ? 1 : (code ?? 1));
  });
}
