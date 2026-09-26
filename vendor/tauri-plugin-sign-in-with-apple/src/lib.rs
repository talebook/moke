use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(any(desktop, target_env = "ohos"))]
mod desktop;
#[cfg(all(mobile, not(target_env = "ohos")))]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(any(desktop, target_env = "ohos"))]
use desktop::SignInWithApple;
#[cfg(all(mobile, not(target_env = "ohos")))]
use mobile::SignInWithApple;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the sign-in-with-apple APIs.
pub trait SignInWithAppleExt<R: Runtime> {
  fn sign_in_with_apple(&self) -> &SignInWithApple<R>;
}

impl<R: Runtime, T: Manager<R>> crate::SignInWithAppleExt<R> for T {
  fn sign_in_with_apple(&self) -> &SignInWithApple<R> {
    self.state::<SignInWithApple<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("sign-in-with-apple")
    .invoke_handler(tauri::generate_handler![commands::get_apple_id_credential])
    .setup(|app, api| {
      #[cfg(all(mobile, not(target_env = "ohos")))]
      let sign_in_with_apple = mobile::init(app, api)?;
      #[cfg(any(desktop, target_env = "ohos"))]
      let sign_in_with_apple = desktop::init(app, api)?;
      app.manage(sign_in_with_apple);
      Ok(())
    })
    .build()
}
