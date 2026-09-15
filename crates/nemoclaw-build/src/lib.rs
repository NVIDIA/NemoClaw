// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
pub mod schema;
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
    for name in [
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "versions.json",
        "LICENSE",
        "crates",
        "runtimes",
    ] {
        collect(root, &root.join(name), &mut files)?;
    }
    Ok(files.into_iter().collect())
}

mod runtime_artifact;
pub use runtime_artifact::RuntimeArtifact;
