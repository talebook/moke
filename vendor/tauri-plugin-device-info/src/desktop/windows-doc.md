# 🪟 Windows Device Info - Detailed Documentation

## 📋 Overview

Collects device information for Windows platform using **WMI (Windows Management Instrumentation)**. WMI is Windows' native management API that provides SQL-like query access to system information.

## 🏗️ Architecture

### Technologies Used:
- **WMI**: Windows Management Instrumentation
- **COM**: Component Object Model (underlying infrastructure for WMI)
- **wmi crate**: Rust wrapper for WMI operations
- **serde**: JSON deserialization

## 🔄 Process Flow

### 1. Dependencies
```rust
use serde::Deserialize;
use wmi::{COMLibrary, WMIConnection};
use crate::models::DeviceInfoResponse;
```

**Explanation:**
- **wmi crate**: Rust interface to Windows WMI API
- **COMLibrary**: COM system initialization
- **WMIConnection**: Execute WMI queries
- **serde::Deserialize**: Convert WMI results to structs

### 2. Data Structures

#### Win32ComputerSystem
```rust
#[derive(Deserialize, Debug)]
struct Win32ComputerSystem {
    #[serde(rename = "Manufacturer")]
    manufacturer: Option<String>,
    #[serde(rename = "Model")]
    model: Option<String>,
    #[serde(rename = "Name")]
    name: Option<String>, // hostname
}
```

**WMI Table**: `Win32_ComputerSystem`
**Purpose**: General information about the computer system

**Field Descriptions:**
- **Manufacturer**: Manufacturer company (Dell, HP, ASUS, etc.)
- **Model**: Computer model (OptiPlex 7090, ThinkPad X1, etc.)
- **Name**: Computer hostname (Windows computer name)

#### Win32ComputerSystemProduct
```rust
#[derive(Deserialize, Debug)]
struct Win32ComputerSystemProduct {
    #[serde(rename = "UUID")]
    uuid: Option<String>,
    #[serde(rename = "IdentifyingNumber")]
    identifying_number: Option<String>, // serial may be here
}
```

**WMI Table**: `Win32_ComputerSystemProduct`
**Purpose**: System product information and UUID

**Field Descriptions:**
- **UUID**: Hardware unique identifier (Hardware UUID)
- **IdentifyingNumber**: Alternative serial number (from some manufacturers)

#### Win32BIOS
```rust
#[derive(Deserialize, Debug)]
struct Win32BIOS {
    #[serde(rename = "SerialNumber")]
    serial: Option<String>,
}
```

**WMI Table**: `Win32_BIOS`
**Purpose**: BIOS/UEFI information

**Field Descriptions:**
- **SerialNumber**: Motherboard/system serial number

### 3. WMI Connection Setup
```rust
let com_lib = COMLibrary::new().ok()?;
let wmi_connection = WMIConnection::new(com_lib.into()).ok()?;
```

**COM Library Initialization:**
- WMI is built on COM (Component Object Model)
- `COMLibrary::new()` initializes the COM system
- Required for thread-safe COM usage

### 4. WMI Queries
```rust
let computer_systems: Vec<Win32ComputerSystem> =
    wmi_connection.raw_query("SELECT Manufacturer, Model, Name FROM Win32_ComputerSystem").ok()?;
let system_products: Vec<Win32ComputerSystemProduct> =
    wmi_connection.raw_query("SELECT UUID, IdentifyingNumber FROM Win32_ComputerSystemProduct").ok()?;
let bios_data: Vec<Win32BIOS> =
    wmi_connection.raw_query("SELECT SerialNumber FROM Win32_BIOS").ok()?;
```

**WQL Queries:**
- **WQL**: WMI Query Language (SQL-like)
- **SELECT** statements fetch specific fields
- Returns **Vec<>** because WMI can return multiple instances

### 5. Data Extraction
```rust
let system_info = computer_systems.get(0);
let product_info = system_products.get(0);
let bios_info = bios_data.get(0);
```

**Why First Element:**
- Most systems have a single computer instance
- `get(0)` retrieves the first (usually only) record
- Returns `Option<>` for safe access

### 6. Response Building
```rust
Some(DeviceInfoResponse {
    device_name: system_info.and_then(|s| s.name.clone()),
    manufacturer: system_info.and_then(|s| s.manufacturer.clone()),
    model: system_info.and_then(|s| s.model.clone()),
    uuid: product_info.and_then(|p| p.uuid.clone()),
    // prefer BIOS serial, fallback to Product IdentifyingNumber
    serial: bios_info
        .and_then(|b| b.serial.clone())
        .or_else(|| product_info.and_then(|p| p.identifying_number.clone())),
    android_id: None,
})
```

