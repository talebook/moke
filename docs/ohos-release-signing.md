# OHOS Release signing

Both `hehetoshang/moke` (`build-release.yml`) and the public
`hehetoshang/moke-preview-builds` (`preview.yml`) use
`scripts/sign-ohos-release.py` from this repository. The public workflow resolves
one private `main` revision before building. Deploy changes to this repository
before enabling the corresponding public workflow.

Required repository Actions secrets:

| Secret | Value |
| --- | --- |
| `OHOS_KEYSTORE_BASE64` | Base64-encoded PKCS#12 keystore |
| `OHOS_KEYSTORE_PASSWORD` | Keystore password |
| `OHOS_KEY_ALIAS` | Signing key alias |
| `OHOS_KEY_PASSWORD` | Private key password |
| `OHOS_APP_CERT_BASE64` | Base64-encoded PEM certificate chain, leaf first |
| `OHOS_PROFILE_BASE64` | Base64-encoded Release distribution Profile (.p7b) |

Secrets are passed only to the post-build signing step. Temporary credentials are
owner-readable and removed when that step exits. SDK subprocess output is not
forwarded, because error messages can echo password arguments. The signer checks
Profile integrity, Release type, package identity and certificate/keystore public
keys, signs with the SDK, then verifies the resulting HAP and extracted Profile.
Only a fully verified output directory is published. Workflows upload only its
`*-signed.hap` files, never the unsigned HAPs or temporary signing credentials.

## Package identity

The current Huawei Profile is for `org.houheya.moke_openharmony`.
Both the Tauri configuration used for OHOS initialization/build and the generated
`AppScope/app.json5` must use that same identity. `prepare-ohos-release.mjs`
checks the generated identity without rewriting it. Public Preview builds use
this OHOS-specific identifier while retaining the Preview frontend, Cargo feature
and entitlement checks. The build-channel guard permits this identity only for
the OHOS target and still requires the Preview frontend and feature to agree.
Other platforms retain `org.houheya.moke.preview`.

Preview and stable OHOS packages using this same native identity cannot be
installed side by side. Installation/upgrade also depends on the device accepting
the certificate, Profile and distribution method; local SDK verification alone
does not prove device acceptance. No existing installation is removed by this
workflow. The `talebook/moke` workflows are not modified by this change.

## Focused verification

```sh
node --test tests/ohos-release.test.mjs
python3 -m unittest discover -s tests -p 'test_ohos_release.py'
```

With the six secrets in the environment and `OHOS_NDK_HOME` pointing to the SDK:

```sh
python3 scripts/sign-ohos-release.py --input-root path/to/unsigned-haps --output-dir path/to/new-signed-output
```

The output directory must be absent or empty. Failed signing/verification stops
artifact publication. This does not enable Tauri updater signing or change tag
versus manual-run publishing behavior.
