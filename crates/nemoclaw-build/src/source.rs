// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use sha2::{Digest, Sha256};
pub const SOURCE_ROOTS: &[&str] = &[
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "versions.json",
    "LICENSE",
    "crates",
    "examples/onboarding-tui",
    "examples/onboarding/openclaw.yaml",
    "runtimes",
    "image/fabric/catalog.json",
    "image/fabric/Dockerfile",
    "image/fabric/FABRIC-LICENSE",
    "image/NOTICE.md",
];
pub fn source_version(files: &[(String, Vec<u8>)]) -> String {
    let mut files: Vec<_> = files.iter().collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hash = Sha256::new();
    for (name, bytes) in files {
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name.as_bytes());
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    format!("0.1.0-dev.{}", hex(&hash.finalize())[..16].to_owned())
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn source_inputs(root: &std::path::Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    use std::{collections::BTreeMap, fs, path::Path};
    fn collect(
        root: &Path,
        path: &Path,
        files: &mut BTreeMap<String, Vec<u8>>,
    ) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path).map_err(|_| "source input is unavailable")?;
        if metadata.is_dir() {
            for entry in fs::read_dir(path).map_err(|_| "cannot enumerate source inputs")? {
                let entry = entry.map_err(|_| "source entry unavailable")?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with('.') || name == "target" {
                    continue;
                }
                collect(root, &entry.path(), files)?;
            }
        } else if metadata.is_file() {
            let name = path
                .strip_prefix(root)
                .map_err(|_| "source outside root")?
                .to_str()
                .ok_or("source name is not UTF-8")?
                .replace('\\', "/");
            files.insert(
                name,
                fs::read(path).map_err(|_| "source input is unreadable")?,
            );
        } else {
            return Err("source inputs must be regular files".into());
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    for name in SOURCE_ROOTS {
        collect(root, &root.join(name), &mut files)?;
    }
    Ok(files.into_iter().collect())
}
