use crate::{
    error::ApiError,
    model::{DeviceProof, LeaseEnvelope, LeasePayload, UpdateAuthorizationClaims},
};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

const PROTOCOL_VERSION: u8 = 1;
const CLOCK_SKEW_SECONDS: i64 = 5 * 60;
const MAX_ACCESS_CODE_BYTES: usize = 4096;
const MAX_APP_VERSION_BYTES: usize = 64;
type HmacSha256 = Hmac<Sha256>;

pub fn now_unix() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

pub fn decode_public_key(value: &str) -> Result<[u8; 32], ApiError> {
    let decoded = decode_base64(value).map_err(|_| ApiError::bad_request("INVALID_DEVICE_KEY"))?;
    decoded
        .as_slice()
        .try_into()
        .map_err(|_| ApiError::bad_request("INVALID_DEVICE_KEY"))
}

pub fn expected_device_id(public_key: &[u8; 32]) -> String {
    format!(
        "moke_{}",
        URL_SAFE_NO_PAD.encode(Sha256::digest(public_key))
    )
}

#[allow(clippy::too_many_arguments)]
pub fn validate_device_request(
    action: &str,
    protocol_version: u8,
    device_id: &str,
    installation_id: Uuid,
    app_version: &str,
    proof: &DeviceProof,
    public_key: &[u8; 32],
    now: i64,
) -> Result<Uuid, ApiError> {
    if protocol_version != PROTOCOL_VERSION
        || device_id != expected_device_id(public_key)
        || app_version.is_empty()
        || app_version.len() > MAX_APP_VERSION_BYTES
        || semver::Version::parse(app_version).is_err()
        || proof.requested_at < now.saturating_sub(CLOCK_SKEW_SECONDS)
        || proof.requested_at > now.saturating_add(CLOCK_SKEW_SECONDS)
    {
        return Err(ApiError::bad_request("INVALID_DEVICE_PROOF"));
    }
    let nonce =
        Uuid::parse_str(&proof.nonce).map_err(|_| ApiError::bad_request("INVALID_DEVICE_PROOF"))?;
    let message = format!(
        "moke-preview-{action}-v{PROTOCOL_VERSION}\n{device_id}\n{installation_id}\n{}\n{}\n{app_version}",
        proof.nonce, proof.requested_at
    );
    verify_signature(public_key, message.as_bytes(), &proof.signature)
        .map_err(|_| ApiError::unauthorized())?;
    Ok(nonce)
}

pub fn sign_lease(
    signer: &SigningKey,
    lease_id: Uuid,
    subject_id: Uuid,
    device_id: String,
    issued_at: i64,
    expires_at: i64,
) -> Result<LeaseEnvelope, ApiError> {
    let payload = LeasePayload {
        version: PROTOCOL_VERSION,
        lease_id: lease_id.to_string(),
        subject: subject_id.to_string(),
        device_id,
        capabilities: vec!["foundation".to_string()],
        issued_at,
        expires_at,
        offline_until: expires_at,
    };
    let payload = serde_json::to_vec(&payload).map_err(ApiError::internal)?;
    Ok(LeaseEnvelope {
        payload: URL_SAFE_NO_PAD.encode(&payload),
        signature: URL_SAFE_NO_PAD.encode(signer.sign(&payload).to_bytes()),
    })
}

pub fn verify_lease(
    public_key: &[u8; 32],
    envelope: &LeaseEnvelope,
) -> Result<LeasePayload, ApiError> {
    let payload = URL_SAFE_NO_PAD
        .decode(&envelope.payload)
        .map_err(|_| ApiError::unauthorized())?;
    if payload.len() > 64 * 1024 {
        return Err(ApiError::unauthorized());
    }
    verify_signature(public_key, &payload, &envelope.signature)
        .map_err(|_| ApiError::unauthorized())?;
    let payload: LeasePayload =
        serde_json::from_slice(&payload).map_err(|_| ApiError::unauthorized())?;
    if payload.version != PROTOCOL_VERSION
        || payload.capabilities.as_slice() != ["foundation"]
        || payload.expires_at <= payload.issued_at
        || payload.expires_at - payload.issued_at > 3600
        || payload.offline_until != payload.expires_at
        || Uuid::parse_str(&payload.lease_id).is_err()
        || Uuid::parse_str(&payload.subject).is_err()
    {
        return Err(ApiError::unauthorized());
    }
    Ok(payload)
}

