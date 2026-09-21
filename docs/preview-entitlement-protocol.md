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
installation ID. Only the installation ID, public key, and an opaque key ID are
stored under the app-private Preview data directory. The PKCS#8 private key is
stored through the operating-system credential service (Keychain on macOS,
Credential Manager on Windows, Secret Service on Linux). Copying the Moke app
data directory to another machine therefore does not copy a usable identity.
Version 1 file-backed identities are retired rather than imported, and their
leases must be activated again with a newly generated credential-store key.

The device ID is `moke_` followed by the unpadded base64url SHA-256 digest of
the public key. An OS credential service is materially stronger than an
app-data JSON file, but it is not equivalent to a non-exportable TPM or Secure
Enclave signing key. A process running as the same desktop user may still be
able to request the stored secret. The server remains the hard revocation and
device-limit boundary.

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
  "replaceExistingDevice": false,
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

When the server reports `DEVICE_LIMIT_REACHED`, the bootstrap UI may offer a
separate, explicit device-replacement confirmation. That retry sets
`replaceExistingDevice` to `true` and signs the proof with the distinct
`moke-preview-activate-replace-v1` action, so an intermediary cannot change a
normal activation into a replacement. The reference service permits this only
for one-device grants, after the old device has been inactive for 24 hours,
and no more than once every seven days. It atomically revokes the previous
device and leases and records an audit event. Immediate recovery requires an
operator to revoke the old device first.

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
  "expiresAt": 1800003600,
  "offlineUntil": 1800003600
}
```

The client limits the signed lease to one hour and requires `offlineUntil` to
equal `expiresAt`; Preview releases intentionally have no offline grace
period. It rejects invalid signatures, a different device ID, missing
`foundation`, future issuance beyond five minutes, oversized data, and
detected system-clock rollback. Every process start refreshes the lease before
the privileged window and extension services are created.

The local checkpoint remains defense in depth, not a non-resettable trust
root. Hard revocation comes from short server leases and the mandatory online
refresh. A deployment that later restores offline use must first provide a
non-exportable platform signing key plus non-rollback state; it must not treat
an app-data checkpoint as server-grade enforcement.

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

Before issuing this value, the native client performs an online lease refresh,
giving the service an immediate revocation and device-limit decision. Its
lifetime is at most five minutes and never extends beyond `expiresAt`.
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

macOS Preview builds are intentionally omitted from this updater manifest
until releases can be signed with a Developer ID Application certificate. The
private release still publishes a DMG for manual installation, after which
testers may apply their local development or ad-hoc signing procedure. An
automatic update would replace that locally signed app bundle and invalidate
the tester's signature, so a DMG must never be advertised as a Darwin updater
artifact.

## Service requirements

- Keep the Ed25519 private signing key in a managed secret/HSM boundary.
- Store hashed access codes, device public keys, lease IDs, status, expiry,
  nonce replay records, and an auditable revocation history.
- Rate-limit by access code, account, device, and source address.
- Return generic authentication errors; do not expose internal records.
- Support key rotation through an explicit protocol/key identifier before a
  second signing key is introduced.
