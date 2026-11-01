use crate::DiscoveryError;
use if_addrs::Interface;
use mdns_sd::InterfaceId;
use std::net::IpAddr;

/// Full selected interface/address fingerprint: any change invalidates the session.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct LanAddress {
    pub name: String,
    pub index: u32,
    pub address: IpAddr,
}

impl LanAddress {
    pub fn id(&self) -> InterfaceId {
        InterfaceId {
            name: self.name.clone(),
            index: self.index,
        }
    }
}

pub(crate) fn lan_addresses() -> Result<Vec<LanAddress>, DiscoveryError> {
    let interfaces = if_addrs::get_if_addrs()
        .map_err(|_| DiscoveryError::new("network_unavailable", "无法读取本地网络接口"))?;
    let mut selected = Vec::new();
    for interface in interfaces {
        if is_lan(&interface) {
            selected.push(LanAddress {
                name: interface.name.clone(),
                index: interface.index.unwrap_or(0),
                address: interface.ip(),
            });
        }
    }
    selected.sort();
    selected.dedup();
    Ok(selected)
}

fn is_lan(interface: &Interface) -> bool {
    !interface.is_loopback()
        && interface.is_oper_up()
        && !interface.is_p2p()
        && interface.index.is_some_and(|index| index != 0)
        && !virtual_name(&interface.name)
        && physical_lan(interface)
}

fn virtual_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "lo",
        "docker",
        "veth",
        "virbr",
        "vbox",
        "vmnet",
        "vmware",
        "br-",
        "br0",
        "tun",
        "tap",
        "utun",
        "wg",
        "tailscale",
        "zerotier",
        "zt",
        "vpn",
        "ppp",
        "hamachi",
        "loopback",
        "hyper-v",
        "vethernet",
        "wsl",
        "teredo",
        "isatap",
        "npcap",
        "wintun",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
        || [
            "vpn",
            "virtual",
            "wireguard",
            "tailscale",
            "zerotier",
            "tunnel",
        ]
        .iter()
        .any(|part| lower.contains(part))
}

#[cfg(target_os = "linux")]
fn physical_lan(interface: &Interface) -> bool {
    let root = std::path::Path::new("/sys/class/net").join(&interface.name);
    // ARPHRD_ETHER covers Ethernet and Wi-Fi. A real device ancestry excludes
    // veth/bridge/tap/container adapters even when they have a LAN-looking name.
    root.join("device").exists()
        && std::fs::read_to_string(root.join("type")).is_ok_and(|v| v.trim() == "1")
        && std::fs::read_to_string(root.join("flags"))
            .ok()
            .and_then(|v| u32::from_str_radix(v.trim().trim_start_matches("0x"), 16).ok())
            .is_some_and(|flags| flags & 0x1000 != 0) // IFF_MULTICAST
}

#[cfg(windows)]
fn physical_lan(interface: &Interface) -> bool {
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetIfEntry2, MIB_IF_ROW2};
    // Query the OS interface type and hardware flag; an arbitrary renamed VPN
    // must not be accepted merely because its friendly name resembles Ethernet.
    let mut row: MIB_IF_ROW2 = unsafe { std::mem::zeroed() };
    row.InterfaceIndex = interface.index.unwrap_or(0);
    if unsafe { GetIfEntry2(&mut row) } != 0 {
        return false;
    }
    // IANA ifType ethernetCsmacd=6, ieee80211=71; IF_OPER_STATUS Up=1.
    (row.Type == 6 || row.Type == 71)
        && row.OperStatus == 1
        && row.InterfaceAndOperStatusFlags._bitfield & 1 != 0 // HardwareInterface
}

#[cfg(not(any(windows, target_os = "linux")))]
fn physical_lan(_: &Interface) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excludes_tunnels_and_virtual_adapters() {
        for name in [
            "lo",
            "docker0",
            "vethafe",
            "br-abc",
            "tun0",
            "wg0",
            "utun3",
            "vEthernet (WSL)",
            "Ethernet VPN",
            "Wintun",
            "Tailscale",
            "Virtual adapter",
        ] {
            assert!(virtual_name(name), "{name}");
        }
        for name in ["enp3s0", "eth0", "wlp2s0", "Wi-Fi", "Ethernet"] {
            assert!(!virtual_name(name), "{name}");
        }
    }

    #[test]
    fn selected_interfaces_are_physical_operational_lan() {
        // This checks this host's classification, not multicast reachability.
        for interface in if_addrs::get_if_addrs().unwrap() {
            if is_lan(&interface) {
                assert!(physical_lan(&interface));
                assert!(!interface.is_loopback());
                assert!(!interface.is_p2p());
            }
        }
    }
}
