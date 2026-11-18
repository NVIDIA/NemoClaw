// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::io::{Cursor, Read};
pub mod changes;
pub mod ci;
#[cfg(feature = "sdk")]
pub mod docker_provider;
#[cfg(feature = "sdk")]
pub mod docs;
pub mod download;
#[cfg(feature = "sdk")]
pub mod fern;
pub mod glibc;
pub mod hcl_cases;
#[cfg(feature = "sdk")]
pub mod helm_provider;
pub mod images;
pub mod release_assessment;
#[cfg(feature = "sdk")]
pub mod schema;
mod source;
pub use source::{SOURCE_ROOTS, hex, source_inputs, source_version};
#[cfg(feature = "sdk")]
pub const BUILDER_SOURCE_VERSION: &str = env!("NEMOCLAW_BUILD_SOURCE_VERSION");
pub fn extract_tofu(bytes: &[u8], windows: bool) -> Result<Vec<u8>, String> {
    extract_entry(bytes, if windows { "tofu.exe" } else { "tofu" }, 256 << 20)
}
pub fn extract_tofu_license(bytes: &[u8]) -> Result<Vec<u8>, String> {
    extract_entry(bytes, "LICENSE", 1 << 20)
}
fn extract_entry(bytes: &[u8], name: &str, limit: u64) -> Result<Vec<u8>, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "invalid release archive")?;
    // Names are decoded on read; an undecodable name matches nothing.
    if archive
        .file_names()
        .filter(|n| matches!(n, Ok(n) if n == name))
        .count()
        != 1
    {
        return Err("archive lacks one exact requested entry".into());
    }
    let mut file = archive
        .by_name(name)
        .map_err(|_| "archive entry is unavailable")?;
    if !file.is_file()
        || file.size() == 0
        || file.size() > limit
        || file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
    {
        return Err("invalid release archive entry".into());
    }
    let mut output = Vec::new();
    file.read_to_end(&mut output)
        .map_err(|_| "incomplete archive entry")?;
    if output.len() as u64 != file.size() {
        return Err("incomplete archive entry".into());
    }
    Ok(output)
}

/// The version of a bundle built from the checkout at `root`: a clean checkout
/// of a version tag such as `v0.1.0-rc12` reports `0.1.0-rc12`, so a release
/// reports its tag, and any other checkout reports `dev`, which names its
/// sources.
pub fn bundle_version(root: &std::path::Path, dev: &str) -> String {
    let described = std::process::Command::new("git")
        .current_dir(root)
        .args(["describe", "--tags", "--exact-match", "--dirty"])
        .args(["--match", "v[0-9]*.[0-9]*.[0-9]*"])
        .stderr(std::process::Stdio::null())
        .output();
    let Ok(described) = described else {
        return dev.into();
    };
    let tag = String::from_utf8_lossy(&described.stdout);
    match tag.trim().strip_prefix('v') {
        Some(version) if described.status.success() && !version.ends_with("-dirty") => {
            version.into()
        }
        _ => dev.into(),
    }
}

pub fn verify_source_version(expected: &str, files: &[(String, Vec<u8>)]) -> Result<(), String> {
    if source_version(files) != expected {
        return Err("source inputs changed during the build; no artifact published".into());
    }
    Ok(())
}
