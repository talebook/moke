# Tauri Plugin device-info

[![npm version](https://img.shields.io/npm/v/tauri-plugin-device-info-api.svg)](https://www.npmjs.com/package/tauri-plugin-device-info-api)
[![npm downloads](https://img.shields.io/npm/dm/tauri-plugin-device-info-api.svg)](https://www.npmjs.com/package/tauri-plugin-device-info-api)
[![Crates.io](https://img.shields.io/crates/v/tauri-plugin-device-info.svg)](https://crates.io/crates/tauri-plugin-device-info)
[![Crates.io Downloads](https://img.shields.io/crates/d/tauri-plugin-device-info.svg)](https://crates.io/crates/tauri-plugin-device-info)
[![GitHub stars](https://img.shields.io/github/stars/edisdev/tauri-plugin-device-info?style=social)](https://github.com/edisdev/tauri-plugin-device-info)
[![GitHub forks](https://img.shields.io/github/forks/edisdev/tauri-plugin-device-info?style=social)](https://github.com/edisdev/tauri-plugin-device-info/fork)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/edisdev/tauri-plugin-device-info/actions/workflows/build.yml/badge.svg)](https://github.com/edisdev/tauri-plugin-device-info/actions)

A comprehensive Tauri plugin to access device information including Battery, Network, Storage, Display, and System Details.

---

**📖 [Read the Documentation](https://edisdev.github.io/tauri-plugin-device-info)**

## 📸 Preview

<div>
  <img src="./docs/public/DeviceInfo_Android_Gif.gif" alt="Android Preview GIF" width="250">
  <br>
  <img src="./docs/public/DeviceInfo_Mac.png" alt="macOS Preview" width="400">
  <img src="./docs/public/DeviceInfo_Windows.png" alt="Windows Preview" width="400">
  <br>
  <img src="./docs/public/DeviceInfo_Android.png" alt="Android Preview" width="250">
  <img src="./docs/public/DeviceInfo_iOS.png" alt="iOS Preview" width="250">
  <p><i>Example Dashboard Application across platforms</i></p>
</div>

## Platform Support

| Platform | Support |
| -------- | ------- |
| Windows  | ✅      |
| macOS    | ✅      |
| Linux    | ✅      |
| iOS      | ✅      |
| Android  | ✅      |

## Installation

### Using Tauri CLI (Recommended)

```bash
npm run tauri add device-info
# or
yarn tauri add device-info
```

### Manual Installation

**Cargo.toml:** [![Crates.io](https://img.shields.io/crates/v/tauri-plugin-device-info.svg)](https://crates.io/crates/tauri-plugin-device-info)

```toml
[dependencies]
tauri-plugin-device-info = "1.0"  # Check crates.io for latest version
# or from git
tauri-plugin-device-info = { git = "https://github.com/edisdev/tauri-plugin-device-info" }
```

**package.json:** [![npm version](https://img.shields.io/npm/v/tauri-plugin-device-info-api.svg)](https://www.npmjs.com/package/tauri-plugin-device-info-api)

```json
{
  "dependencies": {
    "tauri-plugin-device-info-api": "^1.0.0"
  }
}
```

## Setup

Register the plugin in your Tauri app:

**src-tauri/src/lib.rs:**

```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_device_info::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## Usage

```typescript
import {
  getDeviceInfo,
  getBatteryInfo,
  getNetworkInfo,
  getStorageInfo,
  getDisplayInfo,
} from "tauri-plugin-device-info-api";

// Get device information
const device = await getDeviceInfo();
console.log(device);
```

**Response:**

```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "manufacturer": "Apple Inc.",
  "model": "MacBookPro16,1",
  "serial": "C02XG2JHJG5H",
  "android_id": null,
  "device_name": "John's MacBook Pro"
}
```

```typescript
// Get battery status
const battery = await getBatteryInfo();
console.log(battery);
```

**Response:**

```json
{
  "level": 85,
  "isCharging": true,
  "health": "Good"
}
```

```typescript
// Get network information
const network = await getNetworkInfo();
console.log(network);
```

**Response:**

```json
{
  "ipAddress": "192.168.x.x",
  "networkType": "wifi",
  "macAddress": "a1:b2:c3:d4:e5:f6"
}
```

```typescript
// Get storage information
const storage = await getStorageInfo();
console.log(storage);
```

**Response:**

```json
{
  "totalSpace": 500107862016,
  "freeSpace": 125026965504,
  "storageType": "SSD"
}
```

```typescript
// Get display information
const display = await getDisplayInfo();
console.log(display);
```

**Response:**

```json
{
  "width": 2560,
  "height": 1600,
  "scaleFactor": 2.0,
  "refreshRate": 120
}
```

## API Reference

### getDeviceInfo()

Returns device identification and hardware information.

| Field          | Type      | Description                                  |
| -------------- | --------- | -------------------------------------------- |
| `uuid`         | `string?` | Unique device identifier                     |
| `manufacturer` | `string?` | Device manufacturer (e.g., "Apple Inc.")     |
| `model`        | `string?` | Device model (e.g., "MacBookPro16,1")        |
| `serial`       | `string?` | Serial number (restricted on some platforms) |
| `android_id`   | `string?` | Android-specific ID (Android only)           |
| `device_name`  | `string?` | User-assigned device name                    |

### getBatteryInfo()

Returns battery status and health information.

| Field        | Type       | Description                    |
| ------------ | ---------- | ------------------------------ |
| `level`      | `number?`  | Battery percentage (0-100)     |
| `isCharging` | `boolean?` | Whether the device is charging |
| `health`     | `string?`  | Battery health status          |

### getNetworkInfo()

Returns network connection details.

| Field         | Type      | Description                                                |
| ------------- | --------- | ---------------------------------------------------------- |
| `ipAddress`   | `string?` | Local IP address                                           |
| `networkType` | `string?` | Connection type: "wifi", "cellular", "ethernet", "unknown" |
| `macAddress`  | `string?` | MAC address (unavailable on iOS/Android due to privacy)    |

### getStorageInfo()

Returns storage capacity information.

| Field         | Type      | Description                            |
| ------------- | --------- | -------------------------------------- |
| `totalSpace`  | `number?` | Total storage in bytes                 |
| `freeSpace`   | `number?` | Available storage in bytes             |
| `storageType` | `string?` | Storage type: "SSD", "HDD", "internal" |

### getDisplayInfo()

Returns display/screen information.

| Field         | Type      | Description                                 |
| ------------- | --------- | ------------------------------------------- |
| `width`       | `number?` | Screen width in pixels                      |
| `height`      | `number?` | Screen height in pixels                     |
| `scaleFactor` | `number?` | Display scale factor (e.g., 2.0 for Retina) |
| `refreshRate` | `number?` | Screen refresh rate in Hz                   |

## TypeScript Types

All types are exported and can be imported:

```typescript
import type {
  DeviceInfoResponse,
  BatteryInfo,
  NetworkInfo,
  StorageInfo,
  DisplayInfo,
} from "tauri-plugin-device-info-api";
```

## Permissions

Add the required permissions in your `capabilities` configuration.

**src-tauri/capabilities/default.json:**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": ["core:default", "device-info:default"]
}
```

### Available Permissions

| Permission                           | Description                       |
| ------------------------------------ | --------------------------------- |
| `device-info:default`                | Enables all device-info commands  |
| `device-info:allow-get-device-info`  | Allows getting device information |
| `device-info:allow-get-battery-info` | Allows getting battery status     |
| `device-info:allow-get-network-info` | Allows getting network details    |
| `device-info:allow-get-storage-info` | Allows getting storage info       |
| `device-info:allow-get-display-info` | Allows getting display info       |

### Individual Permissions Example

If you want to grant only specific permissions:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "device-info:allow-get-battery-info",
    "device-info:allow-get-network-info"
  ]
}
```

## Platform-Specific Notes

### iOS

- MAC address is not available due to Apple's privacy restrictions (returns "unavailable")
- Serial number uses a persistent Keychain-stored UUID

### Android

- MAC address is restricted on Android 6.0+ (returns "restricted")
- Requires no special permissions for basic device info

### macOS

- Uses native CoreGraphics API for accurate refresh rate detection
- Full access to all device information

### Windows

- Uses WMI (Windows Management Instrumentation) for device info
- Full access to all device information

### Linux

- Display refresh rate requires X11 (xrandr)
- Device info read from `/sys/class/dmi/id/`

## License

MIT