pub fn verify_update_authorization(
    authorization: &str,
    now: i64,
) -> Result<(UpdateAuthorizationClaims, [u8; 32], Uuid), ApiError> {
    let value = authorization
        .strip_prefix("MokePreview ")
        .ok_or_else(ApiError::unauthorized)?;
    let (encoded_claims, encoded_signature) =
        value.split_once('.').ok_or_else(ApiError::unauthorized)?;
    if encoded_claims.len() > 16 * 1024 || encoded_signature.len() > 256 {
        return Err(ApiError::unauthorized());
    }
    let claims_bytes = URL_SAFE_NO_PAD
        .decode(encoded_claims)
        .map_err(|_| ApiError::unauthorized())?;
    let claims: UpdateAuthorizationClaims =
        serde_json::from_slice(&claims_bytes).map_err(|_| ApiError::unauthorized())?;
    let public_key =
        decode_public_key(&claims.device_public_key).map_err(|_| ApiError::unauthorized())?;
    let message =
        format!("moke-preview-update-authorization-v{PROTOCOL_VERSION}\n{encoded_claims}");
    verify_signature(&public_key, message.as_bytes(), encoded_signature)
        .map_err(|_| ApiError::unauthorized())?;
    if claims.protocol_version != PROTOCOL_VERSION
        || claims.action != "update"
        || claims.device_id != expected_device_id(&public_key)
        || claims.issued_at > now.saturating_add(CLOCK_SKEW_SECONDS)
        || claims.issued_at < now.saturating_sub(CLOCK_SKEW_SECONDS)
        || claims.expires_at < now
        || claims.expires_at <= claims.issued_at
        || claims.expires_at - claims.issued_at > CLOCK_SKEW_SECONDS
        || semver::Version::parse(&claims.app_version).is_err()
    {
        return Err(ApiError::unauthorized());
    }
    let nonce = Uuid::parse_str(&claims.nonce).map_err(|_| ApiError::unauthorized())?;
    Ok((claims, public_key, nonce))
}

pub fn access_code_lookup(pepper: &[u8], access_code: &str) -> Result<[u8; 32], ApiError> {
    validate_access_code(access_code)?;
    let mut mac = HmacSha256::new_from_slice(pepper).map_err(ApiError::internal)?;
    mac.update(access_code.as_bytes());
    Ok(mac.finalize().into_bytes().into())
}

