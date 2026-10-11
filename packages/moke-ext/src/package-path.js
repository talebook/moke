// ZIP and signature paths share the host's portable NFC UTF-8 contract.
export function validatePackagePath(path) {
  if (!path || Buffer.byteLength(path) > 1024 || path.normalize('NFC') !== path || path.split('/').length > 32) {
    throw new Error(`Invalid NFC package path: ${path}`);
  }
  for (const part of path.split('/')) {
    if (!part || part === '.' || part === '..' || Buffer.byteLength(part) > 240 || /[. ]$/.test(part)
      || /[\x00-\x1f\x7f-\x9f\\:<>"|?*]/.test(part)
      || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(part.split('.')[0])) {
      throw new Error(`Unsafe or nonportable package path: ${path}`);
    }
  }
  return path;
}
export function normalizeNativePath(path, separator) {
  return validatePackagePath(path.split(separator).join('/'));
}
export function reservedPackagePath(path) {
  const first = path.split('/')[0].toLowerCase();
  return ['storage.json', 'storage.tmp', 'trust.json', 'trust.tmp', 'runtime.json', 'runtime.tmp', 'uninstall.exe', 'installer.nsi'].includes(first)
    || first.startsWith('.') || first.endsWith('-setup.exe');
}
