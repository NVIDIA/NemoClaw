// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
#[test]
fn bundle_requires_all_native_binaries_and_checks_every_digest() {
    let dir = tempfile::tempdir().unwrap();
    let mut manifest = Manifest {
        version: "0.1.0".into(),
        rust: "1.98.1".into(),
        opentofu: "1.12.6".into(),
        files: Default::default(),
    };
    for name in required_files("0.1.0").unwrap() {
        let path = dir.path().join(&name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"fixture").unwrap();
        manifest.files.insert(name, hash_file(&path).unwrap());
    }
    std::fs::write(
        dir.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    assert!(Bundle::open(dir.path()).is_ok());
    std::fs::write(
        dir.path().join(&required_files("0.1.0").unwrap()[0]),
        b"tampered",
    )
    .unwrap();
    assert!(Bundle::open(dir.path()).is_err());
}
#[test]
fn incomplete_manifests_and_escaping_paths_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let manifest = Manifest {
        version: "../../outside".into(),
        rust: "1.98.1".into(),
        opentofu: "1.12.6".into(),
        files: Default::default(),
    };
    std::fs::write(
        dir.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    assert!(Bundle::open(dir.path()).is_err());
}
