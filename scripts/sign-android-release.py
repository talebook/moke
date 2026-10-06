"""Align, sign and verify Android release APKs using Actions secrets."""

import argparse
import base64
import os
from pathlib import Path
import subprocess
import tempfile


def require_secret(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f'Missing Actions secret: {name}')
    return value


def run(command):
    result = subprocess.run(command, capture_output=True)
    if result.returncode:
        # Signing tools can include sensitive arguments in their error output.
        raise ValueError(f'{Path(command[0]).name} failed (exit {result.returncode})')


def sign(input_root, output_dir, build_tools=None):
    inputs = sorted(input_root.rglob('*release-unsigned.apk'))
    if not inputs:
        raise ValueError('No unsigned Android release APK found')
    names = [p.name.replace('-unsigned.apk', '-signed.apk') for p in inputs]
    if len(names) != len(set(names)):
        raise ValueError('Ambiguous APK output names')
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError('Signed output directory must be empty')
    if build_tools is None:
        sdk = os.environ.get('ANDROID_HOME')
        if not sdk:
            raise ValueError('ANDROID_HOME is required')
        build_tools = Path(sdk) / 'build-tools/35.0.0'
    for name in ('zipalign', 'apksigner'):
        if not os.access(build_tools / name, os.X_OK):
            raise ValueError(f'Android build tool is missing: {name}')
    alias = require_secret('ANDROID_KEY_ALIAS')
    require_secret('ANDROID_KEYSTORE_PASSWORD')
    require_secret('ANDROID_KEY_PASSWORD')
    keystore = base64.b64decode(require_secret('ANDROID_KEYSTORE_BASE64'), validate=True)
    os.umask(0o077)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.android-sign-', dir=output_dir.parent) as temp:
        root = Path(temp)
        store = root / 'release.keystore'
        store.write_bytes(keystore)
        staged = root / 'signed'
        staged.mkdir()
        for index, (apk, name) in enumerate(zip(inputs, names)):
            aligned = root / f'aligned-{index}.apk'
            signed = staged / name
            # Align native libraries for devices with 16 KiB memory pages before signing.
            run([str(build_tools / 'zipalign'), '-P', '16', '-f', '4', str(apk), str(aligned)])
            run([str(build_tools / 'apksigner'), 'sign', '--ks', str(store),
                 '--ks-key-alias', alias, '--ks-pass', 'env:ANDROID_KEYSTORE_PASSWORD',
                 '--key-pass', 'env:ANDROID_KEY_PASSWORD', '--v4-signing-enabled', 'false',
                 '--out', str(signed), str(aligned)])
            run([str(build_tools / 'apksigner'), 'verify', '--verbose', str(signed)])
            run([str(build_tools / 'zipalign'), '-c', '-P', '16', '4', str(signed)])
        staged.replace(output_dir)
    print(f'Signed and verified {len(inputs)} Android package(s)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-root', type=Path,
                        default=Path('src-tauri/gen/android/app/build/outputs/apk'))
    parser.add_argument('--output-dir', type=Path, default=Path('android-release-artifacts'))
    parser.add_argument('--build-tools', type=Path)
    args = parser.parse_args()
    try:
        sign(args.input_root, args.output_dir, args.build_tools)
    except (ValueError, OSError) as error:
        print(f'::error::Android release signing failed ({type(error).__name__}); '
              'check the signing secrets, SDK build tools and APK inputs.')
        raise SystemExit(1)
