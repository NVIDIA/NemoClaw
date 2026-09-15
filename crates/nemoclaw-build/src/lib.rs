// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::io::{Cursor, Read};
pub mod schema;
mod source;
pub use source::{hex, source_inputs, source_version};
pub const BUILDER_SOURCE_VERSION: &str = env!("NEMOCLAW_BUILD_SOURCE_VERSION");
pub fn extract_tofu(bytes: &[u8], windows: bool) -> Result<Vec<u8>, String> {
    extract_entry(bytes, if windows { "tofu.exe" } else { "tofu" }, 256 << 20)
}
pub fn extract_tofu_license(bytes: &[u8]) -> Result<Vec<u8>, String> {
    extract_entry(bytes, "LICENSE", 1 << 20)
}
fn extract_entry(bytes: &[u8], name: &str, limit: u64) -> Result<Vec<u8>, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "invalid OpenTofu archive")?;
    if archive.file_names().filter(|n| *n == name).count() != 1 {
        return Err("archive lacks one exact native OpenTofu binary".into());
    }
    let mut file = archive
        .by_name(name)
        .map_err(|_| "OpenTofu binary is unavailable")?;
    if !file.is_file()
        || file.size() == 0
        || file.size() > limit
        || file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 != 0 && mode & 0o170000 != 0o100000)
    {
        return Err("invalid OpenTofu archive entry".into());
    }
    let mut output = Vec::new();
    file.read_to_end(&mut output)
        .map_err(|_| "incomplete OpenTofu binary")?;
    if output.len() as u64 != file.size() {
        return Err("incomplete OpenTofu binary".into());
    }
    Ok(output)
}

/// Retain supervisor build inputs without any image recipes or preparation tools.
pub fn supervisor_source_files(
    root: &std::path::Path,
) -> Result<Vec<(String, std::path::PathBuf)>, String> {
    Ok(source_inputs(root)?
        .into_iter()
        .filter(|(name, _)| !name.starts_with("runtimes/"))
        .map(|(name, _)| {
            let path = root.join(&name);
            (name, path)
        })
        .collect())
}

pub fn source_archive(
    files: &[(String, std::path::PathBuf)],
    epoch: u64,
) -> Result<Vec<u8>, String> {
    use std::{collections::BTreeSet, fs, path::Component};
    let mut files: Vec<_> = files.iter().collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let gzip = flate2::GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(gzip);
    let mut seen = BTreeSet::new();
    for (name, path) in files {
        if name.is_empty()
            || name.contains('\\')
            || !std::path::Path::new(name)
                .components()
                .all(|p| matches!(p, Component::Normal(_)))
            || !seen.insert(name)
        {
            return Err("invalid or duplicate source archive path".into());
        }
        let metadata = fs::symlink_metadata(path).map_err(|_| "source file is unavailable")?;
        if !metadata.is_file() {
            return Err("source archive requires regular files".into());
        }
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 != 0 {
                0o755
            } else {
                0o644
            }
        };
        #[cfg(not(unix))]
        let mode = 0o644;
        let mut header = tar::Header::new_gnu();
        header.set_size(metadata.len());
        header.set_mode(mode);
        header.set_mtime(epoch);
        header.set_cksum();
        tar.append_data(
            &mut header,
            name,
            fs::File::open(path).map_err(|_| "cannot open source input")?,
        )
        .map_err(|_| "cannot archive source input")?;
    }
    tar.into_inner()
        .map_err(|_| "cannot finish source tar")?
        .finish()
        .map_err(|_| "cannot finish source archive".into())
}

pub fn verify_source_version(expected: &str, files: &[(String, Vec<u8>)]) -> Result<(), String> {
    if source_version(files) != expected {
        return Err("source inputs changed during the build; no artifact published".into());
    }
    Ok(())
}

mod runtime_artifact;
pub use runtime_artifact::RuntimeArtifact;
