// moke-ext build — prepare dist/ for packaging

import { existsSync, mkdirSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

export default function build() {
  const cwd = process.cwd();
  const manifestPath = join(cwd, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('No manifest.json found. Run "moke-ext init <name>" first.');
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const name = manifest.name;
  const dist = join(cwd, 'dist');

  console.log(`Building "${name}"...\n`);

  // Clean dist
  if (existsSync(dist)) { rmSync(dist, { recursive: true }); }
  mkdirSync(dist, { recursive: true });

  // Copy manifest
  cpSync(manifestPath, join(dist, 'manifest.json'));
  console.log('  [copy] manifest.json');

  // Copy icon
  const iconPath = join(cwd, 'icon.png');
  if (existsSync(iconPath)) {
    cpSync(iconPath, join(dist, 'icon.png'));
    console.log('  [copy] icon.png');
  } else {
    console.log('  [skip] icon.png (not found — add a 128x128 PNG)');
  }

  // Copy UI
  const uiPath = join(cwd, 'ui');
  if (existsSync(uiPath)) {
    cpSync(uiPath, join(dist, 'ui'), { recursive: true });
    console.log('  [copy] ui/');
  } else {
    console.log('  [skip] ui/ (not found)');
  }

  // Build backend if Cargo.toml exists
  const cargoPath = join(cwd, 'backend', 'Cargo.toml');
  if (existsSync(cargoPath)) {
    console.log('\n  Building Rust backend...');
    try {
      execSync('cargo build --release', { cwd: join(cwd, 'backend'), stdio: 'inherit' });
      // Copy the binary. Try common names: server, or package name
      const targetDir = join(cwd, 'backend', 'target', 'release');
      const binName = manifest.entry?.backend?.executable?.replace('.exe', '') || 'server';
      const exePath = join(targetDir, `${binName}.exe`);
      const altPath = join(targetDir, `${name.replace(/-/g, '_')}.exe`);
      if (existsSync(exePath)) {
        cpSync(exePath, join(dist, `${binName}.exe`));
        console.log(`  [copy] ${binName}.exe`);
      } else if (existsSync(altPath)) {
        cpSync(altPath, join(dist, `${binName}.exe`));
        console.log(`  [copy] ${binName}.exe (from ${altPath})`);
      } else {
        // List all .exe files
        const { readdirSync } = await import('node:fs');
        const files = readdirSync(targetDir).filter(f => f.endsWith('.exe'));
        if (files.length === 1) {
          cpSync(join(targetDir, files[0]), join(dist, `${binName}.exe`));
          console.log(`  [copy] ${binName}.exe (found: ${files[0]})`);
        } else {
          console.error(`  WARN: Could not find built binary. Expected: ${exePath}`);
          console.error(`  Found .exe files: ${files.join(', ') || 'none'}`);
          console.error(`  Copy the correct binary to dist/${binName}.exe manually.`);
        }
      }
    } catch (e) {
      console.error('  Backend build failed. Continuing without it.');
    }
  } else {
    console.log('\n  No backend/Cargo.toml found — skipping Rust build.');
    if (manifest.entry?.backend) {
      console.error('  WARN: manifest declares backend but no backend/Cargo.toml exists.');
      console.error(`  Add your compiled binary as dist/${manifest.entry.backend.executable}`);
    }
  }

  // Check installer script
  const nsiPath = join(cwd, 'installer.nsi');
  if (existsSync(nsiPath)) {
    cpSync(nsiPath, join(dist, 'installer.nsi'));
    console.log('  [copy] installer.nsi');
  }

  console.log(`\nBuild complete. dist/ is ready.`);
  console.log(`Next: moke-ext package   (requires NSIS)`);
  console.log(`  or copy dist/* to %APPDATA%\\com.moke.client\\extensions\\${name}\\ for manual install`);
}
