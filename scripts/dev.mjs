import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Keep Moke on Tauri's configured dev URL (3000). Without an explicit port,
// Readest starts first on 3000 and forces Moke onto 3001, reversing the
// embedded-reader proxy topology.
const reader = spawn('pnpm', ['--filter', '@readest/readest-app', 'dev', '--port', '3001'], {
  cwd: path.join(root, 'readest'),
  shell: true,
  stdio: 'inherit',
  env: {
    ...process.env,
    NEXT_PUBLIC_EMBEDDED_BASE_PATH: '/readest',
  },
});

const moke = spawn('pnpm', ['dev'], {
  cwd: root,
  shell: true,
  stdio: 'inherit',
});

function cleanup() {
  reader.kill();
  moke.kill();
  process.exit();
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);
