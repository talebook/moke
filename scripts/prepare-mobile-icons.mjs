import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

// Copy reviewed assets verbatim. Never resize or regenerate icons during a build.
export function prepareMobileIcons(platform, root = projectRoot) {
  const tauriRoot = path.join(root, 'src-tauri');
  const source = path.join(tauriRoot, 'icons', platform);
  let destinations;
  if (platform === 'android') {
    destinations = [path.join(tauriRoot, 'gen/android/app/src/main/res')];
  } else if (platform === 'ohos') {
    destinations = [
      path.join(tauriRoot, 'gen/ohos/AppScope/resources/base/media'),
      path.join(tauriRoot, 'gen/ohos/entry/src/main/resources/base/media'),
    ];
  } else {
    throw new Error(`Unsupported icon platform: ${platform}`);
  }

  for (const destination of destinations) {
    if (!existsSync(destination)) {
      throw new Error(`Initialize the ${platform} project before copying icons: ${destination}`);
    }
  }

  let androidManifest;
  if (platform === 'android') {
    const file = path.join(destinations[0], '..', 'AndroidManifest.xml');
    if (!existsSync(file)) {
      throw new Error(`Initialize the android project before copying icons: ${file}`);
    }
    const original = readFileSync(file, 'utf8');
    const application = original.match(/<application\b[^>]*>/);
    if (!application || !/android:icon\s*=/.test(application[0])) {
      throw new Error(`Android manifest has no application icon: ${file}`);
    }
    const roundIcon = 'android:roundIcon="@mipmap/ic_launcher_round"';
    const attributes = /android:roundIcon\s*=/.test(application[0])
      ? application[0].replace(/android:roundIcon\s*=\s*["'][^"']*["']/, roundIcon)
      : application[0].replace(/android:icon\s*=\s*["'][^"']*["']/, `$&\n        ${roundIcon}`);
    androidManifest = { file, original, updated: original.replace(application[0], attributes) };
  }

  // Overlay individual resources without deleting names, themes, or shortcuts.
  const entries = readdirSync(source);
  for (const destination of destinations) {
    for (const entry of entries) {
      cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true });
    }
  }
  if (androidManifest && androidManifest.updated !== androidManifest.original) {
    writeFileSync(androidManifest.file, androidManifest.updated, 'utf8');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareMobileIcons(process.argv[2]);
  console.log(`[icons] Copied committed ${process.argv[2]} icons`);
}
