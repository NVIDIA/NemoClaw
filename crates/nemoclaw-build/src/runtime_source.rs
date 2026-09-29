// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::{
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

const ROOTS: &[&str] = &["rust-toolchain.toml", "LICENSE", "crates/nemoclaw-runtime"];
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub fn native_runtime_platform() -> Result<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "aarch64") => Ok("linux_arm64"),
        ("linux", "x86_64") => Ok("linux_amd64"),
        _ => Err("runtime images require a native Linux ARM64 or AMD64 host".into()),
    }
}

/// Runtime-owned source files; Cargo creates the standalone manifest and lockfile.
pub fn supervisor_source_files(root: &Path) -> Result<Vec<(String, PathBuf)>> {
    Ok(crate::source::selected_inputs(root, ROOTS)?
        .into_iter()
        .map(|(name, _)| {
            let path = root.join(&name);
            (name, path)
        })
        .collect())
}

/// Retain Cargo's normalized local package without publishing or compiling it.
pub fn stage_runtime_sources(root: &Path, destination: &Path) -> Result<Vec<(String, PathBuf)>> {
    // Reject nonregular source inputs before Cargo follows filesystem paths.
    supervisor_source_files(root)?;
    let package = tempfile::tempdir()?;
    let output = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
        .current_dir(root)
        .args([
            "package",
            "--locked",
            "--no-verify",
            "--allow-dirty",
            "-p",
            "nemoclaw-runtime",
            "--target-dir",
        ])
        .arg(package.path())
        .output()?;
    if !output.status.success() {
        return Err(format!(
            "cannot retain the runtime package: {}",
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    let archives = fs::read_dir(package.path().join("package"))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    let archives: Vec<_> = archives
        .iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "crate"))
        .collect();
    let [archive] = archives.as_slice() else {
        return Err("missing or ambiguous runtime source package".into());
    };
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(fs::File::open(archive)?));
    let mut files = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path: PathBuf = entry.path()?.components().skip(1).collect();
        if path == Path::new(".cargo_vcs_info.json") {
            continue;
        }
        if path.as_os_str().is_empty()
            || !path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            || !entry.header().entry_type().is_file()
        {
            return Err("invalid runtime package source entry".into());
        }
        let name = if path == Path::new("Cargo.lock") {
            path
        } else {
            Path::new("crates/nemoclaw-runtime").join(path)
        };
        let path = destination.join(&name);
        fs::create_dir_all(path.parent().ok_or("source directory missing")?)?;
        entry.unpack(&path)?;
        files.push((name.to_string_lossy().replace('\\', "/"), path));
    }
    for name in ["LICENSE", "rust-toolchain.toml"] {
        let path = destination.join(name);
        fs::copy(root.join(name), &path)?;
        files.push((name.into(), path));
    }
    let manifest = destination.join("Cargo.toml");
    fs::write(
        &manifest,
        "[workspace]\nmembers = [\"crates/nemoclaw-runtime\"]\nresolver = \"3\"\n",
    )?;
    files.push(("Cargo.toml".into(), manifest));
    Ok(files)
}

pub fn runtime_source_inputs(root: &Path) -> Result<Vec<(String, Vec<u8>)>> {
    let directory = tempfile::tempdir()?;
    stage_runtime_sources(root, directory.path())?
        .into_iter()
        .map(|(name, path)| Ok((name, fs::read(path)?)))
        .collect()
}
