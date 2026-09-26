// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

#![cfg(mobile)]

use std::marker::PhantomData;

use serde::Serialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};
#[cfg(not(target_env = "ohos"))]
use tauri::plugin::PluginHandle;

pub use models::*;

mod error;
mod models;

pub use error::{Error, Result};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "app.tauri.biometric";

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_biometric);

/// Access to the biometric APIs.
pub struct Biometric<R: Runtime>(
    #[cfg(not(target_env = "ohos"))] PluginHandle<R>,
    #[cfg(target_env = "ohos")] PhantomData<fn() -> R>,
);

#[derive(Serialize)]
struct AuthenticatePayload {
    reason: String,
    #[serde(flatten)]
    options: AuthOptions,
}

impl<R: Runtime> Biometric<R> {
    pub fn status(&self) -> crate::Result<Status> {
        #[cfg(target_env = "ohos")]
        return Ok(Status {
            is_available: false,
            biometry_type: BiometryType::None,
            error: Some("Biometric authentication is not supported on OpenHarmony".into()),
            error_code: Some("unsupported_platform".into()),
        });

        #[cfg(not(target_env = "ohos"))]
        self.0.run_mobile_plugin("status", ()).map_err(Into::into)
    }

    pub fn authenticate(&self, reason: String, options: AuthOptions) -> crate::Result<()> {
        #[cfg(target_env = "ohos")]
        {
            let _ = (reason, options);
            return Err(crate::Error::UnsupportedPlatform);
        }

        #[cfg(not(target_env = "ohos"))]
        self.0
            .run_mobile_plugin("authenticate", AuthenticatePayload { reason, options })
            .map_err(Into::into)
    }
}

/// Extensions to [`tauri::App`], [`tauri::AppHandle`], [`tauri::WebviewWindow`], [`tauri::Webview`] and [`tauri::Window`] to access the biometric APIs.
pub trait BiometricExt<R: Runtime> {
    fn biometric(&self) -> &Biometric<R>;
}

impl<R: Runtime, T: Manager<R>> crate::BiometricExt<R> for T {
    fn biometric(&self) -> &Biometric<R> {
        self.state::<Biometric<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("biometric")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "BiometricPlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_biometric)?;
            #[cfg(not(target_env = "ohos"))]
            let biometric = Biometric(handle);
            #[cfg(target_env = "ohos")]
            let biometric: Biometric<R> = {
                let _ = api;
                Biometric(PhantomData)
            };
            app.manage(biometric);
            Ok(())
        })
        .build()
}
