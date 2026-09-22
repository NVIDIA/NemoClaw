// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, fs, path::Path};

// Release v4.6.0, source revision 1e48613cd36acab30e9146aae6f036ea8e40a288.
// On 2026-09-19, versions.json archive pins were verified against the release
// SHA256SUMS signature using the registry-published signing key fingerprint
// F31236BA85096E3AE22A8C660DCE698927DAF8EC. Upstream binary and license are unchanged.
/// Install the binary and unchanged upstream license from a checksum-verified release.
pub fn install(
    root: &Path,
    archive: &[u8],
    version: &str,
    platform: &str,
) -> Result<BTreeMap<String, String>, Box<dyn std::error::Error>> {
    if version != "4.6.0"
        || !matches!(
            platform,
            "linux_arm64" | "linux_amd64" | "darwin_arm64" | "darwin_amd64" | "windows_amd64"
        )
    {
        return Err("unsupported Docker provider version or platform".into());
    }
    let extension = if platform.starts_with("windows") {
        ".exe"
    } else {
        ""
    };
    let name = format!("terraform-provider-docker_v{version}{extension}");
    let binary = crate::extract_entry(archive, &name, 256 << 20)?;
    let license = crate::extract_entry(archive, "LICENSE", 1 << 20)?;
    let path =
        format!("providers/registry.opentofu.org/kreuzwerker/docker/{version}/{platform}/{name}");
    let mut files = BTreeMap::new();
    for (relative, bytes) in [
        (path.as_str(), binary.as_slice()),
        ("licenses/docker-provider-LICENSE", license.as_slice()),
    ] {
        let destination = root.join(relative);
        fs::create_dir_all(destination.parent().ok_or("missing bundle parent")?)?;
        fs::write(&destination, bytes)?;
        files.insert(
            relative.to_owned(),
            nemoclaw_sdk::bundle::hash_file(&destination)?,
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.join(path), fs::Permissions::from_mode(0o755))?;
    }
    Ok(files)
}
