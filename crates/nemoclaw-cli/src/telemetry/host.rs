// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The record's host fields: `os`, `arch`, `hostContext`, `deploymentSource`,
//! `cloud`, and `hardware`. Every value is a word from the closed lists in
//! `record.rs`; nothing read from the machine is ever sent as written.

use super::record::{Arch, Cloud, DeploymentSource, Hardware, HostContext, Os};
use std::io::Read;
use std::path::{Path, PathBuf};

/// The marker a machine image sets to name the NVIDIA platform it belongs to.
/// One word, such as `brev`, on one line.
pub const DEPLOYMENT_SOURCE_MARKER: &str = "/etc/nemoclaw/deployment-source";

/// The longest firmware or marker value read, as in Classic.
const VALUE_MAX_BYTES: usize = 256;

/// RTX Spark (N1X) GPU device IDs: the documented ones and the prototypes in
/// Classic's `bin/lib/n1x-pci-policy.json`.
const RTX_SPARK_PCI_DEVICES: [&str; 5] = ["0x2e02", "0x2e03", "0x2e06", "0x2e13", "0x2e2a"];

/// The host fields of one record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Host {
    pub os: Os,
    pub arch: Arch,
    pub host_context: HostContext,
    pub deployment_source: DeploymentSource,
    pub cloud: Cloud,
    pub hardware: Hardware,
}

/// The host fields of this machine.
pub fn detect() -> Host {
    detect_in(Path::new("/"), std::env::consts::OS, std::env::consts::ARCH)
}

/// The host fields read under `root`, so tests can point it at a fixture tree.
fn detect_in(root: &Path, os: &str, arch: &str) -> Host {
    let probe = Probe(root);
    let os = match os {
        "linux" => Os::Linux,
        "macos" => Os::Macos,
        "windows" => Os::Windows,
        _ => Os::Other,
    };
    let linux = os == Os::Linux;
    Host {
        os,
        arch: match arch {
            "x86_64" => Arch::X86_64,
            "aarch64" => Arch::Arm64,
            _ => Arch::Other,
        },
        host_context: if linux {
            probe.host_context()
        } else {
            HostContext::Native
        },
        deployment_source: probe.deployment_source(),
        cloud: if linux { probe.cloud() } else { Cloud::Unknown },
        hardware: match os {
            Os::Linux => probe.hardware(),
            Os::Macos => Hardware::Mac,
            _ => Hardware::Unknown,
        },
    }
}

struct Probe<'a>(&'a Path);

impl Probe<'_> {
    fn path(&self, absolute: &str) -> PathBuf {
        self.0.join(absolute.trim_start_matches('/'))
    }

    fn value(&self, absolute: &str) -> Option<String> {
        bounded(&self.path(absolute))
    }

    /// WSL kernels carry `microsoft` in their release string.
    fn host_context(&self) -> HostContext {
        match self.value("/proc/sys/kernel/osrelease") {
            Some(release) if release.to_ascii_lowercase().contains("microsoft") => HostContext::Wsl,
            Some(_) => HostContext::Native,
            None => HostContext::Unknown,
        }
    }

    /// No valid marker is `none`, never `brev`; a well-formed unlisted word is `other`.
    fn deployment_source(&self) -> DeploymentSource {
        match self.value(DEPLOYMENT_SOURCE_MARKER).as_deref() {
            Some("brev") => DeploymentSource::Brev,
            Some("omnistation") => DeploymentSource::Omnistation,
            Some("colossus") => DeploymentSource::Colossus,
            Some(word) if well_formed(word) => DeploymentSource::Other,
            _ => DeploymentSource::None,
        }
    }

    /// The DMI system vendor names the cloud. Azure and a local Hyper-V VM share
    /// a vendor; Azure alone sets its chassis asset tag.
    fn cloud(&self) -> Cloud {
        let Some(vendor) = self.value("/sys/class/dmi/id/sys_vendor") else {
            return Cloud::Unknown;
        };
        let tag = self
            .value("/sys/class/dmi/id/chassis_asset_tag")
            .unwrap_or_default();
        match vendor.as_str() {
            "Google" => Cloud::Gcp,
            "Amazon EC2" => Cloud::Aws,
            "Microsoft Corporation" if tag == "7783-7084-3265-9085-8269-3286-77" => Cloud::Azure,
            "Alibaba Cloud"
            | "DigitalOcean"
            | "Hetzner"
            | "Linode"
            | "Akamai"
            | "Vultr"
            | "Scaleway"
            | "Tencent Cloud"
            | "Huawei Cloud"
            | "OpenStack Foundation" => Cloud::Other,
            _ if tag == "OracleCloud.com" => Cloud::Other,
            _ => Cloud::None,
        }
    }

    /// Firmware product strings first, as Classic's `detectNvidiaPlatform`
    /// reads them; then the PCI GPUs.
    fn hardware(&self) -> Hardware {
        let products: Vec<String> = [
            "/sys/class/dmi/id/product_name",
            "/sys/class/dmi/id/product_family",
            "/sys/class/dmi/id/board_name",
            "/sys/firmware/devicetree/base/model",
        ]
        .into_iter()
        .filter_map(|path| self.value(path))
        .collect();
        let mut found = None;
        for class in products.iter().filter_map(|product| product_class(product)) {
            if found.is_some_and(|seen| seen != class) {
                return Hardware::Other;
            }
            found = Some(class);
        }
        found
            .or_else(|| self.pci_gpu())
            .unwrap_or(if products.is_empty() {
                Hardware::Unknown
            } else {
                Hardware::Other
            })
    }

    /// An NVIDIA display device: an RTX Spark GPU by its ID, else any NVIDIA GPU.
    fn pci_gpu(&self) -> Option<Hardware> {
        let devices = std::fs::read_dir(self.path("/sys/bus/pci/devices")).ok()?;
        let mut found = None;
        for entry in devices.take(256).flatten() {
            let field = |name: &str| bounded(&entry.path().join(name));
            let display = field("class").is_some_and(|class| class.starts_with("0x03"));
            if field("vendor").as_deref() != Some("0x10de") || !display {
                continue;
            }
            if field("device").is_some_and(|id| RTX_SPARK_PCI_DEVICES.contains(&id.as_str())) {
                return Some(Hardware::RtxSpark);
            }
            found = Some(Hardware::NvidiaGpu);
        }
        found
    }
}

