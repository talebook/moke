# Preview entitlement protocol

Moke Preview uses short-lived Ed25519-signed leases. The application creates a
device key locally, proves possession of that key for activation and refresh,
and accepts only leases signed by the build-time entitlement public key.

This protocol raises the cost of copying an entitlement or changing a version
string. It does not make a client binary impossible to patch. Privileged
Preview commands must still call `require_preview_capability` in Rust.

## Build configuration

Release builders provide both variables to the Cargo process:

- `MOKE_PREVIEW_ENTITLEMENT_URL`: HTTPS service base URL, without query,
  fragment, or credentials.
- `MOKE_PREVIEW_ENTITLEMENT_PUBLIC_KEY`: base64 or unpadded base64url Ed25519
  public key (32 bytes after decoding).

If either value is absent or invalid, Preview remains locked. The entitlement
lease private key belongs only in the service-side secret/HSM boundary; it
must not enter this repository, release CI, or client artifacts.

## Device identity

On first launch the native client creates an Ed25519 keypair and random
installation ID under the app-private Preview data directory. The device ID is
`moke_` followed by the unpadded base64url SHA-256 digest of the public key.

The private key file is written with directory mode `0700` and file mode
`0600` on Unix. This is a portable baseline, not hardware-backed storage.
Moving the private file can clone an identity, so production hardening should
move it to Keychain, Credential Manager, or a platform keystore when those
backends are selected.

## Activation

`POST /v1/preview/leases`

The access code is sent only in `Authorization: Bearer ...` and is never saved
by Moke. The JSON body is:

```json
{
  "protocolVersion": 1,
  "deviceId": "moke_<digest>",
  "devicePublicKey": "<base64url>",
  "installationId": "<uuid>",
  "appVersion": "1.2.3",
  "proof": {
    "nonce": "<uuid>",
    "requestedAt": 1800000000,
    "signature": "<base64url>"
  }
}
```

The proof signature covers this exact UTF-8 message:

```text
moke-preview-activate-v1
<deviceId>
<installationId>
<nonce>
<requestedAt>
<appVersion>
```

The service reconstructs the proof message from these request fields and
should reject stale timestamps, reused nonces, disabled access codes,
device-limit violations, and public keys already bound incompatibly.

## Refresh

`POST /v1/preview/leases/refresh`

The request contains the current signed lease plus a fresh device proof using
the `moke-preview-refresh-v1` message prefix. The server verifies both the old
lease and proof before issuing a replacement. No access code is stored for
refresh.

## Signed lease response

Both endpoints return:

```json
{
  "payload": "<base64url encoded UTF-8 JSON>",
  "signature": "<base64url Ed25519 signature over decoded payload bytes>"
}
```

The decoded payload is:

```json
{
  "version": 1,
  "leaseId": "lease-id",
  "subject": "account-or-grant-id",
  "deviceId": "moke_<digest>",
  "capabilities": ["foundation"],
  "issuedAt": 1800000000,
  "expiresAt": 1800086400,
  "offlineUntil": 1800345600
}
```

The client limits online lifetime to 48 hours and the post-expiry offline
window to seven days. It rejects invalid signatures, a different device ID,
missing `foundation`, future issuance beyond five minutes, oversized data,
and detected system-clock rollback.

The offline deadline is a soft client-side limit on platforms where the
identity and checkpoint live only in files. A local administrator can restore
an older identity/lease snapshot together with the system clock. The native
checkpoint detects ordinary rollback but cannot provide a non-resettable
security boundary without a platform keystore/counter or a fresh server
check. Deployments that require hard revocation must shorten the signed lease
and require online refresh; they must not treat `offlineUntil` as server-grade
revocation enforcement.

## Authenticated updater access

Release builds request a fresh native authorization value before checking the
Preview update manifest. The value has this wire form:

```text
Authorization: MokePreview <base64url claims>.<base64url signature>
```

The decoded claims contain `protocolVersion`, the fixed action `update`,
`deviceId`, `devicePublicKey`, `installationId`, `appVersion`, `issuedAt`,
`expiresAt`, and a random `nonce`. The signature covers this exact message:

```text
moke-preview-update-authorization-v1
<base64url claims>
```

The native client issues the value only while its signed lease remains valid.
Its lifetime is at most five minutes and never extends beyond `offlineUntil`.
The distribution service must verify the device signature, match the public
key against the registered device, check the server-side entitlement and
revocation state, require the `update` action, enforce the timestamp window,
and reject nonce replay.

This header is sent only when checking the manifest. The authenticated
manifest should return short-lived, single-release artifact URLs; updater
downloads intentionally do not receive the authorization header. Tauri still
verifies every downloaded artifact with the dedicated Preview updater public
key. Stable and Preview updater keys and endpoints must never be reused.

The CI-generated `preview-latest.json` is private release metadata for the
distribution service to ingest. If its artifact URLs are not independently
short-lived, the service must rewrite them before returning the authenticated
manifest; it must not expose the CI file as an unauthenticated public object.

## Service requirements

- Keep the Ed25519 private signing key in a managed secret/HSM boundary.
- Store hashed access codes, device public keys, lease IDs, status, expiry,
  nonce replay records, and an auditable revocation history.
- Rate-limit by access code, account, device, and source address.
- Return generic authentication errors; do not expose internal records.
- Support key rotation through an explicit protocol/key identifier before a
  second signing key is introduced.
