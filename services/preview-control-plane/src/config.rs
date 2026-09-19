use anyhow::{anyhow, bail, Context};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use std::{env, net::SocketAddr, path::PathBuf};
use url::Url;
use zeroize::Zeroizing;

pub struct Config {
    pub database_host: String,
    pub database_port: u16,
    pub database_name: String,
    pub database_user: String,
    pub database_password: Zeroizing<String>,
    pub database_max_connections: u32,
    pub bind_address: SocketAddr,
    pub public_base_url: Url,
    pub lease_signing_key: [u8; 32],
    pub access_code_pepper: Zeroizing<Vec<u8>>,
    pub artifact_url_key: Zeroizing<Vec<u8>>,
    pub admin_token: Zeroizing<String>,
    pub artifact_root: PathBuf,
    pub lease_ttl_seconds: i64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_host = required("DATABASE_HOST")?;
        let database_port = parse_bounded_u16("DATABASE_PORT", 5432, 1, u16::MAX)?;
        let database_name = bounded_required("DATABASE_NAME", 128)?;
        let database_user = bounded_required("DATABASE_USER", 128)?;
        let database_password = Zeroizing::new(bounded_required("DATABASE_PASSWORD", 4096)?);
        let bind_address = env::var("BIND_ADDRESS")
            .unwrap_or_else(|_| "0.0.0.0:8080".to_string())
            .parse()
            .context("BIND_ADDRESS must be a socket address")?;
        let database_max_connections = parse_bounded_u32("DATABASE_MAX_CONNECTIONS", 10, 1, 64)?;
        let lease_ttl_seconds = parse_bounded_i64("LEASE_TTL_SECONDS", 3600, 300, 3600)?;
        let public_base_url = validate_public_base_url(&required("PUBLIC_BASE_URL")?)?;

        let lease_key = decode_secret(
            "PREVIEW_LEASE_SIGNING_KEY",
            &required("PREVIEW_LEASE_SIGNING_KEY")?,
        )?;
        let lease_signing_key: [u8; 32] = lease_key
            .as_slice()
            .try_into()
            .map_err(|_| anyhow!("PREVIEW_LEASE_SIGNING_KEY must decode to exactly 32 bytes"))?;
        let access_code_pepper = decode_secret(
            "PREVIEW_ACCESS_CODE_PEPPER",
            &required("PREVIEW_ACCESS_CODE_PEPPER")?,
        )?;
        if access_code_pepper.len() < 32 {
            bail!("PREVIEW_ACCESS_CODE_PEPPER must decode to at least 32 bytes");
        }
        let artifact_url_key = decode_secret(
            "PREVIEW_ARTIFACT_URL_KEY",
            &required("PREVIEW_ARTIFACT_URL_KEY")?,
        )?;
        if artifact_url_key.len() < 32 {
            bail!("PREVIEW_ARTIFACT_URL_KEY must decode to at least 32 bytes");
        }
        let admin_token = Zeroizing::new(required("PREVIEW_ADMIN_TOKEN")?);
        if admin_token.len() < 32 || admin_token.len() > 4096 {
            bail!("PREVIEW_ADMIN_TOKEN must contain 32 to 4096 bytes");
        }
        let artifact_root = PathBuf::from(
            env::var("ARTIFACT_ROOT").unwrap_or_else(|_| "/srv/artifacts".to_string()),
        );
        if !artifact_root.is_absolute() {
            bail!("ARTIFACT_ROOT must be an absolute path");
        }

        Ok(Self {
            database_host,
            database_port,
            database_name,
            database_user,
            database_password,
            database_max_connections,
            bind_address,
            public_base_url,
            lease_signing_key,
            access_code_pepper,
            artifact_url_key,
            admin_token,
            artifact_root,
            lease_ttl_seconds,
        })
    }
}

fn required(name: &str) -> anyhow::Result<String> {
    let value = env::var(name).with_context(|| format!("{name} is required"))?;
    if value.trim().is_empty() {
        bail!("{name} must not be empty");
    }
    Ok(value)
}

fn bounded_required(name: &str, max_bytes: usize) -> anyhow::Result<String> {
    let value = required(name)?;
    if value.len() > max_bytes || value.contains('\0') {
        bail!("{name} is too long or contains an invalid character");
    }
    Ok(value)
}

fn parse_bounded_u16(name: &str, default: u16, min: u16, max: u16) -> anyhow::Result<u16> {
    let value = match env::var(name) {
        Ok(value) => value
            .parse()
            .with_context(|| format!("{name} must be an integer"))?,
        Err(env::VarError::NotPresent) => default,
        Err(error) => return Err(error).with_context(|| format!("read {name}")),
    };
    if !(min..=max).contains(&value) {
        bail!("{name} must be between {min} and {max}");
    }
    Ok(value)
}

fn decode_secret(name: &str, value: &str) -> anyhow::Result<Zeroizing<Vec<u8>>> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value.trim())
        .or_else(|_| STANDARD.decode(value.trim()))
        .with_context(|| format!("{name} must be base64 or unpadded base64url"))?;
    Ok(Zeroizing::new(decoded))
}

fn parse_bounded_u32(name: &str, default: u32, min: u32, max: u32) -> anyhow::Result<u32> {
    let value = match env::var(name) {
        Ok(value) => value
            .parse()
            .with_context(|| format!("{name} must be an integer"))?,
        Err(env::VarError::NotPresent) => default,
        Err(error) => return Err(error).with_context(|| format!("read {name}")),
    };
    if !(min..=max).contains(&value) {
        bail!("{name} must be between {min} and {max}");
    }
    Ok(value)
}

fn parse_bounded_i64(name: &str, default: i64, min: i64, max: i64) -> anyhow::Result<i64> {
    let value = match env::var(name) {
        Ok(value) => value
            .parse()
            .with_context(|| format!("{name} must be an integer"))?,
        Err(env::VarError::NotPresent) => default,
        Err(error) => return Err(error).with_context(|| format!("read {name}")),
    };
    if !(min..=max).contains(&value) {
        bail!("{name} must be between {min} and {max}");
    }
    Ok(value)
}

fn validate_public_base_url(value: &str) -> anyhow::Result<Url> {
    let mut url = Url::parse(value).context("PUBLIC_BASE_URL must be an absolute URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("PUBLIC_BASE_URL must be an HTTPS origin or path without credentials/query/fragment");
    }
    if !url.path().ends_with('/') {
        let next = format!("{}/", url.path());
        url.set_path(&next);
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_base_url_is_https_and_normalized() {
        assert_eq!(
            validate_public_base_url("https://preview.example.test/control")
                .unwrap()
                .as_str(),
            "https://preview.example.test/control/"
        );
        for invalid in [
            "http://preview.example.test",
            "https://user@preview.example.test",
            "https://preview.example.test?token=x",
        ] {
            assert!(validate_public_base_url(invalid).is_err(), "{invalid}");
        }
    }
}