/// A short value, or `None` when it is missing, too long, not UTF-8, holds
/// control characters, or is blank. Classic's `readBoundedNvidiaFirmwareValue`:
/// devicetree strings end in a NUL, other files in a newline.
fn bounded(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| {
            file.take(VALUE_MAX_BYTES as u64 + 2)
                .read_to_end(&mut bytes)
        })
        .ok()?;
    let devicetree = path
        .components()
        .any(|part| part.as_os_str() == "devicetree");
    if bytes.last() == Some(if devicetree { &0 } else { &b'\n' }) {
        bytes.pop();
    }
    let text = String::from_utf8(bytes).ok()?;
    if text.len() > VALUE_MAX_BYTES || text.chars().any(char::is_control) {
        return None;
    }
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Classic's `nvidiaFirmwareProductClass`. The Station's PCI
/// GPU check is left out: it guards inference choices, not the machine's name.
fn product_class(product: &str) -> Option<Hardware> {
    let has = |pattern: &str| {
        regex::Regex::new(&format!("(?i){pattern}")).is_ok_and(|regex| regex.is_match(product))
    };
    let gap = r"[\t\n\x0B\x0C\r _-]+";
    if has(&format!("DGX{gap}Spark")) {
        Some(Hardware::DgxSpark)
    } else if has(&format!(
        "Station{gap}(DGX{gap})?GB300|GB300{gap}(DGX{gap})?Station"
    )) || has(r"(^|[^A-Za-z0-9])P3830($|[^A-Za-z0-9])")
        || has(&format!("DGX{gap}Station"))
    {
        Some(Hardware::DgxStation)
    } else if has("Jetson|Tegra|Thor|Orin|Xavier") {
        Some(Hardware::Jetson)
    } else {
        None
    }
}

