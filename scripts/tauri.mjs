import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));

export function tauriCommand(args) {
  // Published npm binaries do not contain the official experimental OHOS CLI.
  if (args.find((arg) => !arg.startsWith('-')) === 'ohos') {
    return {
      command: 'cargo',
      args: [
        'run', '--locked', '--manifest-path',
        path.join(root, 'vendor/tauri/Cargo.toml'),
        '-p', 'tauri-cli', '--bin', 'cargo-tauri',
        // The pinned CLI's platform-certs dependency fails to compile on Linux.
        // Use upstream's Rustls + bundled roots option; TLS verification stays on.
        '--no-default-features', '--features', 'rustls', '--', ...args,
      ],
    };
  }
  return {
    command: process.execPath,
    args: [require.resolve('@tauri-apps/cli/tauri.js'), ...args],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { command, args } = tauriCommand(process.argv.slice(2));
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  child.on('error', (error) => {
    console.error(`Unable to start Tauri CLI: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
}
