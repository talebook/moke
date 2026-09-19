CREATE TABLE subjects (
    id uuid PRIMARY KEY,
    label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    device_limit integer NOT NULL CHECK (device_limit BETWEEN 1 AND 100),
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

CREATE TABLE access_codes (
    id uuid PRIMARY KEY,
    subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    lookup_hash bytea NOT NULL UNIQUE CHECK (octet_length(lookup_hash) = 32),
    verifier_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    disabled_at timestamptz,
    last_used_at timestamptz
);

CREATE TABLE devices (
    device_id text PRIMARY KEY CHECK (device_id ~ '^moke_[A-Za-z0-9_-]{43}$'),
    subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    installation_id uuid NOT NULL,
    public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    app_version text NOT NULL CHECK (char_length(app_version) BETWEEN 1 AND 64),
    revoked_at timestamptz,
    UNIQUE (subject_id, installation_id)
);

CREATE INDEX devices_subject_status_idx ON devices(subject_id, status);

CREATE TABLE leases (
    id uuid PRIMARY KEY,
    subject_id uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    device_id text NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    revoked_at timestamptz,
    CHECK (expires_at > issued_at),
    CHECK (expires_at <= issued_at + interval '1 hour')
);

CREATE INDEX leases_device_expiry_idx ON leases(device_id, expires_at DESC);

CREATE TABLE replay_nonces (
    scope text NOT NULL CHECK (scope IN ('activate', 'refresh', 'update')),
    nonce uuid NOT NULL,
    device_id text NOT NULL,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (scope, nonce)
);

CREATE INDEX replay_nonces_expiry_idx ON replay_nonces(expires_at);

CREATE TABLE rate_limits (
    bucket text PRIMARY KEY,
    window_started_at timestamptz NOT NULL,
    hits integer NOT NULL CHECK (hits >= 0)
);

CREATE TABLE release_manifests (
    version text PRIMARY KEY CHECK (char_length(version) BETWEEN 1 AND 64),
    manifest jsonb NOT NULL,
    published boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);

CREATE TABLE audit_events (
    id bigserial PRIMARY KEY,
    subject_id uuid REFERENCES subjects(id) ON DELETE SET NULL,
    device_id text,
    action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
    outcome text NOT NULL CHECK (outcome IN ('success', 'rejected', 'revoked')),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_subject_created_idx ON audit_events(subject_id, created_at DESC);
CREATE INDEX audit_events_device_created_idx ON audit_events(device_id, created_at DESC);