### Field Mapping Description:

| DeviceInfoResponse | WMI Source | WMI Field | Description |
|--------------------|------------|-----------|-------------|
| `device_name` | Win32_ComputerSystem | Name | Windows hostname |
| `manufacturer` | Win32_ComputerSystem | Manufacturer | Manufacturer company |
| `model` | Win32_ComputerSystem | Model | Computer model |
| `uuid` | Win32_ComputerSystemProduct | UUID | Hardware UUID |
| `serial` | Win32_BIOS → Win32_ComputerSystemProduct | SerialNumber → IdentifyingNumber | BIOS serial, fallback to product serial |
| `android_id` | - | - | Not applicable for Windows |

### 7. Serial Number Priority Logic
```rust
serial: bios_info
    .and_then(|b| b.serial.clone())  // First try BIOS
    .or_else(|| product_info.and_then(|p| p.identifying_number.clone())),  // Fallback to Product
```

**Why Two Sources:**
- **BIOS SerialNumber**: More reliable, motherboard-level serial
- **Product IdentifyingNumber**: Alternative, varies by manufacturer
- `.or_else()` creates a fallback chain

## 🛡️ Error Handling

### Graceful Degradation
```rust
Ok(result.unwrap_or_else(|| DeviceInfoResponse {
    device_name: None,
    manufacturer: None,
    model: None,
    uuid: None,
    serial: None,
    android_id: None,
}))
```

**Approach:**
- Returns empty response if WMI fails
- Application doesn't crash, only information is missing
- Safe field access with `Option<String>`

### Possible Error Scenarios:

#### 1. **COM Library Initialization Error**
- **Cause**: COM system issue, permission denied
- **Solution**: Returns fallback response
- **Probability**: Low (native Windows feature)

#### 2. **WMI Connection Error**
- **Cause**: WMI service disabled, corrupt WMI repository
- **Solution**: Returns empty response
- **Troubleshooting**: `winmgmt /verifyrepository` command

#### 3. **WQL Query Error**
- **Cause**: Wrong SQL syntax, missing WMI class
- **Solution**: Query fails, `Vec::new()` returned
- **Debug**: Check WQL syntax

#### 4. **Missing Fields**
- **Cause**: Virtual machine, old Windows version
- **Solution**: Safe access with `Option` types
- **Behavior**: Missing fields return `None`

## 🔍 Windows Version Compatibility

### WMI History:
- **Windows 2000+**: Basic WMI support
- **Windows XP+**: Stable WMI implementation
- **Windows 10+**: Modern WMI, PowerShell integration
- **Windows 11**: Enhanced security, same WMI API

### Field Compatibility:

| Field | Windows XP+ | Windows 10+ | Windows 11 |
|-------|-------------|-------------|------------|
| `Win32_ComputerSystem` | ✅ | ✅ | ✅ |
| `Win32_ComputerSystemProduct` | ✅ | ✅ | ✅ |
| `Win32_BIOS` | ✅ | ✅ | ✅ |
| `Manufacturer/Model` | ✅ | ✅ | ✅ |
| `UUID/SerialNumber` | ⚠️ (may be missing in VMs) | ✅ | ✅ |

## 📝 Example Outputs

### Dell OptiPlex (Physical)
```json
{
  "device_name": "DESKTOP-ABC123",
  "manufacturer": "Dell Inc.",
  "model": "OptiPlex 7090",
  "uuid": "12345678-1234-5678-9ABC-DEF012345678",
  "serial": "C02ABC123DEF",
  "android_id": null
}
```

### Lenovo ThinkPad (Physical)
```json
{
  "device_name": "LAPTOP-XYZ789",
  "manufacturer": "LENOVO",
  "model": "20Y1CTO1WW",
  "uuid": "87654321-4321-8765-CBA9-FED654321098",
  "serial": "PC12345A",
  "android_id": null
}
```

### VMware Virtual Machine
```json
{
  "device_name": "WIN11-VM",
  "manufacturer": "VMware, Inc.",
  "model": "VMware Virtual Platform",
  "uuid": "56789012-5678-9012-3456-789012345678",
  "serial": "VMware-56 78 90 12 56 78 90 12-34 56 78 90 12 34 56 78",
  "android_id": null
}
```

