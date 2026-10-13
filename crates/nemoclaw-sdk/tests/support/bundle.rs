// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Bundles that verify without a build, for tests that open one.

use nemoclaw_sdk::{
    bundle::{Manifest, executable, hash_file, required_files},
    compile::OPENTOFU_VERSION,
};
use std::{fs, path::Path};

/// Write a bundle whose hashes verify, so opening it succeeds. With `tofu`,
/// `libexec/tofu` is that shell script; every other file cannot execute, so
/// without it no operation that reaches OpenTofu can do anything. The SDK
/// requires `rust` to be non-empty and `version` to be a semantic version, so
/// these values need not match the toolchain or the workspace version.
pub fn write_bundle(directory: &Path, tofu: Option<&str>) {
    let mut manifest = Manifest {
        version: "0.1.0".into(),
        rust: "1.98.1".into(),
        opentofu: OPENTOFU_VERSION.into(),
        files: Default::default(),
    };
    let tofu_file = format!("libexec/{}", executable("tofu"));
    for name in required_files(&manifest.version).unwrap() {
        let path = directory.join(&name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        match tofu.filter(|_| name == tofu_file) {
            Some(script) => write_script(&path, script),
            None => fs::write(&path, b"non-executable fixture").unwrap(),
        }
        manifest.files.insert(name, hash_file(&path).unwrap());
    }
    fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
}

#[cfg(unix)]
fn write_script(path: &Path, script: &str) {
    crate::executable::write_executable(path, script);
}

#[cfg(not(unix))]
fn write_script(_: &Path, _: &str) {
    panic!("a scripted tofu needs a Unix shell");
}
