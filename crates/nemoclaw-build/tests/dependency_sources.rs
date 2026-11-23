// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Exercise the image's source-retention command with authenticated artifact fixtures.

use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, path::Path, process::Command};

fn run(root: &Path, artifact: &[u8], expected: &str) -> std::process::Output {
    let cache = root.join("cache");
    fs::create_dir(&cache).unwrap();
    fs::write(cache.join("fixture-1.0.0.crate"), artifact).unwrap();
    let sbom = json!({"components": [{
        "name": "fixture", "version": "1.0.0", "purl": "pkg:cargo/fixture@1.0.0",
        "bom-ref": "registry+https://github.com/rust-lang/crates.io-index#fixture@1.0.0",
        "hashes": [{"alg": "SHA-256", "content": expected}]
    }]});
    for name in ["first", "second"] {
        let dir = root.join(format!("{name}.dist-info/sboms"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("dependencies.json"), sbom.to_string()).unwrap();
    }
    let mut command = Command::new("python3");
    command
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../image/fabric/dependency_sources.py"))
        .arg("--sboms")
        .arg(root)
        .arg("--cache")
        .arg(cache)
        .arg("--output")
        .arg(root.join("sources.tar.gz"));
    if root.join("upstream-notices").exists() {
        command
            .arg("--upstream-notices")
            .arg(root.join("upstream-notices"));
    }
    command.output().unwrap()
}

#[test]
fn source_bundles_keep_authenticated_artifacts_verbatim_without_duplicates() {
    let root = tempfile::tempdir().unwrap();
    let original = b"original upstream source and copyright notice\n";
    let sha = nemoclaw_build::hex(&Sha256::digest(original));
    let output = run(root.path(), original, &sha);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let unpack = Command::new("tar")
        .arg("-xOf")
        .arg(root.path().join("sources.tar.gz"))
        .arg("fixture-1.0.0.crate")
        .output()
        .unwrap();
    assert_eq!(
        unpack.stdout, original,
        "the bundle must preserve the original source artifact once"
    );
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(root.path().join("sources.tar.gz"))
            .unwrap()
            .permissions()
            .mode()
            & 0o444,
        0o444,
        "sandbox users must be able to read the retained sources"
    );
}

#[test]
fn source_bundles_reject_bytes_that_do_not_match_the_sbom_pin() {
    let root = tempfile::tempdir().unwrap();
    let expected = nemoclaw_build::hex(&Sha256::digest(b"original source"));
    let output = run(root.path(), b"changed source", &expected);
    assert!(
        !output.status.success(),
        "a mismatched source must not be accepted"
    );
    assert!(
        !root.path().join("sources.tar.gz").exists(),
        "a rejected input must not leave a source bundle"
    );
}

#[test]
fn source_bundles_include_registry_dependencies_from_python_source_locks() {
    let root = tempfile::tempdir().unwrap();
    let original = b"upstream source bytes";
    let checksum = nemoclaw_build::hex(&Sha256::digest(original));
    let cache = root.path().join("cache");
    fs::create_dir(&cache).unwrap();
    fs::write(cache.join("fixture-1.0.0.crate"), original).unwrap();
    let source = root.path().join("python-source.tar.gz");
    let gzip = flate2::write::GzEncoder::new(
        fs::File::create(&source).unwrap(),
        flate2::Compression::fast(),
    );
    let mut archive = tar::Builder::new(gzip);
    let lock = format!(
        "version = 4\n[[package]]\nname = \"fixture\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\nchecksum = \"{checksum}\"\n"
    );
    let mut header = tar::Header::new_gnu();
    header.set_size(lock.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    archive
        .append_data(&mut header, "python-source/Cargo.lock", lock.as_bytes())
        .unwrap();
    archive.into_inner().unwrap().finish().unwrap();
    let bundle = root.path().join("bundle.tar.gz");
    let output = Command::new("python3")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../image/fabric/dependency_sources.py"))
        .arg("--sdist")
        .arg(source)
        .arg("--cache")
        .arg(cache)
        .arg("--output")
        .arg(&bundle)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let unpack = Command::new("tar")
        .arg("-xOf")
        .arg(bundle)
        .arg("fixture-1.0.0.crate")
        .output()
        .unwrap();
    assert_eq!(
        unpack.stdout, original,
        "a source lock must retain its authenticated registry dependency"
    );
}

#[test]
fn source_bundles_keep_the_openssl_source_pinned_by_cryptography_wheels() {
    let root = tempfile::tempdir().unwrap();
    let original = b"original OpenSSL source archive with its notices";
    let checksum = nemoclaw_build::hex(&Sha256::digest(original));
    let cache = root.path().join("cache");
    fs::create_dir(&cache).unwrap();
    fs::write(cache.join("openssl-4.0.3.tar.gz"), original).unwrap();
    let dir = root.path().join("cryptography.dist-info/sboms");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("sbom.json"),
        json!({"components": [{
            "name": "openssl", "version": "4.0.3", "purl": "pkg:generic/openssl@4.0.3",
            "hashes": [{"alg": "SHA-256", "content": checksum}]
        }]})
        .to_string(),
    )
    .unwrap();
    let bundle = root.path().join("sources.tar.gz");
    let output = Command::new("python3")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../image/fabric/dependency_sources.py"))
        .arg("--sboms")
        .arg(root.path())
        .arg("--cache")
        .arg(cache)
        .arg("--output")
        .arg(&bundle)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let unpack = Command::new("tar")
        .arg("-xOf")
        .arg(bundle)
        .arg("openssl-4.0.3.tar.gz")
        .output()
        .unwrap();
    assert_eq!(
        unpack.stdout, original,
        "the pinned native source must retain its original notices"
    );
}

#[test]
fn source_bundles_add_missing_notices_from_the_matching_upstream_revision() {
    let root = tempfile::tempdir().unwrap();
    let manifest = br#"[package]
name = "fixture"
version = "1.0.0"
repository = "https://github.com/fixture/project"
"#;
    let vcs = br#"{"git":{"sha1":"0000000000000000000000000000000000000000"}}"#;
    let mut source = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::fast(),
    ));
    for (name, bytes) in [
        ("Cargo.toml", manifest.as_slice()),
        (".cargo_vcs_info.json", vcs.as_slice()),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        source
            .append_data(&mut header, format!("fixture-1.0.0/{name}"), bytes)
            .unwrap();
    }
    let artifact = source.into_inner().unwrap().finish().unwrap();
    let checksum = nemoclaw_build::hex(&Sha256::digest(&artifact));
    let notices = root.path().join("upstream-notices");
    fs::create_dir(&notices).unwrap();
    let matching =
        "rust-notice-fixture--project--0000000000000000000000000000000000000000--LICENSE";
    let original = b"original upstream permission notice";
    fs::write(notices.join(matching), original).unwrap();
    fs::write(notices.join("unrelated-LICENSE"), b"unrelated notice").unwrap();
    let output = run(root.path(), &artifact, &checksum);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let unpack = Command::new("tar")
        .arg("-xOf")
        .arg(root.path().join("sources.tar.gz"))
        .arg(format!("upstream-notices/{matching}"))
        .output()
        .unwrap();
    assert_eq!(
        unpack.stdout, original,
        "the exact revision's original notice must be retained"
    );
    let listing = Command::new("tar")
        .arg("-tf")
        .arg(root.path().join("sources.tar.gz"))
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&listing.stdout).contains("unrelated-LICENSE"));
}