### Hyper-V Virtual Machine
```json
{
  "device_name": "WIN-SERVER01",
  "manufacturer": "Microsoft Corporation",
  "model": "Virtual Machine",
  "uuid": "ABCDEF12-ABCD-ABCD-ABCD-ABCDEFABCDEF",
  "serial": null,
  "android_id": null
}
```

### Fallback Response (WMI failed)
```json
{
  "device_name": null,
  "manufacturer": null,
  "model": null,
  "uuid": null,
  "serial": null,
  "android_id": null
}
```

## 🔧 Debug and Troubleshooting

### Manual WMI Test
To test WMI queries in PowerShell:
```powershell
# Show ComputerSystem information
Get-WmiObject -Class Win32_ComputerSystem | Select-Object Manufacturer, Model, Name

# Show ComputerSystemProduct information
Get-WmiObject -Class Win32_ComputerSystemProduct | Select-Object UUID, IdentifyingNumber

# Show BIOS information
Get-WmiObject -Class Win32_BIOS | Select-Object SerialNumber

# Show all available properties
Get-WmiObject -Class Win32_ComputerSystem | Get-Member
```

### WQL Query Test
To test WMI from command line:
```cmd
# Test with wmic (deprecated but still works)
wmic computersystem get manufacturer,model,name
wmic computersystemproduct get uuid,identifyingnumber
wmic bios get serialnumber

# Modern PowerShell approach
powershell "Get-WmiObject Win32_ComputerSystem"
```

### Common Issues and Solutions:

#### 1. **"WMI repository corrupt"**
- **Symptoms**: WMI queries fail, COM errors
- **Solution**:
  ```cmd
  winmgmt /verifyrepository
  winmgmt /salvagerepository
  ```

#### 2. **"Access Denied" WMI Error**
- **Cause**: Permission denied, UAC
- **Solution**: Run as administrator, check WMI permissions
- **Test**: Check WMI permissions with `dcomcnfg.exe`

#### 3. **Missing Information in Virtual Machines**
- **Cause**: VM hypervisor doesn't provide information
- **Test**: Test with manual PowerShell query
- **Expected**: UUID/Serial may be null

#### 4. **COM Initialization Failure**
- **Cause**: COM system issue
- **Solution**: Windows restart, check COM+ service
- **Test**: Check COM+ system apps with `dcomcnfg.exe`

## ⚡ Performance Notes

### Execution Time:
- **COM Library init**: ~10-50ms
- **WMI Connection**: ~20-100ms
- **Each WQL query**: ~10-50ms
- **Total time**: ~50-200ms

### Memory Usage:
- **COM overhead**: ~1-5MB
- **WMI result sets**: ~1-10KB per query
- **Total memory**: ~2-8MB peak

### Performance Tips:
1. **Field Selection**: SELECT only required fields
2. **Connection Reuse**: Multiple queries with same connection
3. **Lazy Loading**: Device info can be loaded on first use

**Note:** Current implementation doesn't cache for simplicity, fetches fresh data on each call.

## 🔄 Alternative WMI Tables

### For Additional Information:
```sql
-- Operating system information
SELECT * FROM Win32_OperatingSystem

-- Motherboard information
SELECT * FROM Win32_BaseBoard

-- Processor information
SELECT * FROM Win32_Processor

-- Memory information
SELECT * FROM Win32_PhysicalMemory

-- Disk information
SELECT * FROM Win32_DiskDrive
```

### Alternative UUID Sources:
```sql
-- Motherboard UUID (more reliable)
SELECT SerialNumber FROM Win32_BaseBoard

-- CPU ID
SELECT ProcessorId FROM Win32_Processor

-- Network adapter MAC (as network UUID)
SELECT MACAddress FROM Win32_NetworkAdapter WHERE PhysicalAdapter = True
```

## 🔒 Security Considerations

### WMI Security:
- WMI queries don't require admin privileges (read-only)
- Some sensitive information (disk encryption keys) requires separate permissions
- Network WMI queries may need firewall exceptions

### COM Security:
- COM impersonation levels are secure by default
- DCOM security settings can be modified but not necessary
- Process isolation enhances COM security

### Privacy:
- Serial number/UUID may be privacy sensitive
- Be careful about logging from GDPR/compliance perspective
- UUIDs in virtual machines are typically random

---

This documentation details the real WMI-based approach of the Windows device info implementation. Debug information and troubleshooting section provide solutions for production issues.
