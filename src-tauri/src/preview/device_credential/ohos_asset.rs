//! OpenHarmony Asset Store (API 11+) keeps small secrets encrypted and app-scoped.
//! Device identities are never synchronized or retained after app uninstall.

use std::{ptr, slice, str};

const SECRET: u32 = 0x3000_0001;
const ALIAS: u32 = 0x3000_0002;
const ACCESSIBILITY: u32 = 0x2000_0003;
const SYNC_TYPE: u32 = 0x2000_0010;
const RETURN_TYPE: u32 = 0x2000_0040;
const MAX_SECRET_BYTES: usize = 1024;

// ABI definitions from the SDK's asset/asset_type.h.
#[repr(C)]
#[derive(Clone, Copy)]
struct Blob {
    size: u32,
    data: *mut u8,
}

#[repr(C)]
union Value {
    number: u32,
    blob: Blob,
}

#[repr(C)]
struct Attr {
    tag: u32,
    value: Value,
}

impl Attr {
    fn bytes(tag: u32, bytes: &[u8]) -> Self {
        Self {
            tag,
            value: Value {
                blob: Blob {
                    size: bytes.len() as u32,
                    data: bytes.as_ptr().cast_mut(),
                },
            },
        }
    }

    fn number(tag: u32, number: u32) -> Self {
        Self {
            tag,
            value: Value { number },
        }
    }
}

#[repr(C)]
struct AssetResult {
    count: u32,
    attrs: *mut Attr,
}

#[repr(C)]
struct ResultSet {
    count: u32,
    results: *mut AssetResult,
}

#[link(name = "asset_ndk.z")]
extern "C" {
    fn OH_Asset_Add(attrs: *const Attr, count: u32) -> i32;
    fn OH_Asset_Query(attrs: *const Attr, count: u32, results: *mut ResultSet) -> i32;
    fn OH_Asset_Remove(attrs: *const Attr, count: u32) -> i32;
    fn OH_Asset_ParseAttr(result: *const AssetResult, tag: u32) -> *mut Attr;
    fn OH_Asset_FreeResultSet(results: *mut ResultSet);
}

impl Drop for ResultSet {
    fn drop(&mut self) {
        if !self.results.is_null() {
            // SAFETY: Only OH_Asset_Query allocates this SDK-owned result set.
            unsafe { OH_Asset_FreeResultSet(self) };
        }
    }
}

fn check(code: i32) -> Result<(), String> {
    if code == 0 {
        Ok(())
    } else {
        Err(format!("OHOS credential store error ({code})"))
    }
}

pub(crate) struct Entry {
    alias: Vec<u8>,
}

impl Entry {
    pub(crate) fn new(service: &str, key_id: &str) -> Result<Self, String> {
        let alias = format!("{service}:{key_id}").into_bytes();
        if service.is_empty() || key_id.is_empty() || alias.len() > 256 {
            return Err("Invalid OHOS credential alias".into());
        }
        Ok(Self { alias })
    }

    pub(crate) fn set_password(&self, password: &str) -> Result<(), String> {
        if password.is_empty() || password.len() > MAX_SECRET_BYTES {
            return Err("Invalid OHOS credential size".into());
        }
        let attrs = [
            Attr::bytes(ALIAS, &self.alias),
            Attr::bytes(SECRET, password.as_bytes()),
            Attr::number(ACCESSIBILITY, 1), // After the first device unlock.
            Attr::number(SYNC_TYPE, 0),     // Never sync or clone to another device.
        ];
        // SAFETY: Input buffers remain alive for this synchronous SDK call.
        check(unsafe { OH_Asset_Add(attrs.as_ptr(), attrs.len() as u32) })
    }

    pub(crate) fn get_password(&self) -> Result<String, String> {
        let query = [
            Attr::bytes(ALIAS, &self.alias),
            Attr::number(RETURN_TYPE, 0),
        ];
        let mut results = ResultSet {
            count: 0,
            results: ptr::null_mut(),
        };
        // SAFETY: All query buffers and the initialized output remain alive.
        check(unsafe { OH_Asset_Query(query.as_ptr(), query.len() as u32, &mut results) })?;
        if results.count != 1 || results.results.is_null() {
            return Err("OHOS device credential is missing or ambiguous".into());
        }
        // SAFETY: The SDK returned one result; it remains allocated until Drop.
        let secret = unsafe { OH_Asset_ParseAttr(results.results, SECRET) };
        if secret.is_null() {
            return Err("OHOS device credential has no secret".into());
        }
        // SAFETY: SECRET is a byte-array tag in the SDK's tagged union.
        let blob = unsafe { (*secret).value.blob };
        if blob.data.is_null() || blob.size == 0 || blob.size as usize > MAX_SECRET_BYTES {
            return Err("OHOS device credential has an invalid secret".into());
        }
        // SAFETY: The SDK owns blob.size readable bytes until results is freed.
        let bytes = unsafe { slice::from_raw_parts(blob.data, blob.size as usize) };
        str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| "OHOS device credential is invalid UTF-8".to_string())
    }

    pub(crate) fn delete_credential(&self) -> Result<(), String> {
        let query = [Attr::bytes(ALIAS, &self.alias)];
        // SAFETY: The alias buffer remains alive for this synchronous call.
        check(unsafe { OH_Asset_Remove(query.as_ptr(), query.len() as u32) })
    }
}
