//! Device identity storage must use the native store for each mobile platform.

#[cfg(target_env = "ohos")]
mod ohos_asset;
#[cfg(not(target_env = "ohos"))]
pub(crate) use keyring::Entry;
#[cfg(target_env = "ohos")]
pub(crate) use ohos_asset::Entry;

#[cfg(target_os = "android")]
pub(crate) fn entry(service: &str, key_id: &str) -> Result<Entry, String> {
    use android_native_keyring_store::Store;
    use keyring_core::api::CredentialStoreApi;
    use std::collections::HashMap;

    // Tauri initializes ndk-context with its application context before IPC.
    // Secrets in this named store are encrypted by an Android Keystore key.
    Store::new_with_configuration(&HashMap::from([("name", service)]))
        .and_then(|store| store.build(service, key_id, None))
        .map(|inner| Entry { inner })
        .map_err(|_| "Unable to access the Android credential store".to_string())
}

#[cfg(target_os = "ios")]
pub(crate) fn entry(service: &str, key_id: &str) -> Result<Entry, String> {
    use apple_native_keyring_store::protected::{AccessPolicy, Cred};

    // Keep this identity on this device and out of iCloud synchronization.
    Cred::build(
        service,
        key_id,
        AccessPolicy::AfterFirstUnlockThisDeviceOnly,
        None,
        false,
    )
    .map(|inner| Entry { inner })
    .map_err(|_| "Unable to access the iOS credential store".to_string())
}

#[cfg(target_env = "ohos")]
pub(crate) fn entry(service: &str, key_id: &str) -> Result<Entry, String> {
    Entry::new(service, key_id)
}

#[cfg(not(any(target_os = "android", target_os = "ios", target_env = "ohos")))]
pub(crate) fn entry(service: &str, key_id: &str) -> Result<Entry, String> {
    Entry::new(service, key_id)
        .map_err(|_| "Unable to access the operating system credential store".to_string())
}
