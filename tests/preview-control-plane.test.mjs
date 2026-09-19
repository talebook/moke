import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const api = readText('services/preview-control-plane/src/api.rs');
const compose = readText('services/preview-control-plane/compose.yml');
const dockerfile = readText('services/preview-control-plane/Dockerfile');
const migration = readText('services/preview-control-plane/migrations/0001_initial.sql');
const store = readText('services/preview-control-plane/src/store.rs');

test('control plane stores no plaintext access code and consumes refresh leases once', () => {
  const accessCodes = migration.slice(
    migration.indexOf('CREATE TABLE access_codes'),
    migration.indexOf('CREATE TABLE devices'),
  );
  assert.match(accessCodes, /lookup_hash bytea NOT NULL UNIQUE/);
  assert.match(accessCodes, /verifier_hash text NOT NULL/);
  assert.doesNotMatch(accessCodes, /^\s*(?:access_)?code\s+text/im);

  assert.match(
    store,
    /UPDATE leases SET consumed_at = now\(\)[\s\S]*consumed_at IS NULL[\s\S]*RETURNING id/,
  );
  assert.match(store, /if consumed\.is_none\(\)[\s\S]*StoreError::LeaseConsumed/);
});

test('control plane schema enforces nonce replay and one-hour lease boundaries', () => {
  assert.match(migration, /PRIMARY KEY \(scope, nonce\)/);
  assert.match(migration, /CHECK \(expires_at <= issued_at \+ interval '1 hour'\)/);
  assert.match(migration, /status text NOT NULL DEFAULT 'active' CHECK \(status IN \('active', 'revoked'\)\)/);
});

test('control plane container is unprivileged and exposes only a loopback port', () => {
  assert.match(dockerfile, /^FROM rust:1\.90-bookworm@sha256:[a-f0-9]{64} AS builder/m);
  assert.match(dockerfile, /^FROM debian:bookworm-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(compose, /image: postgres:17\.6-bookworm@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(compose, /DATABASE_URL/);
  assert.match(compose, /DATABASE_PASSWORD: \$\{POSTGRES_PASSWORD:\?set POSTGRES_PASSWORD\}/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(compose, /"127\.0\.0\.1:18080:8080"/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop: \[ALL\]/);
  assert.match(compose, /\/srv\/artifacts:ro/);
});

test('control plane updater excludes Darwin and confines artifact paths', () => {
  const allowedPlatforms = api.slice(
    api.indexOf('for (platform, artifact)'),
    api.indexOf('store::upsert_manifest'),
  );
  assert.match(allowedPlatforms, /linux-x86_64/);
  assert.match(allowedPlatforms, /windows-x86_64/);
  assert.doesNotMatch(allowedPlatforms, /darwin-(?:x86_64|aarch64)/);
  assert.match(api, /canonical_candidate\.starts_with\(&canonical_root\)/);
  assert.match(api, /metadata\.file_type\(\)\.is_symlink\(\)/);
});

test('authorization is marked sensitive before tracing and admin routes are rate limited', () => {
  const traceLayer = api.indexOf('.layer(TraceLayer::new_for_http())');
  const sensitiveLayer = api.indexOf('.layer(SetSensitiveRequestHeadersLayer::new');
  assert.ok(traceLayer >= 0 && sensitiveLayer > traceLayer);
  assert.match(api, /header::AUTHORIZATION/);
  assert.doesNotMatch(api, /tracing::(?:info|debug|warn|error)!\([^)]*(?:admin_token|authorization)/i);

  for (const handler of ['create_grant', 'revoke_subject', 'revoke_device', 'publish_release']) {
    const start = api.indexOf(`async fn ${handler}`);
    const end = api.indexOf('\nasync fn ', start + 1);
    const body = api.slice(start, end === -1 ? undefined : end);
    assert.match(body, /enforce_rate_limit[\s\S]*require_admin/);
  }
});
