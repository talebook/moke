pub mod api;
pub mod config;
pub mod crypto;
pub mod error;
pub mod model;
pub mod store;

use config::Config;
use ed25519_dalek::SigningKey;
use sqlx::PgPool;
use std::sync::Arc;
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub lease_signer: Arc<SigningKey>,
    pub lease_public_key: [u8; 32],
    pub access_code_pepper: Arc<Zeroizing<Vec<u8>>>,
    pub artifact_url_key: Arc<Zeroizing<Vec<u8>>>,
    pub admin_token: Arc<Zeroizing<Vec<u8>>>,
    pub public_base_url: url::Url,
    pub artifact_root: std::path::PathBuf,
    pub lease_ttl_seconds: i64,
}

impl AppState {
    pub fn new(pool: PgPool, config: &Config) -> Self {
        let lease_signer = SigningKey::from_bytes(&config.lease_signing_key);
        let lease_public_key = lease_signer.verifying_key().to_bytes();
        Self {
            pool,
            lease_signer: Arc::new(lease_signer),
            lease_public_key,
            access_code_pepper: Arc::new(config.access_code_pepper.clone()),
            artifact_url_key: Arc::new(config.artifact_url_key.clone()),
            admin_token: Arc::new(Zeroizing::new(config.admin_token.as_bytes().to_vec())),
            public_base_url: config.public_base_url.clone(),
            artifact_root: config.artifact_root.clone(),
            lease_ttl_seconds: config.lease_ttl_seconds,
        }
    }
}
