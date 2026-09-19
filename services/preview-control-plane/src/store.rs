use crate::model::{UpdateAuthorizationClaims, UpdateManifest};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug)]
pub struct AccessCodeRecord {
    pub id: Uuid,
    pub subject_id: Uuid,
    pub verifier_hash: String,
    pub expires_at: Option<OffsetDateTime>,
    pub disabled_at: Option<OffsetDateTime>,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("authorization rejected")]
    Rejected,
    #[error("device limit reached")]
    DeviceLimit,
    #[error("request replayed")]
    Replay,
    #[error("lease already consumed")]
    LeaseConsumed,
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

pub async fn consume_rate_limit(
    pool: &PgPool,
    bucket: &str,
    limit: i32,
    window_seconds: i32,
) -> Result<bool, sqlx::Error> {
    let hits: i32 = sqlx::query_scalar(
        r#"
        INSERT INTO rate_limits (bucket, window_started_at, hits)
        VALUES ($1, now(), 1)
        ON CONFLICT (bucket) DO UPDATE SET
          window_started_at = CASE
            WHEN rate_limits.window_started_at <= now() - ($2 * interval '1 second') THEN now()
            ELSE rate_limits.window_started_at
          END,
          hits = CASE
            WHEN rate_limits.window_started_at <= now() - ($2 * interval '1 second') THEN 1
            ELSE rate_limits.hits + 1
          END
        RETURNING hits
        "#,
    )
    .bind(bucket)
    .bind(window_seconds)
    .fetch_one(pool)
    .await?;
    Ok(hits <= limit)
}

pub async fn find_access_code(
    pool: &PgPool,
    lookup_hash: &[u8; 32],
) -> Result<Option<AccessCodeRecord>, sqlx::Error> {
    let row = sqlx::query(
        r#"
        SELECT id, subject_id, verifier_hash, expires_at, disabled_at
        FROM access_codes
        WHERE lookup_hash = $1
        "#,
    )
    .bind(lookup_hash.as_slice())
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| AccessCodeRecord {
        id: row.get("id"),
        subject_id: row.get("subject_id"),
        verifier_hash: row.get("verifier_hash"),
        expires_at: row.get("expires_at"),
        disabled_at: row.get("disabled_at"),
    }))
}

pub async fn device_public_key(
    pool: &PgPool,
    device_id: &str,
) -> Result<Option<[u8; 32]>, sqlx::Error> {
    let key: Option<Vec<u8>> = sqlx::query_scalar(
        "SELECT public_key FROM devices WHERE device_id = $1 AND status = 'active'",
    )
    .bind(device_id)
    .fetch_optional(pool)
    .await?;
    Ok(key.and_then(|key| key.try_into().ok()))
}