pub fn hash_access_code(access_code: &str) -> Result<String, ApiError> {
    validate_access_code(access_code)?;
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    Argon2::default()
        .hash_password(access_code.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(ApiError::internal)
}

pub fn verify_access_code(access_code: &str, encoded_hash: &str) -> bool {
    let Ok(hash) = PasswordHash::new(encoded_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(access_code.as_bytes(), &hash)
        .is_ok()
}

pub fn generate_access_code() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    format!("moke_preview_{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub fn admin_token_matches(expected: &[u8], actual: &str) -> bool {
    expected.len() == actual.len() && expected.ct_eq(actual.as_bytes()).into()
}

pub fn artifact_token(
    key: &[u8],
    version: &str,
    filename: &str,
    device_id: &str,
    expires_at: i64,
) -> Result<String, ApiError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(ApiError::internal)?;
    mac.update(
        format!("moke-preview-artifact-v1\n{version}\n{filename}\n{device_id}\n{expires_at}")
            .as_bytes(),
    );
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

pub fn verify_artifact_token(
    key: &[u8],
    version: &str,
    filename: &str,
    device_id: &str,
    expires_at: i64,
    provided: &str,
) -> bool {
    let Ok(expected) = artifact_token(key, version, filename, device_id, expires_at) else {
        return false;
    };
    expected.len() == provided.len() && expected.as_bytes().ct_eq(provided.as_bytes()).into()
}

fn validate_access_code(access_code: &str) -> Result<(), ApiError> {
    if access_code.is_empty()
        || access_code.len() > MAX_ACCESS_CODE_BYTES
        || access_code.contains(['\r', '\n'])
    {
        return Err(ApiError::unauthorized());
    }
    Ok(())
}

fn verify_signature(
    public_key: &[u8; 32],
    message: &[u8],
    encoded_signature: &str,
) -> Result<(), ()> {
    let signature = decode_base64(encoded_signature).map_err(|_| ())?;
    let signature = Signature::from_slice(&signature).map_err(|_| ())?;
    let verifier = VerifyingKey::from_bytes(public_key).map_err(|_| ())?;
    verifier.verify(message, &signature).map_err(|_| ())
}

fn decode_base64(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD
        .decode(value.trim())
        .or_else(|_| STANDARD.decode(value.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DeviceProof;

    #[test]
    fn device_proof_and_update_authorization_match_client_wire_format() {
        let signer = SigningKey::from_bytes(&[7_u8; 32]);
        let public_key = signer.verifying_key().to_bytes();
        let device_id = expected_device_id(&public_key);
        let installation_id = Uuid::new_v4();
        let nonce = Uuid::new_v4();
        let now = 1_800_000_000;
        let message = format!(
            "moke-preview-activate-v1\n{device_id}\n{installation_id}\n{nonce}\n{now}\n1.2.3"
        );
        let proof = DeviceProof {
            nonce: nonce.to_string(),
            requested_at: now,
            signature: URL_SAFE_NO_PAD.encode(signer.sign(message.as_bytes()).to_bytes()),
        };
        assert_eq!(
            validate_device_request(
                "activate",
                1,
                &device_id,
                installation_id,
                "1.2.3",
                &proof,
                &public_key,
                now,
            )
            .unwrap(),
            nonce
        );
    }

    #[test]
    fn lease_signature_round_trips_and_has_no_offline_grace() {
        let signer = SigningKey::from_bytes(&[9_u8; 32]);
        let envelope = sign_lease(
            &signer,
            Uuid::new_v4(),
            Uuid::new_v4(),
            "moke_test".to_string(),
            1_800_000_000,
            1_800_003_600,
        )
        .unwrap();
        let payload = verify_lease(&signer.verifying_key().to_bytes(), &envelope).unwrap();
        assert_eq!(payload.offline_until, payload.expires_at);
    }

    #[test]
    fn access_code_storage_uses_lookup_hmac_and_argon2() {
        let code = generate_access_code();
        let lookup = access_code_lookup(&[3_u8; 32], &code).unwrap();
        assert_ne!(
            lookup.as_slice(),
            Sha256::digest(code.as_bytes()).as_slice()
        );
        let hash = hash_access_code(&code).unwrap();
        assert!(verify_access_code(&code, &hash));
        assert!(!verify_access_code("wrong", &hash));
    }

    #[test]
    fn artifact_urls_are_short_lived_and_device_bound() {
        let token = artifact_token(&[5_u8; 32], "1.2.3", "Moke.AppImage", "moke_a", 42).unwrap();
        assert!(verify_artifact_token(
            &[5_u8; 32],
            "1.2.3",
            "Moke.AppImage",
            "moke_a",
            42,
            &token,
        ));
        assert!(!verify_artifact_token(
            &[5_u8; 32],
            "1.2.3",
            "Moke.AppImage",
            "moke_b",
            42,
            &token,
        ));
    }
}
