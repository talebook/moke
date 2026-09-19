# Moke Preview control plane

This service is the online trust boundary for Moke Preview. It registers
devices, issues one-hour Ed25519-signed leases, consumes each lease exactly
once during refresh, enforces revocation and device limits, and serves
authenticated updater manifests and short-lived artifact URLs.

It is intentionally kept in the private Preview repository. The desktop
binary remains patchable, so this service protects access and distribution; it
does not claim to make a client impossible to reverse engineer.

## Architecture

- The Axum service listens on `0.0.0.0:8080` inside the container. Compose
  publishes it only on `127.0.0.1:18080` for a host reverse proxy.
- PostgreSQL stores subjects, HMAC/Argon2-protected access codes, devices,
  single-use leases, replay nonces, rate-limit counters, manifests, and audit
  events.
- Release artifacts are read-only files under
  `ARTIFACT_ROOT/<version>/<filename>`. Canonical-path and symlink checks keep
  downloads inside that root.
- A TLS reverse proxy is mandatory. Expose only HTTPS publicly, preserve the
  original request body, limit request size, and redact `Authorization` and
  artifact query strings from access logs.

Public endpoints:

- `GET /healthz`
- `GET /v1/preview/info`
- `POST /v1/preview/leases`
- `POST /v1/preview/leases/refresh`
- `GET /v1/preview/updates/{target}/{arch}/{current_version}`
- `GET /v1/preview/artifacts/{version}/{filename}`

Operator endpoints require `Authorization: Bearer <PREVIEW_ADMIN_TOKEN>`:

- `POST /v1/admin/grants`
- `POST /v1/admin/subjects/{subject_id}/revoke`
- `POST /v1/admin/devices/{device_id}/revoke`
- `PUT /v1/admin/releases/{version}`

## Initial deployment

Create a deployment-only `.env`; never commit it. Generate four independent
secrets on the target host:

```sh
umask 077
openssl rand -base64 48 | tr -d '\n'
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
```

Use the 48-byte result for `POSTGRES_PASSWORD`. Use separate 32-byte results
for `PREVIEW_LEASE_SIGNING_KEY`, `PREVIEW_ACCESS_CODE_PEPPER`, and
`PREVIEW_ARTIFACT_URL_KEY`. Generate `PREVIEW_ADMIN_TOKEN` independently with
at least 32 random bytes as well. Do not reuse any updater signing key.

Then configure and start the service:

```sh
cp .env.example .env
mkdir -p artifacts
docker compose config
docker compose up --build -d
curl --fail http://127.0.0.1:18080/healthz
```

`PUBLIC_BASE_URL` must be the public HTTPS base URL of this service, including
any path prefix. Put a TLS reverse proxy in front of port 18080 and configure
health monitoring and host firewall rules before granting tester access.

After startup, read `/v1/preview/info` through HTTPS. Its
`leasePublicKey` value must be supplied as the release build's
`MOKE_PREVIEW_ENTITLEMENT_PUBLIC_KEY`; the service URL becomes
`MOKE_PREVIEW_ENTITLEMENT_URL`. A mismatch makes the client fail closed.

## Operator flow

Keep the admin token in a secret manager and inject it into an operator shell;
do not place it in command history. Create a tester grant:

```sh
curl --fail-with-body \
  -H "Authorization: Bearer $PREVIEW_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"preview-tester","deviceLimit":2,"expiresAt":null}' \
  "$CONTROL_PLANE_URL/v1/admin/grants"
```

The response contains the access code exactly once. Deliver it over a channel
appropriate for credentials. The database stores only a keyed lookup and an
Argon2 verifier, not the plaintext code.

Revoke an entire grant or one device:

```sh
curl --fail-with-body -X POST \
  -H "Authorization: Bearer $PREVIEW_ADMIN_TOKEN" \
  "$CONTROL_PLANE_URL/v1/admin/subjects/$SUBJECT_ID/revoke"

curl --fail-with-body -X POST \
  -H "Authorization: Bearer $PREVIEW_ADMIN_TOKEN" \
  "$CONTROL_PLANE_URL/v1/admin/devices/$DEVICE_ID/revoke"
```

Revocation takes effect immediately for refresh and update checks; an already
issued client lease remains usable only until its one-hour expiry.

## Publishing a release

The Preview release workflow creates signed Linux/Windows updater bundles,
manual-install packages, and `preview-latest.json`. It does not deploy files
to this service.

1. Transfer each signed artifact to a staging directory on the deployment
   host over an authenticated channel. Verify its digest against the CI
   artifact before moving it into
   `artifacts/<version>/<filename>` with read-only permissions.
2. Ensure every manifest URL has the same HTTPS origin as `PUBLIC_BASE_URL` and
   ends in the artifact filename. The service rewrites that URL to a
   five-minute, device-bound HMAC URL when serving an update check.
3. Publish the manifest only after all referenced files exist:

```sh
curl --fail-with-body -X PUT \
  -H "Authorization: Bearer $PREVIEW_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @preview-latest.json \
  "$CONTROL_PLANE_URL/v1/admin/releases/$VERSION"
```

macOS DMGs are manual-install artifacts only. They are rejected from updater
manifests until a Developer ID Application certificate is available; replacing
a locally/ad-hoc-signed app bundle through automatic update would invalidate
that local signature.

## GitHub `preview-release` environment

Create the protected environment manually, restrict its deploy branches/tags,
and require reviewers for releases. Configure:

Secrets:

- `MOKE_PREVIEW_ENTITLEMENT_URL`
- `MOKE_PREVIEW_ENTITLEMENT_PUBLIC_KEY`
- `PREVIEW_TAURI_SIGNING_PRIVATE_KEY`
- `PREVIEW_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Variables:

- `MOKE_PREVIEW_UPDATER_ENDPOINT`, for example
  `https://preview.example/v1/preview/updates/{{target}}/{{arch}}/{{current_version}}`
- `MOKE_PREVIEW_UPDATER_PUBLIC_KEY`
- `MOKE_PREVIEW_DOWNLOAD_BASE_URL`, ending at the artifact route before the
  version component

The service's lease key and the dedicated Tauri updater signing key are
different trust roots. Neither private key belongs in application build jobs.

## Operations and recovery

- Back up PostgreSQL with encrypted `pg_dump` output and back up the artifact
  directory separately. Test restore procedures on an isolated host.
- Retain audit events according to the project's privacy policy. Alert on
  repeated authorization failures, replay rejection, rate limiting, and
  unexpected grant/revocation activity.
- Rotating the access-code pepper invalidates existing access codes. Rotating
  the artifact URL key invalidates outstanding download URLs within five
  minutes. Rotate either with a planned maintenance window.
- Protocol v1 carries one lease public key. Rotating the lease signing key
  requires a coordinated Preview rebuild with the new public key; keep lease
  TTL at one hour during the transition and revoke the old deployment after
  clients move.
- Loss or suspected disclosure of the admin token requires immediate token
  replacement and audit review. Suspected updater-key disclosure requires a
  new updater keypair and client rebuild.
- Restore database and artifacts as one release-consistent set. Never restore
  an old database snapshot as a way to undo revocations.

The Compose file is a secure baseline, not a complete production platform. A
production deployment still needs TLS termination, encrypted backups,
monitoring, host patching, and a managed secret store or HSM boundary.
