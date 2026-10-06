"""Sign OHOS HAPs from Actions secrets; publish only after SDK verification."""

import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile


def run(command):
    # The SDK can echo arguments (including passwords) on errors. Never forward
    # its output or a CalledProcessError containing the command into CI logs.
    result = subprocess.run(command, capture_output=True)
    if result.returncode:
        raise ValueError(f"{Path(command[0]).name} failed (exit {result.returncode})")
    return result.stdout


def require_secret(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"Missing Actions secret: {name}")
    return value


def validate_identity(profile, manifest):
    if profile.get('type') != 'release':
        raise ValueError('A release distribution profile is required')
    bundle = profile.get('bundle-info', {}).get('bundle-name')
    if not bundle or manifest.get('app', {}).get('bundleName') != bundle:
        raise ValueError('HAP bundle name does not match the distribution profile')


def sign(input_root, output_dir):
    inputs = sorted(input_root.rglob('*-unsigned.hap'))
    if not inputs:
        raise ValueError('No unsigned OHOS HAP found')
    names = [p.name.replace('-unsigned.hap', '-signed.hap') for p in inputs]
    if len(names) != len(set(names)):
        raise ValueError('Ambiguous HAP output names')
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError('Signed output directory must be empty')
    sdk = os.environ.get('OHOS_NDK_HOME')
    if not sdk:
        raise ValueError('OHOS_NDK_HOME is required')
    tool = Path(sdk) / 'toolchains/lib/hap-sign-tool.jar'
    if not tool.is_file():
        raise ValueError('SDK hap-sign-tool.jar is missing')
    alias = require_secret('OHOS_KEY_ALIAS')
    key_password = require_secret('OHOS_KEY_PASSWORD')
    store_password = require_secret('OHOS_KEYSTORE_PASSWORD')
    os.umask(0o077)
    # Stage on the same filesystem so publication is an atomic directory rename.
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.ohos-sign-', dir=output_dir.parent) as temp:
        root = Path(temp)
        for name, filename in [('OHOS_KEYSTORE_BASE64', 'release.p12'),
                               ('OHOS_APP_CERT_BASE64', 'chain.cer'),
                               ('OHOS_PROFILE_BASE64', 'profile.p7b')]:
            (root / filename).write_bytes(base64.b64decode(require_secret(name), validate=True))
        profile_file = root / 'profile.p7b'
        profile = json.loads(run(['openssl', 'cms', '-verify', '-inform', 'DER',
                                 '-in', str(profile_file), '-noverify']))
        for hap in inputs:
            with zipfile.ZipFile(hap) as archive:
                validate_identity(profile, json.loads(archive.read('module.json')))
        profile_cert = root / 'profile.cer'
        profile_cert.write_text(profile['bundle-info']['distribution-certificate'])
        store_cert = root / 'store.cer'
        store_cert.write_bytes(run(['openssl', 'pkcs12', '-in', str(root / 'release.p12'),
                                   '-passin', 'env:OHOS_KEYSTORE_PASSWORD', '-clcerts', '-nokeys']))
        public_keys = [run(['openssl', 'x509', '-in', str(p), '-noout', '-pubkey'])
                       for p in [profile_cert, store_cert, root / 'chain.cer']]
        if len(set(public_keys)) != 1:
            raise ValueError('Profile, certificate chain and keystore do not match')
        staged = root / 'signed'
        staged.mkdir()
        for hap, name in zip(inputs, names):
            signed = staged / name
            run(['java', '-jar', str(tool), 'sign-app', '-mode', 'localSign',
                 '-keyAlias', alias, '-keyPwd', key_password,
                 '-appCertFile', str(root / 'chain.cer'), '-profileFile', str(profile_file),
                 '-inFile', str(hap), '-signAlg', 'SHA256withECDSA',
                 '-keystoreFile', str(root / 'release.p12'), '-keystorePwd', store_password,
                 '-outFile', str(signed), '-compatibleVersion', '12'])
            verified_profile = root / 'verified.p7b'
            run(['java', '-jar', str(tool), 'verify-app', '-inFile', str(signed),
                 '-outCertChain', str(root / 'verified.cer'),
                 '-outProfile', str(verified_profile)])
            if verified_profile.read_bytes() != profile_file.read_bytes():
                raise ValueError('Verified HAP profile differs from the supplied profile')
        staged.replace(output_dir)
    print(f'Signed and verified {len(inputs)} OHOS package(s)')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-root', type=Path,
                        default=Path('src-tauri/gen/ohos/entry/build/default/outputs'))
    parser.add_argument('--output-dir', type=Path, default=Path('ohos-release-artifacts'))
    args = parser.parse_args()
    try:
        sign(args.input_root, args.output_dir)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        # Do not print exception details from parsers or secret decoding either.
        print(f'::error::OHOS release signing failed ({type(error).__name__}); '
              'check the signing secrets, profile identity, SDK and HAP inputs.')
        raise SystemExit(1)
