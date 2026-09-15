// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_build::{extract_tofu, source_version};
use std::io::{Cursor, Write};
#[test]
fn provider_version_changes_with_content_and_paths_but_not_input_order() {
    let a = vec![
        ("a.rs".into(), b"first".to_vec()),
        ("b.rs".into(), b"second".to_vec()),
    ];
    let mut b = a.clone();
    b.reverse();
    assert_eq!(source_version(&a), source_version(&b));
    b[0].1.push(b'!');
    assert!(nemoclaw_build::verify_source_version(&source_version(&a), &b).is_err());
    assert_ne!(source_version(&a), source_version(&b));
    b = a.clone();
    b[0].0 = "renamed.rs".into();
    assert_ne!(source_version(&a), source_version(&b));
}
fn archive(name: &str, data: &[u8]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file(name, zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(data).unwrap();
    zip.finish().unwrap().into_inner()
}
#[test]
fn pinned_archive_extracts_only_the_exact_native_binary() {
    assert_eq!(
        extract_tofu(&archive("tofu", b"binary"), false).unwrap(),
        b"binary"
    );
    assert_eq!(
        extract_tofu(&archive("tofu.exe", b"binary"), true).unwrap(),
        b"binary"
    );
    for name in ["../tofu", "nested/tofu", "tofu.exe"] {
        assert!(extract_tofu(&archive(name, b"binary"), false).is_err());
    }
    assert!(extract_tofu(&archive("tofu", b""), false).is_err());
    assert!(extract_tofu(b"incomplete", false).is_err());
}

#[test]
fn source_archive_is_reproducible_and_rejects_paths_outside_its_root() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a");
    let b = dir.path().join("b");
    std::fs::write(&a, b"source").unwrap();
    std::fs::write(&b, b"license").unwrap();
    let files = vec![
        ("src/main.rs".into(), a.clone()),
        ("LICENSE".into(), b.clone()),
    ];
    let first = nemoclaw_build::source_archive(&files, 1234).unwrap();
    let mut reversed = files.clone();
    reversed.reverse();
    assert_eq!(
        first,
        nemoclaw_build::source_archive(&reversed, 1234).unwrap()
    );
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(first.as_slice()));
    let entries: Vec<_> = archive
        .entries()
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            (e.path().unwrap().into_owned(), e.header().mtime().unwrap())
        })
        .collect();
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|(_, mtime)| *mtime == 1234));
    for name in ["../secret", "/absolute", "nested/../escape"] {
        assert!(nemoclaw_build::source_archive(&[(name.into(), a.clone())], 1234).is_err());
    }
    assert!(
        nemoclaw_build::source_archive(&[("same".into(), a), ("same".into(), b)], 1234).is_err()
    );
}

#[test]
fn bundles_retain_the_license_from_the_verified_opentofu_archive() {
    assert_eq!(
        nemoclaw_build::extract_tofu_license(&archive("LICENSE", b"MPL license")).unwrap(),
        b"MPL license"
    );
    assert!(nemoclaw_build::extract_tofu_license(&archive("tofu", b"binary")).is_err());
}

#[test]
fn extracted_sources_build_without_git_and_ignore_generated_outputs() {
    let root = tempfile::tempdir().unwrap();
    for name in [
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "versions.json",
        "LICENSE",
        "crates/sdk/src/lib.rs",
        "runtimes/example/Dockerfile",
    ] {
        let file = root.path().join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, name).unwrap();
    }
    let first = nemoclaw_build::source_inputs(root.path()).unwrap();
    assert_eq!(first.len(), 7);
    for name in [
        "target/output",
        ".local/secret",
        "crates/sdk/target/generated.rs",
    ] {
        let file = root.path().join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, b"ignored").unwrap();
    }
    assert_eq!(first, nemoclaw_build::source_inputs(root.path()).unwrap());
}

#[test]
fn runtime_build_inputs_are_selected_by_the_artifact_manifest() {
    let input = br#"{"name":"fixture","image":"local/fixture:test","sourceDateEpoch":1234,"files":["Dockerfile","NOTICE.md"],"downloads":{}}"#;
    let recipe = nemoclaw_build::RuntimeArtifact::parse(input).unwrap();
    assert_eq!(recipe.name, "fixture");
    assert_eq!(recipe.files, ["Dockerfile", "NOTICE.md"]);
    for bad in ["../outside", "/absolute", "nested/file", "Dockerfile/.."] {
        let mut value: serde_json::Value = serde_json::from_slice(input).unwrap();
        value["files"][0] = bad.into();
        assert!(
            nemoclaw_build::RuntimeArtifact::parse(&serde_json::to_vec(&value).unwrap()).is_err()
        );
    }
}
