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

If either value is absent or invalid, Preview remains locked. No production
private signing key belongs in this repository, CI variables, or client
artifacts.

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

## Service requirements

- Keep the Ed25519 private signing key in a managed secret/HSM boundary.
- Store hashed access codes, device public keys, lease IDs, status, expiry,
  nonce replay records, and an auditable revocation history.
- Rate-limit by access code, account, device, and source address.
- Return generic authentication errors; do not expose internal records.
- Support key rotation through an explicit protocol/key identifier before a
  second signing key is introduced.
