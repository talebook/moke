use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime, WebviewWindow};

use crate::models::*;
use crate::Error;

use std::sync::mpsc;

use windows::{
    core::{Interface, HSTRING},
    ApplicationModel::DataTransfer::{DataRequestedEventArgs, DataTransferManager},
    Foundation::TypedEventHandler,
    Storage::{IStorageItem, StorageFile},
    Win32::{
        System::WinRT::{RoGetActivationFactory, RoInitialize, RO_INIT_SINGLETHREADED},
        UI::Shell::IDataTransferManagerInterop,
    },
};
use windows_collections::IIterable;

impl From<windows::core::Error> for Error {
    fn from(err: windows::core::Error) -> Self {
        Error::WindowsApi(err.to_string())
    }
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<ShareKit<R>> {
    Ok(ShareKit::new(app.clone()))
}

/// Access to the share APIs.
pub struct ShareKit<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> ShareKit<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        // Initialize Windows Runtime if needed
        unsafe {
            let _ = RoInitialize(RO_INIT_SINGLETHREADED);
        }

        Self { app }
    }

    /// Opens the native share UI to share text content.
    pub fn share_text(
        &self,
        window: WebviewWindow<R>,
        text: String,
        _options: ShareTextOptions,
    ) -> crate::Result<()> {
        // Get the window handle from Tauri
        let hwnd = window
            .hwnd()
            .map_err(|e| crate::Error::WindowsApi(e.to_string()))?;

        // Get DataTransferManager bound to our window
        let class = HSTRING::from("Windows.ApplicationModel.DataTransfer.DataTransferManager");
        let interop: IDataTransferManagerInterop = unsafe { RoGetActivationFactory(&class)? };
        let dtm: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };

        // setup_tx: signals when data preparation is done (with success/error)
        // complete_tx: signals when user completes or cancels the share
        let (setup_tx, setup_rx) = mpsc::channel::<Result<(), String>>();
        let (complete_tx, complete_rx) = mpsc::channel::<bool>();

        // Set up the DataRequested handler
        let content = HSTRING::from(text);
        let app_name = HSTRING::from(self.app.package_info().name.clone());
        let handler: TypedEventHandler<DataTransferManager, DataRequestedEventArgs> =
            TypedEventHandler::new(
                move |_, args: windows::core::Ref<'_, DataRequestedEventArgs>| {
                    let result = (|| -> windows::core::Result<()> {
                        if let Some(args) = args.as_ref() {
                            let data = args.Request()?.Data()?;
                            let props = data.Properties()?;
                            props.SetTitle(&app_name)?;
                            props.SetDescription(&content)?;
                            data.SetText(&content)?;

                            // Set up ShareCompleted handler
                            let tx_completed = complete_tx.clone();
                            data.ShareCompleted(&TypedEventHandler::new(move |_, _| {
                                let _ = tx_completed.send(true);
                                Ok(())
                            }))?;

                            // Set up ShareCanceled handler
                            let tx_canceled = complete_tx.clone();
                            data.ShareCanceled(&TypedEventHandler::new(move |_, _| {
                                let _ = tx_canceled.send(false);
                                Ok(())
                            }))?;
                        }
                        Ok(())
                    })();
                    let _ = setup_tx.send(result.map_err(|e| e.to_string()));
                    Ok(())
                },
            );
        let token = dtm.DataRequested(&handler)?;

        // Show the native share UI
        unsafe {
            interop.ShowShareUIForWindow(hwnd)?;
        }

        // Wait for data preparation to complete
        let setup_result = setup_rx
            .recv()
            .map_err(|e| Error::WindowsApi(e.to_string()))
            .and_then(|r| r.map_err(Error::WindowsApi));

        if let Err(e) = setup_result {
            let _ = dtm.RemoveDataRequested(token);
            return Err(e);
        }

        // Wait for user to complete or cancel the share
        let completed = complete_rx
            .recv()
            .map_err(|e| Error::WindowsApi(e.to_string()))?;
        let _ = dtm.RemoveDataRequested(token);

        if completed {
            Ok(())
        } else {
            Err(Error::WindowsApi("Share cancelled".to_string()))
        }
    }

    /// Opens the native share UI to share a file.
    pub fn share_file(
        &self,
        window: WebviewWindow<R>,
        url: String,
        options: ShareFileOptions,
    ) -> crate::Result<()> {
        // Get the window handle from Tauri
        let hwnd = window
            .hwnd()
            .map_err(|e| crate::Error::WindowsApi(e.to_string()))?;

        // Get IDataTransferManagerInterop factory
        let class = HSTRING::from("Windows.ApplicationModel.DataTransfer.DataTransferManager");
        let interop: IDataTransferManagerInterop = unsafe { RoGetActivationFactory(&class)? };

        // Get DataTransferManager bound to our HWND
        let dtm: DataTransferManager = unsafe { interop.GetForWindow(hwnd)? };

        // Create channels for signaling
        let (setup_tx, setup_rx) = mpsc::channel::<Result<(), String>>();
        let (complete_tx, complete_rx) = mpsc::channel::<bool>(); // true = completed, false = cancelled

        // Set up the DataRequested handler
        let path = HSTRING::from(url);
        let app_name = self.app.package_info().name.clone();
        let handler: TypedEventHandler<DataTransferManager, DataRequestedEventArgs> =
            TypedEventHandler::new(
                move |_, args: windows::core::Ref<'_, DataRequestedEventArgs>| {
                    let result = (|| -> windows::core::Result<()> {
                        let args = args.as_ref();
                        if let Some(args) = args {
                            let request = args.Request()?;
                            let data = request.Data()?;

                            // Title and Description are required for Windows share to work properly
                            let title = options.title.as_deref().unwrap_or(&app_name);
                            let props = data.Properties()?;
                            props.SetTitle(&HSTRING::from(title))?;
                            props.SetDescription(&HSTRING::from(title))?;

                            // Convert path -> StorageFile
                            let file = StorageFile::GetFileFromPathAsync(&path)?.get()?;

                            let storage_item = file.cast::<IStorageItem>()?;
                            let storage_items: IIterable<IStorageItem> =
                                vec![Some(storage_item)].into();

                            data.SetStorageItemsReadOnly(&storage_items)?;

                            // Set up ShareCompleted handler
                            let tx_completed = complete_tx.clone();
                            data.ShareCompleted(&TypedEventHandler::new(move |_, _| {
                                let _ = tx_completed.send(true);
                                Ok(())
                            }))?;

                            // Set up ShareCanceled handler
                            let tx_canceled = complete_tx.clone();
                            data.ShareCanceled(&TypedEventHandler::new(move |_, _| {
                                let _ = tx_canceled.send(false);
                                Ok(())
                            }))?;
                        }
                        Ok(())
                    })();

                    // Signal setup completion with result
                    let _ = setup_tx.send(result.map_err(|e| e.to_string()));

                    Ok(())
                },
            );
        let token = dtm.DataRequested(&handler)?;

        // Show the Share UI for this window
        unsafe {
            interop.ShowShareUIForWindow(hwnd)?;
        }

        // Wait for setup to complete and check for errors
        let setup_result = setup_rx
            .recv()
            .map_err(|e| Error::WindowsApi(e.to_string()))
            .and_then(|r| r.map_err(Error::WindowsApi));

        if let Err(e) = setup_result {
            let _ = dtm.RemoveDataRequested(token);
            return Err(e);
        }

        // Wait for share to complete or be cancelled
        let completed = complete_rx
            .recv()
            .map_err(|e| Error::WindowsApi(e.to_string()))?;
        let _ = dtm.RemoveDataRequested(token);

        if completed {
            Ok(())
        } else {
            Err(Error::WindowsApi("Share cancelled".to_string()))
        }
    }
}