#[allow(clippy::too_many_arguments)]
pub async fn activate_device(
    pool: &PgPool,
    access_code_id: Uuid,
    subject_id: Uuid,
    device_id: &str,
    installation_id: Uuid,
    public_key: &[u8; 32],
    app_version: &str,
    nonce: Uuid,
    lease_id: Uuid,
    issued_at: OffsetDateTime,
    expires_at: OffsetDateTime,
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    let subject = sqlx::query("SELECT status, device_limit FROM subjects WHERE id = $1 FOR UPDATE")
        .bind(subject_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(StoreError::Rejected)?;
    let status: String = subject.get("status");
    let device_limit: i32 = subject.get("device_limit");
    if status != "active" {
        return Err(StoreError::Rejected);
    }
    insert_nonce(
        &mut tx,
        "activate",
        nonce,
        device_id,
        issued_at + time::Duration::minutes(10),
    )
    .await?;

    if let Some(row) = sqlx::query(
        r#"SELECT subject_id, installation_id, public_key, status
           FROM devices WHERE device_id = $1 FOR UPDATE"#,
    )
    .bind(device_id)
    .fetch_optional(&mut *tx)
    .await?
    {
        let stored_subject: Uuid = row.get("subject_id");
        let stored_installation: Uuid = row.get("installation_id");
        let stored_key: Vec<u8> = row.get("public_key");
        let stored_status: String = row.get("status");
        if stored_subject != subject_id
            || stored_installation != installation_id
            || stored_key.as_slice() != public_key
            || stored_status != "active"
        {
            return Err(StoreError::Rejected);
        }
        sqlx::query(
            "UPDATE devices SET last_seen_at = now(), app_version = $2 WHERE device_id = $1",
        )
        .bind(device_id)
        .bind(app_version)
        .execute(&mut *tx)
        .await?;
    } else {
        let active_devices: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM devices WHERE subject_id = $1 AND status = 'active'",
        )
        .bind(subject_id)
        .fetch_one(&mut *tx)
        .await?;
        if active_devices >= i64::from(device_limit) {
            return Err(StoreError::DeviceLimit);
        }
        sqlx::query(
            r#"
            INSERT INTO devices
              (device_id, subject_id, installation_id, public_key, app_version)
            VALUES ($1, $2, $3, $4, $5)
            "#,
        )
        .bind(device_id)
        .bind(subject_id)
        .bind(installation_id)
        .bind(public_key.as_slice())
        .bind(app_version)
        .execute(&mut *tx)
        .await?;
    }

    // A successful re-activation rotates any older refresh handles for this device.
    sqlx::query(
        "UPDATE leases SET consumed_at = now() WHERE device_id = $1 AND consumed_at IS NULL",
    )
    .bind(device_id)
    .execute(&mut *tx)
    .await?;
    insert_lease(
        &mut tx, lease_id, subject_id, device_id, issued_at, expires_at,
    )
    .await?;
    sqlx::query("UPDATE access_codes SET last_used_at = now() WHERE id = $1")
        .bind(access_code_id)
        .execute(&mut *tx)
        .await?;
    insert_audit(
        &mut tx,
        Some(subject_id),
        Some(device_id),
        "lease.activate",
        "success",
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn refresh_device(
    pool: &PgPool,
    subject_id: Uuid,
    device_id: &str,
    installation_id: Uuid,
    public_key: &[u8; 32],
    app_version: &str,
    nonce: Uuid,
    previous_lease_id: Uuid,
    next_lease_id: Uuid,
    issued_at: OffsetDateTime,
    expires_at: OffsetDateTime,
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    let device = sqlx::query(
        r#"
        SELECT d.subject_id, d.installation_id, d.public_key, d.status, s.status AS subject_status
        FROM devices d
        JOIN subjects s ON s.id = d.subject_id
        WHERE d.device_id = $1
        FOR UPDATE OF d, s
        "#,
    )
    .bind(device_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(StoreError::Rejected)?;
    let stored_key: Vec<u8> = device.get("public_key");
    if device.get::<Uuid, _>("subject_id") != subject_id
        || device.get::<Uuid, _>("installation_id") != installation_id
        || stored_key.as_slice() != public_key
        || device.get::<String, _>("status") != "active"
        || device.get::<String, _>("subject_status") != "active"
    {
        return Err(StoreError::Rejected);
    }
    insert_nonce(
        &mut tx,
        "refresh",
        nonce,
        device_id,
        issued_at + time::Duration::minutes(10),
    )
    .await?;
    let consumed = sqlx::query(
        r#"
        UPDATE leases SET consumed_at = now()
        WHERE id = $1 AND subject_id = $2 AND device_id = $3
          AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING id
        "#,
    )
    .bind(previous_lease_id)
    .bind(subject_id)
    .bind(device_id)
    .fetch_optional(&mut *tx)
    .await?;
    if consumed.is_none() {
        return Err(StoreError::LeaseConsumed);
    }
    insert_lease(
        &mut tx,
        next_lease_id,
        subject_id,
        device_id,
        issued_at,
        expires_at,
    )
    .await?;
    sqlx::query("UPDATE devices SET last_seen_at = now(), app_version = $2 WHERE device_id = $1")
        .bind(device_id)
        .bind(app_version)
        .execute(&mut *tx)
        .await?;
    insert_audit(
        &mut tx,
        Some(subject_id),
        Some(device_id),
        "lease.refresh",
        "success",
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn authorize_update(
    pool: &PgPool,
    claims: &UpdateAuthorizationClaims,
    public_key: &[u8; 32],
    nonce: Uuid,
    now: OffsetDateTime,
) -> Result<(), StoreError> {
    let mut tx = pool.begin().await?;
    let device = sqlx::query(
        r#"
        SELECT d.subject_id, d.installation_id, d.public_key, d.status, s.status AS subject_status
        FROM devices d
        JOIN subjects s ON s.id = d.subject_id
        WHERE d.device_id = $1
        FOR UPDATE OF d, s
        "#,
    )
    .bind(&claims.device_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(StoreError::Rejected)?;
    let stored_key: Vec<u8> = device.get("public_key");
    if device.get::<Uuid, _>("installation_id") != claims.installation_id
        || stored_key.as_slice() != public_key
        || device.get::<String, _>("status") != "active"
        || device.get::<String, _>("subject_status") != "active"
    {
        return Err(StoreError::Rejected);
    }
    insert_nonce(
        &mut tx,
        "update",
        nonce,
        &claims.device_id,
        now + time::Duration::minutes(10),
    )
    .await?;
    let subject_id: Uuid = device.get("subject_id");
    insert_audit(
        &mut tx,
        Some(subject_id),
        Some(&claims.device_id),
        "update.manifest",
        "success",
    )
    .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn latest_manifest(
    pool: &PgPool,
    current_version: &semver::Version,
) -> Result<Option<UpdateManifest>, sqlx::Error> {
    let rows = sqlx::query("SELECT manifest FROM release_manifests WHERE published = true")
        .fetch_all(pool)
        .await?;
    let mut latest: Option<(semver::Version, UpdateManifest)> = None;
    for row in rows {
        let value: serde_json::Value = row.get("manifest");
        let Ok(manifest) = serde_json::from_value::<UpdateManifest>(value) else {
            tracing::error!("stored release manifest is invalid");
            continue;
        };
        let Ok(version) = semver::Version::parse(&manifest.version) else {
            tracing::error!(version = %manifest.version, "stored release version is invalid");
            continue;
        };
        if version > *current_version
            && latest
                .as_ref()
                .is_none_or(|(candidate, _)| version > *candidate)
        {
            latest = Some((version, manifest));
        }
    }
    Ok(latest.map(|(_, manifest)| manifest))
}

#[allow(clippy::too_many_arguments)]
pub async fn create_grant(
    pool: &PgPool,
    subject_id: Uuid,
    label: &str,
    device_limit: i32,
    access_code_id: Uuid,
    lookup_hash: &[u8; 32],
    verifier_hash: &str,
    expires_at: Option<OffsetDateTime>,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO subjects (id, label, device_limit) VALUES ($1, $2, $3)")
        .bind(subject_id)
        .bind(label)
        .bind(device_limit)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"
        INSERT INTO access_codes
          (id, subject_id, lookup_hash, verifier_hash, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(access_code_id)
    .bind(subject_id)
    .bind(lookup_hash.as_slice())
    .bind(verifier_hash)
    .bind(expires_at)
    .execute(&mut *tx)
    .await?;
    insert_audit(&mut tx, Some(subject_id), None, "grant.create", "success").await?;
    tx.commit().await?;
    Ok(())
}

pub async fn revoke_subject(pool: &PgPool, subject_id: Uuid) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE subjects SET status = 'revoked', revoked_at = now() WHERE id = $1 AND status = 'active'",
    )
    .bind(subject_id)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated > 0 {
        sqlx::query("UPDATE access_codes SET disabled_at = now() WHERE subject_id = $1 AND disabled_at IS NULL")
            .bind(subject_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE devices SET status = 'revoked', revoked_at = now() WHERE subject_id = $1 AND status = 'active'")
            .bind(subject_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "UPDATE leases SET revoked_at = now() WHERE subject_id = $1 AND revoked_at IS NULL",
        )
        .bind(subject_id)
        .execute(&mut *tx)
        .await?;
        insert_audit(&mut tx, Some(subject_id), None, "subject.revoke", "revoked").await?;
    }
    tx.commit().await?;
    Ok(updated > 0)
}

pub async fn revoke_device(pool: &PgPool, device_id: &str) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let row = sqlx::query(
        r#"
        UPDATE devices SET status = 'revoked', revoked_at = now()
        WHERE device_id = $1 AND status = 'active'
        RETURNING subject_id
        "#,
    )
    .bind(device_id)
    .fetch_optional(&mut *tx)
    .await?;
    let revoked = row.is_some();
    if let Some(row) = row {
        let subject_id: Uuid = row.get("subject_id");
        sqlx::query(
            "UPDATE leases SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL",
        )
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
        insert_audit(
            &mut tx,
            Some(subject_id),
            Some(device_id),
            "device.revoke",
            "revoked",
        )
        .await?;
    }
    tx.commit().await?;
    Ok(revoked)
}

pub async fn upsert_manifest(pool: &PgPool, manifest: &UpdateManifest) -> Result<(), sqlx::Error> {
    let value = serde_json::to_value(manifest).expect("manifest serialization is infallible");
    sqlx::query(
        r#"
        INSERT INTO release_manifests (version, manifest, published, published_at)
        VALUES ($1, $2, true, now())
        ON CONFLICT (version) DO UPDATE SET
          manifest = EXCLUDED.manifest,
          published = true,
          published_at = now()
        "#,
    )
    .bind(&manifest.version)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_nonce(
    tx: &mut Transaction<'_, Postgres>,
    scope: &str,
    nonce: Uuid,
    device_id: &str,
    expires_at: OffsetDateTime,
) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM replay_nonces WHERE expires_at < now()")
        .execute(&mut **tx)
        .await?;
    let result = sqlx::query(
        "INSERT INTO replay_nonces (scope, nonce, device_id, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(scope)
    .bind(nonce)
    .bind(device_id)
    .bind(expires_at)
    .execute(&mut **tx)
    .await;
    match result {
        Ok(_) => Ok(()),
        Err(sqlx::Error::Database(error)) if error.is_unique_violation() => Err(StoreError::Replay),
        Err(error) => Err(StoreError::Database(error)),
    }
}

async fn insert_lease(
    tx: &mut Transaction<'_, Postgres>,
    lease_id: Uuid,
    subject_id: Uuid,
    device_id: &str,
    issued_at: OffsetDateTime,
    expires_at: OffsetDateTime,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO leases (id, subject_id, device_id, issued_at, expires_at)
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(lease_id)
    .bind(subject_id)
    .bind(device_id)
    .bind(issued_at)
    .bind(expires_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_audit(
    tx: &mut Transaction<'_, Postgres>,
    subject_id: Option<Uuid>,
    device_id: Option<&str>,
    action: &str,
    outcome: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO audit_events (subject_id, device_id, action, outcome) VALUES ($1, $2, $3, $4)",
    )
    .bind(subject_id)
    .bind(device_id)
    .bind(action)
    .bind(outcome)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
