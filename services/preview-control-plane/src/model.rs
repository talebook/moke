use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceProof {
    pub nonce: String,
    pub requested_at: i64,
    pub signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivationRequest {
    pub protocol_version: u8,
    pub device_id: String,
    pub device_public_key: String,
    pub installation_id: Uuid,
    pub app_version: String,
    pub proof: DeviceProof,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshRequest {
    pub protocol_version: u8,
    pub device_id: String,
    pub installation_id: Uuid,
    pub app_version: String,
    pub lease: LeaseEnvelope,
    pub proof: DeviceProof,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeaseEnvelope {
    pub payload: String,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeasePayload {
    pub version: u8,
    pub lease_id: String,
    pub subject: String,
    pub device_id: String,
    pub capabilities: Vec<String>,
    pub issued_at: i64,
    pub expires_at: i64,
    pub offline_until: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateAuthorizationClaims {
    pub protocol_version: u8,
    pub action: String,
    pub device_id: String,
    pub device_public_key: String,
    pub installation_id: Uuid,
    pub app_version: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub nonce: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateGrantRequest {
    pub label: String,
    pub device_limit: i32,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGrantResponse {
    pub subject_id: Uuid,
    pub access_code: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePlatform {
    pub signature: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct UpdateManifest {
    pub version: String,
    pub notes: String,
    pub pub_date: String,
    pub platforms: BTreeMap<String, UpdatePlatform>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub protocol_version: u8,
    pub lease_public_key: String,
}

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
}
