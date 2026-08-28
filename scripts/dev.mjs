import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const readerRoot = path.join(root, 'readest', 'apps', 'readest-app');
const readerNext = path.join(readerRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const mokeNext = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');

// Run Next directly instead of through `pnpm --filter ... dev`. On Windows,
// terminating that pnpm wrapper during a normal Tauri shutdown reports the
// child's -1 status as ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL / 4294967295.
const reader = spawn(process.execPath, ['--env-file=.env.tauri', readerNext, 'dev', '--turbo', '--port', '3001'], {
  cwd: readerRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    NEXT_PUBLIC_EMBEDDED_BASE_PATH: '/readest',
  },
});

const moke = spawn(process.execPath, ['--env-file=.env.tauri', mokeNext, 'dev', '--turbo'], {
  cwd: root,
  stdio: 'inherit',
});

let shuttingDown = false;

function cleanup(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reader.exitCode === null) reader.kill();
  if (moke.exitCode === null) moke.kill();
  process.exitCode = exitCode;
}

reader.on('exit', (code, signal) => {
  if (!shuttingDown) cleanup(signal ? 1 : (code ?? 1));
});
moke.on('exit', (code, signal) => {
  if (!shuttingDown) cleanup(signal ? 1 : (code ?? 1));
});

process.on('SIGINT', () => cleanup(0));
process.on('SIGTERM', () => cleanup(0));
