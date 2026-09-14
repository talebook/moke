// moke-ext sign — create a detached Ed25519 signature for a built extension.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
} from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const SIGNATURE_CONTEXT = 'moke-extension-signature-v1';
const PACKAGE_CONTEXT = Buffer.from('moke-extension-package-v1\0');
const MAX_PACKAGE_FILES = 10_000;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const HOST_MUTABLE_FILES = new Set([
  'signature.json',
  'storage.json',
  'uninstall.exe',
  'installer.nsi',
]);

function parseOptions(args) {
  const options = { dir: 'dist' };
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    const [name, inlineValue] = current.split('=', 2);
    if (!['--key', '--key-id', '--dir'].includes(name)) {
      throw new Error(`Unknown option: ${current}`);
    }
    const value = inlineValue ?? args[index += 1];
    if (!value) throw new Error(`${name} requires a value`);
    options[name.slice(2).replace('-', '_')] = value;
  }
  return options;
}

function collectFiles(root, current = root, files = [], depth = 0) {
  if (depth > 32) throw new Error('Package directory depth exceeds 32 levels');
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    const packagePath = relative(root, fullPath);
    const metadata = lstatSync(fullPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Package cannot contain symbolic links: ${packagePath}`);
    }
    if (metadata.isDirectory()) {
      collectFiles(root, fullPath, files, depth + 1);
    } else if (metadata.isFile()) {
      const isRootFile = !packagePath.includes(sep);
      const lowerName = packagePath.toLowerCase();
      const hostMutable = HOST_MUTABLE_FILES.has(lowerName) || lowerName.endsWith('-setup.exe');
      if (!(isRootFile && hostMutable)) {
        files.push(packagePath);
        if (files.length > MAX_PACKAGE_FILES) throw new Error(`Package exceeds ${MAX_PACKAGE_FILES} files`);
      }
    }
  }
  return files;
}

export function computePackageDigest(rootDirectory) {
  const root = resolve(rootDirectory);
  const files = collectFiles(root).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const packageHash = createHash('sha256');
  packageHash.update(PACKAGE_CONTEXT);
  let packageBytes = 0;
  for (const packagePath of files) {
    const normalizedPath = packagePath.split(sep).join('/');
    const bytes = readFileSync(join(root, packagePath));
    packageBytes += bytes.length;
    if (packageBytes > MAX_PACKAGE_BYTES) throw new Error('Package exceeds the 1 GiB safety limit');
    const fileHash = createHash('sha256').update(bytes).digest();
    packageHash.update(normalizedPath);
    packageHash.update(Buffer.from([0]));
    packageHash.update(fileHash);
    packageHash.update('\n');
  }
  return packageHash.digest('hex');
}

export function signaturePayload(manifest, keyId, packageDigest) {
  const publisher = manifest.publisher ?? {};
  return [
    SIGNATURE_CONTEXT,
    manifest.name ?? '',
    manifest.version ?? '',
    publisher.id ?? '',
    publisher.source ?? '',
    keyId,
    packageDigest,
  ].join('\n');
}

export function signPackage({ directory, keyPath, keyId }) {
  const root = resolve(directory);
  const resolvedKey = resolve(keyPath);
  const relativeKey = relative(root, resolvedKey);
  if (relativeKey === '' || (!relativeKey.startsWith(`..${sep}`) && !isAbsolute(relativeKey))) {
    throw new Error('Private signing key must be stored outside the extension package');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) {
    throw new Error('key-id may only contain letters, numbers, hyphens and underscores');
  }

  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  if (!manifest.publisher?.id || !manifest.publisher?.name || !manifest.publisher?.source) {
    throw new Error('manifest.publisher must declare id, name and source before signing');
  }

  const privateKey = createPrivateKey(readFileSync(resolvedKey));
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Signing key must be an Ed25519 private key');
  }
  const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const publicKey = publicDer.subarray(publicDer.length - 32);
  const packageSha256 = computePackageDigest(root);
  const signature = signBytes(
    null,
    Buffer.from(signaturePayload(manifest, keyId, packageSha256)),
    privateKey,
  );
  const detached = {
    schema_version: 1,
    algorithm: 'ed25519',
    key_id: keyId,
    public_key: publicKey.toString('base64'),
    package_sha256: packageSha256,
    signature: signature.toString('base64'),
  };
  writeFileSync(join(root, 'signature.json'), `${JSON.stringify(detached, null, 2)}\n`, {
    mode: 0o600,
  });
  return detached;
}

export default function sign(args) {
  const options = parseOptions(args);
  if (!options.key || !options.key_id) {
    throw new Error('Usage: moke-ext sign --key <private-key.pem> --key-id <key-id> [--dir dist]');
  }
  const detached = signPackage({
    directory: options.dir,
    keyPath: options.key,
    keyId: options.key_id,
  });
  console.log(`Signed ${resolve(options.dir)}`);
  console.log(`  key:    ${options.key_id}`);
  console.log(`  digest: ${detached.package_sha256}`);
}
