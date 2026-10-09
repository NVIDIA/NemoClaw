// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn bundle_rejects_a_missing_or_tampered_helm_provider() {
    let directory = tempfile::tempdir().unwrap();
    let helm = format!(
        "providers/registry.opentofu.org/hashicorp/helm/3.3.0/{}/{}",
        platform().unwrap(),
        executable("terraform-provider-helm_v3.3.0_x5")
    );
    let mut manifest = Manifest {
        version: "0.1.0".into(),
        rust: "1.98.1".into(),
        opentofu: crate::compile::OPENTOFU_VERSION.into(),
        files: Default::default(),
    };
    for name in required_files(&manifest.version).unwrap() {
        if name == helm {
            continue;
        }
        let path = directory.path().join(&name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"fixture binary").unwrap();
        manifest.files.insert(name, hash_file(&path).unwrap());
    }
    let manifest_path = directory.path().join("manifest.json");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(
        Bundle::open(directory.path()).is_err(),
        "a bundle without its pinned Helm provider must be rejected"
    );

    let helm_path = directory.path().join(&helm);
    fs::create_dir_all(helm_path.parent().unwrap()).unwrap();
    fs::write(&helm_path, b"provider binary").unwrap();
    manifest.files.insert(helm, hash_file(&helm_path).unwrap());
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    Bundle::open(directory.path()).unwrap();

    fs::write(&helm_path, b"tampered provider").unwrap();
    assert!(Bundle::open(directory.path()).is_err());
    fs::remove_file(&helm_path).unwrap();
    assert!(Bundle::open(directory.path()).is_err());
}

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

#[test]
fn bundle_requires_the_schema_in_its_integrity_manifest() {
    let directory = tempfile::tempdir().unwrap();
    let schema = crate::config::schema::SCHEMA_PATH;
    let mut manifest = Manifest {
        version: "0.1.0".into(),
        rust: "1.98.1".into(),
        opentofu: crate::compile::OPENTOFU_VERSION.into(),
        files: Default::default(),
    };
    for name in required_files(&manifest.version)
        .unwrap()
        .into_iter()
        .filter(|name| name != schema)
    {
        let path = directory.path().join(&name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"fixture binary").unwrap();
        manifest.files.insert(name, hash_file(&path).unwrap());
    }
    let manifest_path = directory.path().join("manifest.json");
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    assert!(
        Bundle::open(directory.path()).is_err(),
        "schema must be listed"
    );
    let schema_path = directory.path().join(schema);
    fs::create_dir_all(schema_path.parent().unwrap()).unwrap();
    fs::write(
        &schema_path,
        serde_json::to_vec(&crate::config::schema::input_schema()).unwrap(),
    )
    .unwrap();
    manifest
        .files
        .insert(schema.into(), hash_file(&schema_path).unwrap());
    fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    Bundle::open(directory.path()).unwrap();
    fs::write(&schema_path, b"{}\n").unwrap();
    assert!(
        Bundle::open(directory.path()).is_err(),
        "changed schema must fail its hash"
    );
    fs::remove_file(&schema_path).unwrap();
    assert!(
        Bundle::open(directory.path()).is_err(),
        "missing schema must fail verification"
    );
}

/// A complete fixture bundle in `directory`.
fn fixture_bundle(directory: &Path) {
    let mut manifest = Manifest {
        version: "0.1.0".into(),
        rust: "1.98.1".into(),
        opentofu: crate::compile::OPENTOFU_VERSION.into(),
        files: Default::default(),
    };
    for name in required_files(&manifest.version).unwrap() {
        let path = directory.join(&name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"fixture binary").unwrap();
        manifest.files.insert(name, hash_file(&path).unwrap());
    }
    fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
}

#[test]
fn an_unchanged_bundle_is_hashed_once_and_any_written_file_is_hashed_again() {
    let directory = tempfile::tempdir().unwrap();
    fixture_bundle(directory.path());
    let verified = VerifiedBundle::default();
    verified.open(directory.path()).unwrap();
    verified.open(directory.path()).unwrap();
    assert_eq!(verified.hashings(), 1);

    // Writing a file, even with the same length, verifies the bundle again.
    let tofu = directory.path().join("libexec").join(executable("tofu"));
    fs::write(&tofu, b"tampered binar").unwrap();
    assert!(verified.open(directory.path()).is_err());
    assert_eq!(verified.hashings(), 2);
    // A failed verification is not remembered.
    assert!(verified.open(directory.path()).is_err());
    assert_eq!(verified.hashings(), 3);

    // Replacing a file with an identical copy verifies again and succeeds.
    let copy = directory.path().join("replacement");
    fs::write(&copy, b"fixture binary").unwrap();
    fs::rename(&copy, &tofu).unwrap();
    verified.open(directory.path()).unwrap();
    verified.open(directory.path()).unwrap();
    assert_eq!(verified.hashings(), 4);

    // Another bundle directory is verified on its own.
    let other = tempfile::tempdir().unwrap();
    fixture_bundle(other.path());
    verified.open(other.path()).unwrap();
    assert_eq!(verified.hashings(), 5);
}
