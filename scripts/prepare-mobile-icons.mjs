import { cpSync, existsSync, readdirSync } from 'node:fs';
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

  // Overlay individual resources without deleting names, themes, or shortcuts.
  const entries = readdirSync(source);
  for (const destination of destinations) {
    for (const entry of entries) {
      cpSync(path.join(source, entry), path.join(destination, entry), { recursive: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareMobileIcons(process.argv[2]);
  console.log(`[icons] Copied committed ${process.argv[2]} icons`);
}