/// A marker word: lowercase letters, digits, and `-`, up to 32 characters.
fn well_formed(word: &str) -> bool {
    super::record::matches("^[a-z][a-z0-9-]{0,31}$", word)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixture root holding `files` at their absolute paths.
    fn fixture(files: &[(&str, &str)]) -> tempfile::TempDir {
        let root = tempfile::tempdir().unwrap();
        for (path, contents) in files {
            let path = root.path().join(path.trim_start_matches('/'));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }
        root
    }

    fn linux(files: &[(&str, &str)]) -> Host {
        detect_in(fixture(files).path(), "linux", "aarch64")
    }

    const PRODUCT: &str = "/sys/class/dmi/id/product_name";
    const VENDOR: &str = "/sys/class/dmi/id/sys_vendor";

    #[test]
    fn os_and_arch_map_to_their_words() {
        let root = fixture(&[]);
        for (os, word) in [
            ("linux", Os::Linux),
            ("macos", Os::Macos),
            ("windows", Os::Windows),
            ("freebsd", Os::Other),
        ] {
            assert_eq!(detect_in(root.path(), os, "x86_64").os, word);
        }
        for (arch, word) in [
            ("x86_64", Arch::X86_64),
            ("aarch64", Arch::Arm64),
            ("riscv64", Arch::Other),
        ] {
            assert_eq!(detect_in(root.path(), "linux", arch).arch, word);
        }
    }

    #[test]
    fn host_context_reads_the_kernel_release() {
        let release = "/proc/sys/kernel/osrelease";
        assert_eq!(
            linux(&[(release, "6.6.87.2-microsoft-standard-WSL2\n")]).host_context,
            HostContext::Wsl
        );
        assert_eq!(
            linux(&[(release, "6.8.0-1015-nvidia\n")]).host_context,
            HostContext::Native
        );
        assert_eq!(linux(&[]).host_context, HostContext::Unknown);
        assert_eq!(
            linux(&[(release, "6.8\u{1b}[0m")]).host_context,
            HostContext::Unknown
        );
        let mac = detect_in(fixture(&[]).path(), "macos", "aarch64");
        assert_eq!(mac.host_context, HostContext::Native);
    }

    #[test]
    fn every_deployment_source() {
        for (marker, word) in [
            (Some("brev\n"), DeploymentSource::Brev),
            (Some("omnistation"), DeploymentSource::Omnistation),
            (Some("colossus\n"), DeploymentSource::Colossus),
            (Some("lepton\n"), DeploymentSource::Other),
            (None, DeploymentSource::None),
            (Some(""), DeploymentSource::None),
            (Some("Brev"), DeploymentSource::None),
            (Some("brev cloud"), DeploymentSource::None),
            (Some("/home/user/secret"), DeploymentSource::None),
            (Some(&"a".repeat(33)), DeploymentSource::None),
            (Some(&"b".repeat(300)), DeploymentSource::None),
        ] {
            let files: Vec<_> = marker
                .map(|text| (DEPLOYMENT_SOURCE_MARKER, text))
                .into_iter()
                .collect();
            assert_eq!(linux(&files).deployment_source, word, "{marker:?}");
        }
    }

    #[test]
    fn every_cloud() {
        let tag = "/sys/class/dmi/id/chassis_asset_tag";
        for (files, word) in [
            (vec![(VENDOR, "Google\n")], Cloud::Gcp),
            (vec![(VENDOR, "Amazon EC2\n")], Cloud::Aws),
            (
                vec![
                    (VENDOR, "Microsoft Corporation\n"),
                    (tag, "7783-7084-3265-9085-8269-3286-77\n"),
                ],
                Cloud::Azure,
            ),
            (vec![(VENDOR, "Microsoft Corporation\n")], Cloud::None),
            (vec![(VENDOR, "DigitalOcean\n")], Cloud::Other),
            (
                vec![(VENDOR, "QEMU\n"), (tag, "OracleCloud.com\n")],
                Cloud::Other,
            ),
            (vec![(VENDOR, "Dell Inc.\n")], Cloud::None),
            (vec![], Cloud::Unknown),
        ] {
            assert_eq!(linux(&files).cloud, word, "{files:?}");
        }
        assert_eq!(
            detect_in(fixture(&[]).path(), "macos", "aarch64").cloud,
            Cloud::Unknown
        );
    }

    #[test]
    fn every_hardware() {
        let gpu = |device: &'static str| -> Vec<(&'static str, &'static str)> {
            vec![
                ("/sys/bus/pci/devices/0000:01:00.0/vendor", "0x10de\n"),
                ("/sys/bus/pci/devices/0000:01:00.0/class", "0x030200\n"),
                ("/sys/bus/pci/devices/0000:01:00.0/device", device),
                (PRODUCT, "PowerEdge R760xa\n"),
            ]
        };
        for (files, word) in [
            (vec![(PRODUCT, "NVIDIA DGX Spark\n")], Hardware::DgxSpark),
            (
                vec![(PRODUCT, "NVIDIA DGX Station GB300\n")],
                Hardware::DgxStation,
            ),
            (vec![(PRODUCT, "P3830\n")], Hardware::DgxStation),
            (
                vec![(
                    "/sys/firmware/devicetree/base/model",
                    "NVIDIA Jetson AGX Orin Developer Kit\0",
                )],
                Hardware::Jetson,
            ),
            (gpu("0x2e06\n"), Hardware::RtxSpark),
            (gpu("0x2330\n"), Hardware::NvidiaGpu),
            (vec![(PRODUCT, "PowerEdge R760xa\n")], Hardware::Other),
            (
                vec![
                    (PRODUCT, "NVIDIA DGX Spark\n"),
                    ("/sys/class/dmi/id/board_name", "Jetson\n"),
                ],
                Hardware::Other,
            ),
            (vec![], Hardware::Unknown),
        ] {
            assert_eq!(linux(&files).hardware, word, "{files:?}");
        }
        let root = fixture(&[]);
        assert_eq!(
            detect_in(root.path(), "macos", "aarch64").hardware,
            Hardware::Mac
        );
        assert_eq!(
            detect_in(root.path(), "windows", "x86_64").hardware,
            Hardware::Unknown
        );
    }

    #[test]
    fn no_free_text_reaches_the_record() {
        let odd = "/home/alice/\u{7}weird value";
        let host = linux(&[
            (PRODUCT, odd),
            (VENDOR, odd),
            (DEPLOYMENT_SOURCE_MARKER, odd),
            ("/proc/sys/kernel/osrelease", odd),
        ]);
        assert_eq!(
            host,
            Host {
                os: Os::Linux,
                arch: Arch::Arm64,
                host_context: HostContext::Unknown,
                deployment_source: DeploymentSource::None,
                cloud: Cloud::Unknown,
                hardware: Hardware::Unknown,
            }
        );
    }
}
