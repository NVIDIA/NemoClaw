// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, fs, path::Path};

// Release v3.4.0, source revision f76a1ae8afd51777c8ef068b3cfaf34d58a32803.
// On 2026-11-09, versions.json archive pins were verified against the official
// SHA256SUMS signature using HashiCorp's published signing key fingerprint
// C874011F0AB405110D02105534365D9472D7468F, and each downloaded archive hashed
// to its pin. Each archive's LICENSE.txt matches LICENSE at the source revision.
// Upstream binary and license are unchanged.
/// Install the binary and unchanged upstream license from a checksum-verified release.
pub fn install(
    root: &Path,
    archive: &[u8],
    version: &str,
    platform: &str,
) -> Result<BTreeMap<String, String>, Box<dyn std::error::Error>> {
    if version != nemoclaw_sdk::kubernetes::service::PROVIDER_VERSION {
        return Err("unsupported Kubernetes provider version".into());
    }
    let path = nemoclaw_sdk::bundle::kubernetes_provider_path(platform)?;
    let name = path.rsplit('/').next().ok_or("missing provider name")?;
    let binary = crate::extract_entry(archive, name, 256 << 20)?;
    let license = crate::extract_entry(archive, "LICENSE.txt", 1 << 20)?;
    let mut files = BTreeMap::new();
    for (relative, bytes) in [
        (path.as_str(), binary.as_slice()),
        ("licenses/kubernetes-provider-LICENSE", license.as_slice()),
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
