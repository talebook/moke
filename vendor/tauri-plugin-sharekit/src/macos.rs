use serde::de::DeserializeOwned;
use tauri::WebviewWindow;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

use objc2::{rc::Retained, runtime::AnyObject, AnyThread};
use objc2_app_kit::{NSSharingServicePicker, NSView};
use objc2_core_foundation::{CGPoint, CGSize};
use objc2_foundation::{NSArray, NSRect, NSRectEdge, NSString, NSURL};

impl From<RectEdge> for NSRectEdge {
    fn from(edge: RectEdge) -> Self {
        match edge {
            RectEdge::Top => NSRectEdge::NSMaxYEdge,
            RectEdge::Bottom => NSRectEdge::NSMinYEdge,
            RectEdge::Left => NSRectEdge::NSMinXEdge,
            RectEdge::Right => NSRectEdge::NSMaxXEdge,
        }
    }
}

fn position_to_rect(position: Option<&SharePosition>) -> (f64, f64, NSRectEdge) {
    position
        .map(|pos| {
            let edge = pos
                .preferred_edge
                .map(Into::into)
                .unwrap_or(NSRectEdge::NSMinYEdge);
            (pos.x, pos.y, edge)
        })
        .unwrap_or((0.0, 0.0, NSRectEdge::NSMinYEdge))
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<ShareKit<R>> {
    Ok(ShareKit(app.clone()))
}

/// Access to the share APIs.
pub struct ShareKit<R: Runtime>(AppHandle<R>);

impl<R: Runtime> ShareKit<R> {
    pub fn share_text(
        &self,
        window: WebviewWindow<R>,
        text: String,
        options: ShareTextOptions,
    ) -> crate::Result<()> {
        window
            .with_webview(move |webview| {
                // Get the WKWebView as NSView
                let ns_view: &NSView = unsafe { &*(webview.inner() as *const NSView) };

                let mut items: Vec<Retained<AnyObject>> = Vec::new();
                let ns_string = NSString::from_str(&text);
                items.push(unsafe { Retained::cast_unchecked(ns_string) });

                let items_array = NSArray::from_retained_slice(&items);

                let (x, y, edge) = position_to_rect(options.position.as_ref());

                let rect = NSRect::new(CGPoint::new(x, y), CGSize::new(1.0, 1.0));
                let picker = unsafe {
                    NSSharingServicePicker::initWithItems(
                        NSSharingServicePicker::alloc(),
                        &items_array,
                    )
                };

                picker.showRelativeToRect_ofView_preferredEdge(rect, ns_view, edge);
            })
            .map_err(|_| crate::Error::WindowNotFound)?;

        Ok(())
    }

    pub fn share_file(
        &self,
        window: WebviewWindow<R>,
        url: String,
        options: ShareFileOptions,
    ) -> crate::Result<()> {
        window
            .with_webview(move |webview| {
                // Get the WKWebView as NSView
                let ns_view: &NSView = unsafe { &*(webview.inner() as *const NSView) };

                let mut items: Vec<Retained<AnyObject>> = Vec::new();
                let ns_url = NSURL::fileURLWithPath(&NSString::from_str(&url));
                items.push(unsafe { Retained::cast_unchecked(ns_url) });

                let items_array = NSArray::from_retained_slice(&items);

                let (x, y, edge) = position_to_rect(options.position.as_ref());

                let rect = NSRect::new(CGPoint::new(x, y), CGSize::new(1.0, 1.0));
                let picker = unsafe {
                    NSSharingServicePicker::initWithItems(
                        NSSharingServicePicker::alloc(),
                        &items_array,
                    )
                };

                picker.showRelativeToRect_ofView_preferredEdge(rect, ns_view, edge);
            })
            .map_err(|_| crate::Error::WindowNotFound)?;

        Ok(())
    }
}
