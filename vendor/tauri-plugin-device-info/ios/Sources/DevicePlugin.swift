import SwiftRs
import Tauri
import UIKit
import WebKit
import Security
import Network

class DeviceInfoPlugin: Plugin {
    @objc public func get_device_info(_ invoke: Invoke) throws {
        let device = UIDevice.current
        
        // Get specific model identifier (e.g. iPhone14,2)
        var systemInfo = utsname()
        uname(&systemInfo)
        let modelCode = withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) {
                ptr in String(validatingUTF8: ptr)
            }
        } ?? device.model

        let info: [String: Any?] = [
            "uuid": device.identifierForVendor?.uuidString,
            "manufacturer": "Apple Inc.",
            "model": modelCode,
            "serial": self.getPersistentDeviceID(), // Returns a persistent UUID from Keychain
            "android_id": nil,
            "device_name": self.getDeviceName() // Try harder to get real name
        ]
        
        invoke.resolve(info)
    }
    
    @objc public func get_battery_info(_ invoke: Invoke) throws {
        let device = UIDevice.current
        device.isBatteryMonitoringEnabled = true
        
        let level = device.batteryLevel * 100.0
        let isCharging = device.batteryState == .charging || device.batteryState == .full
        
        // iOS public API is limited. We can derive a bit more context:
        var health = "Unknown"
        switch device.batteryState {
        case .unknown:
            health = "Unknown"
        case .unplugged:
             // If level is unexpectedly low or behavior erratic, we can't really know, assuming Good.
            health = "Good"
        case .charging:
            health = "Good (Charging)"
        case .full:
            health = "Good (Full)"
        @unknown default:
            health = "Unknown"
        } 
        
        invoke.resolve([
            "level": level >= 0 ? level : 0, // batteryLevel is -1 if unknown
            "isCharging": isCharging,
            "health": health
        ])
    }
    
    @objc public func get_network_info(_ invoke: Invoke) throws {
        let monitor = NWPathMonitor()
        let queue = DispatchQueue(label: "NetworkMonitor")
        
        var networkType = "unknown"
        let semaphore = DispatchSemaphore(value: 0)
        
        monitor.pathUpdateHandler = { path in
            if path.status == .satisfied {
                if path.usesInterfaceType(.wifi) {
                    networkType = "wifi"
                } else if path.usesInterfaceType(.cellular) {
                    networkType = "cellular"
                } else if path.usesInterfaceType(.wiredEthernet) {
                    networkType = "ethernet"
                } else {
                    networkType = "other"
                }
            } else {
                networkType = "no_connection"
            }
            semaphore.signal()
        }
        
        monitor.start(queue: queue)
        
        // Wait max 500ms for network status
        _ = semaphore.wait(timeout: .now() + 0.5)
        monitor.cancel()
        
        let ipAddress = getIPAddress() ?? "0.0.0.0"
        
        invoke.resolve([
            "ipAddress": ipAddress,
            "networkType": networkType,
            "macAddress": "unavailable" // Apple protects MAC address on iOS 7+
        ])
    }
    
    @objc public func get_storage_info(_ invoke: Invoke) throws {
        let fileURL = URL(fileURLWithPath: NSHomeDirectory())
        do {
            let values = try fileURL.resourceValues(forKeys: [.volumeTotalCapacityKey, .volumeAvailableCapacityKey])
            if let total = values.volumeTotalCapacity, let free = values.volumeAvailableCapacity {
                invoke.resolve([
                    "totalSpace": total,
                    "freeSpace": free,
                    "storageType": "internal"
                ])
                return
            }
        } catch {
            print("Error retrieving storage info: \(error.localizedDescription)")
        }
        
        invoke.reject("Failed to get storage info")
    }
    
    @objc public func get_display_info(_ invoke: Invoke) throws {
        let screen = UIScreen.main
        let bounds = screen.bounds
        let scale = screen.scale
        
        invoke.resolve([
            "width": bounds.width * scale,
            "height": bounds.height * scale,
            "scaleFactor": scale,
            "refreshRate": screen.maximumFramesPerSecond
        ])
    }
    
    // Helper to try and get user-assigned device name
    private func getDeviceName() -> String {
        let deviceName = UIDevice.current.name
        
        // If Apple returns the real name (entitlement exists or old iOS), use it.
        // If it returns generic "iPhone", try to get the Hostname.
        if deviceName != "iPhone" && deviceName != "iPad" && deviceName != "iPod touch" {
            return deviceName
        }
        
        // Try to get hostname (e.g. "yours-iphone.local")
        let hostName = ProcessInfo.processInfo.hostName
        if !hostName.isEmpty && hostName != "localhost" {
            // 1. Remove .local
            var cleaned = hostName.replacingOccurrences(of: ".local", with: "")
            
            // 2. Replace hyphens with spaces
            cleaned = cleaned.replacingOccurrences(of: "-", with: " ")
            
            // 3. Capitalize Each Word
            cleaned = cleaned.capitalized
            
            // 4. Fix specific Apple branding casing if needed
            // "Iphone" -> "iPhone", "Ipad" -> "iPad"
            cleaned = cleaned.replacingOccurrences(of: "Iphone", with: "iPhone")
            cleaned = cleaned.replacingOccurrences(of: "Ipad", with: "iPad")
            cleaned = cleaned.replacingOccurrences(of: "Ipod", with: "iPod")
            
            return cleaned
        }
        
        return deviceName
    }

    // MARK: - Persistent ID (Keychain)
    private func getPersistentDeviceID() -> String {
        let key = "com.tauri.plugin.deviceinfo.unique_id"
        
        // 1. Try to read from Keychain
        if let data = KeychainHelper.load(key: key),
           let id = String(data: data, encoding: .utf8) {
            return id
        }
        
        // 2. If not found, generate new UUID and save it
        let newId = UUID().uuidString
        if let data = newId.data(using: .utf8) {
            _ = KeychainHelper.save(key: key, data: data)
        }
        
        return newId
    }

    // Helper for IP - checks both WiFi (en0) and Cellular (pdp_ip0)
    private func getIPAddress() -> String? {
        var address: String?
        var ifaddr: UnsafeMutablePointer<ifaddrs>? = nil
        if getifaddrs(&ifaddr) == 0 {
            var ptr = ifaddr
            while ptr != nil {
                defer { ptr = ptr?.pointee.ifa_next }
                let interface = ptr?.pointee
                let addrFamily = interface?.ifa_addr.pointee.sa_family
                
                // Only look for IPv4 addresses
                if addrFamily == UInt8(AF_INET) {
                    let name: String = String(cString: (interface?.ifa_name)!)
                    // en0 = WiFi, pdp_ip0 = Cellular
                    if name == "en0" || name == "pdp_ip0" {
                        var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                        getnameinfo(interface?.ifa_addr, socklen_t((interface?.ifa_addr.pointee.sa_len)!), &hostname, socklen_t(hostname.count), nil, socklen_t(0), NI_NUMERICHOST)
                        address = String(cString: hostname)
                        // Prefer WiFi over Cellular, so break if we found en0
                        if name == "en0" { break }
                    }
                }
            }
            freeifaddrs(ifaddr)
        }
        return address
    }
}

class KeychainHelper {
    static func save(key: String, data: Data) -> OSStatus {
        let query = [
            kSecClass as String       : kSecClassGenericPassword as String,
            kSecAttrAccount as String : key,
            kSecValueData as String   : data ] as [String : Any]
        SecItemDelete(query as CFDictionary)
        return SecItemAdd(query as CFDictionary, nil)
    }

    static func load(key: String) -> Data? {
        let query = [
            kSecClass as String       : kSecClassGenericPassword,
            kSecAttrAccount as String : key,
            kSecReturnData as String  : kCFBooleanTrue!,
            kSecMatchLimit as String  : kSecMatchLimitOne ] as [String : Any]

        var dataTypeRef: AnyObject? = nil
        let status: OSStatus = SecItemCopyMatching(query as CFDictionary, &dataTypeRef)
        if status == noErr {
            return dataTypeRef as! Data?
        } else {
            return nil
        }
    }
}

@_cdecl("init_plugin_device_info")
func initPlugin() -> Plugin {
    return DeviceInfoPlugin()
}
