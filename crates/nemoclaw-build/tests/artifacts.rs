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
    let mut reversed = files;
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
        "examples/onboarding-tui/src/lib.rs",
        "examples/onboarding/openclaw.yaml",
        "runtimes/example/Dockerfile",
        "image/fabric/catalog.json",
        "image/fabric/Dockerfile",
        "image/fabric/FABRIC-LICENSE",
        "image/NOTICE.md",
    ] {
        let file = root.path().join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, name).unwrap();
    }
    let first = nemoclaw_build::source_inputs(root.path()).unwrap();
    assert_eq!(first.len(), 13);
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
    std::fs::write(
        root.path().join("examples/onboarding/openclaw.yaml"),
        "changed onboarding defaults",
    )
    .unwrap();
    let changed_defaults = nemoclaw_build::source_inputs(root.path()).unwrap();
    assert_ne!(
        nemoclaw_build::source_version(&first),
        nemoclaw_build::source_version(&changed_defaults)
    );
    std::fs::write(
        root.path().join("examples/onboarding-tui/src/lib.rs"),
        "changed questionnaire",
    )
    .unwrap();
    let changed = nemoclaw_build::source_inputs(root.path()).unwrap();
    assert_ne!(
        nemoclaw_build::source_version(&first),
        nemoclaw_build::source_version(&changed)
    );
}

#[test]
fn runtime_build_inputs_are_selected_by_the_artifact_manifest() {
    let input = br#"{"name":"fixture","platform":"linux_arm64","image":"local/fixture:test","sourceDateEpoch":1234,"files":["Dockerfile","NOTICE.md"],"downloads":{}}"#;
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

#[test]
fn bundle_sources_retain_patched_sdk_but_runtime_sources_exclude_it() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let inputs = nemoclaw_build::source_inputs(&root).unwrap();
    let archive = nemoclaw_build::supervisor_source_files(&root).unwrap();
    for suffix in ["Cargo.toml", "src/lib.rs", "LICENSE", "NOTICE.md"] {
        let name = format!("crates/vendor/openshell-sdk/{suffix}");
        assert!(
            inputs.iter().any(|(path, _)| path == &name),
            "build identity must include {name}"
        );
        assert!(
            !archive.iter().any(|(path, _)| path == &name),
            "runtime builds must exclude {name}"
        );
    }
}

#[test]
fn runtime_manifest_errors_distinguish_json_identity_paths_and_downloads() {
    use nemoclaw_build::{RuntimeArtifact, RuntimeArtifactError};
    use std::error::Error as _;
    let error = RuntimeArtifact::parse(b"{").err().unwrap();
    assert!(matches!(error, RuntimeArtifactError::Json(_)));
    assert!(error.source().unwrap().is::<serde_json::Error>());
    let valid = serde_json::json!({"name":"fixture","platform":"linux_arm64","image":"local/fixture:test","sourceDateEpoch":1234,"files":["Dockerfile"],"downloads":{}});
    let mut invalid = valid.clone();
    invalid["name"] = "".into();
    assert!(matches!(
        RuntimeArtifact::parse(&serde_json::to_vec(&invalid).unwrap()),
        Err(RuntimeArtifactError::InvalidManifest)
    ));
    invalid = valid.clone();
    invalid["files"] = serde_json::json!(["Dockerfile", "Dockerfile"]);
    assert!(matches!(
        RuntimeArtifact::parse(&serde_json::to_vec(&invalid).unwrap()),
        Err(RuntimeArtifactError::InvalidInputPath)
    ));
    invalid = valid;
    invalid["downloads"] = serde_json::json!({"weights":{"url":"http://example.invalid/file","sha256":"0".repeat(64)}});
    assert!(matches!(
        RuntimeArtifact::parse(&serde_json::to_vec(&invalid).unwrap()),
        Err(RuntimeArtifactError::InvalidDownload)
    ));
}

#[test]
fn supervisor_archive_contains_only_runtime_owned_sources_and_notices() {
    let root = tempfile::tempdir().unwrap();
    let retained = [
        "rust-toolchain.toml",
        "LICENSE",
        "crates/nemoclaw-runtime/src/main.rs",
        "crates/nemoclaw-runtime/NOTICE.md",
    ];
    for name in retained.into_iter().chain([
        "Cargo.toml",
        "Cargo.lock",
        "versions.json",
        "crates/nemoclaw-sdk/NOTICE.md",
        "image/fabric/catalog.json",
        "image/fabric/Dockerfile",
        "image/fabric/FABRIC-LICENSE",
        "image/NOTICE.md",
        "examples/onboarding-tui/src/lib.rs",
        "examples/onboarding/openclaw.yaml",
        "runtimes/qwen38/verify_packed.py",
        "runtimes/qwen38/AGPL-3.0-or-later.txt",
        "runtimes/vllm/Dockerfile",
        "runtimes/another-recipe/custom.py",
    ]) {
        let file = root.path().join(name);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, name).unwrap();
    }
    let files = nemoclaw_build::supervisor_source_files(root.path()).unwrap();
    let bytes = nemoclaw_build::source_archive(&files, 1234).unwrap();
    let unpacked = tempfile::tempdir().unwrap();
    tar::Archive::new(flate2::read::GzDecoder::new(bytes.as_slice()))
        .unpack(unpacked.path())
        .unwrap();
    assert!(!unpacked.path().join("runtimes").exists());
    for name in retained {
        assert_eq!(
            std::fs::read_to_string(unpacked.path().join(name)).unwrap(),
            name
        );
    }
    assert_eq!(files.len(), retained.len());
}

#[test]
fn artifact_inputs_cannot_overwrite_the_retained_build_manifest() {
    let input = br#"{"name":"fixture","platform":"linux_arm64","image":"local/fixture:test","sourceDateEpoch":1234,"files":["Dockerfile","build.json"],"downloads":{}}"#;
    assert!(nemoclaw_build::RuntimeArtifact::parse(input).is_err());
}

#[test]
fn runtime_artifacts_can_select_native_linux_amd64() {
    let input = serde_json::json!({"name":"vllm-amd64","platform":"linux_amd64","image":"nc-vllm-amd64:test","sourceDateEpoch":1789516800,"files":["Dockerfile","NOTICE.md"],"downloads":{}});
    let artifact = nemoclaw_build::RuntimeArtifact::parse(&serde_json::to_vec(&input).unwrap())
        .expect("AMD64 runtime manifest must parse");
    artifact.require_native_host("linux_amd64").unwrap();
    assert!(artifact.require_native_host("linux_arm64").is_err());
    let mut invalid = input;
    invalid["platform"] = "darwin_arm64".into();
    assert!(
        nemoclaw_build::RuntimeArtifact::parse(&serde_json::to_vec(&invalid).unwrap()).is_err()
    );
}

#[test]
fn runtime_artifacts_require_an_explicit_platform() {
    let input = br#"{"name":"fixture","image":"local/fixture:test","sourceDateEpoch":1234,"files":["Dockerfile"],"downloads":{}}"#;
    assert!(nemoclaw_build::RuntimeArtifact::parse(input).is_err());
}

#[test]
fn every_bundle_platform_pins_the_docker_provider_archive() {
    let pins: serde_json::Value =
        serde_json::from_str(include_str!("../../../versions.json")).unwrap();
    let version = pins["dockerProvider"]
        .as_str()
        .expect("Docker provider pin");
    for (platform, artifacts) in pins["platforms"].as_object().unwrap() {
        assert_eq!(
            artifacts["dockerProvider"]["url"],
            format!(
                "https://github.com/kreuzwerker/terraform-provider-docker/releases/download/v{version}/terraform-provider-docker_{version}_{platform}.zip"
            )
        );
        let checksum = artifacts["dockerProvider"]["sha256"].as_str().unwrap();
        assert_eq!(checksum.len(), 64);
        assert!(checksum.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}

#[cfg(feature = "sdk")]
#[test]
fn docker_provider_bundle_retains_the_verified_binary_and_license() {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("terraform-provider-docker_v4.6.0", "binary"),
        ("LICENSE", "upstream MPL license"),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes.as_bytes()).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let root = tempfile::tempdir().unwrap();
    let files =
        nemoclaw_build::docker_provider::install(root.path(), &bytes, "4.6.0", "linux_arm64")
            .unwrap();
    let binary = "providers/registry.opentofu.org/kreuzwerker/docker/4.6.0/linux_arm64/terraform-provider-docker_v4.6.0";
    assert_eq!(std::fs::read(root.path().join(binary)).unwrap(), b"binary");
    assert_eq!(
        std::fs::read(root.path().join("licenses/docker-provider-LICENSE")).unwrap(),
        b"upstream MPL license"
    );
    assert_eq!(files.len(), 2);
    for (path, hash) in files {
        assert_eq!(
            hash,
            nemoclaw_sdk::bundle::hash_file(&root.path().join(path)).unwrap()
        );
    }
    assert!(
        nemoclaw_build::docker_provider::install(
            root.path(),
            &archive("terraform-provider-docker_v4.6.0", b"binary"),
            "4.6.0",
            "linux_arm64"
        )
        .is_err()
    );
    assert!(
        nemoclaw_build::docker_provider::install(root.path(), &bytes, "4.5.0", "linux_arm64")
            .is_err()
    );
}

#[test]
fn runtime_source_identity_ignores_unrelated_inputs_and_dependency_owners() {
    use std::{fs, path::Path};
    let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = tempfile::tempdir().unwrap();
    nemoclaw_build::stage_runtime_sources(&repository, root.path()).unwrap();
    // This fixture is a new package source tree, not an already packaged archive.
    fs::remove_file(root.path().join("crates/nemoclaw-runtime/Cargo.toml.orig")).unwrap();
    let first = nemoclaw_build::runtime_source_inputs(root.path()).unwrap();
    assert!(
        !first
            .iter()
            .any(|(name, _)| name.contains("cargo_vcs_info"))
    );
    let lock = first.iter().find(|(name, _)| name == "Cargo.lock").unwrap();
    let lock = String::from_utf8_lossy(&lock.1);
    for name in [
        "nemoclaw-sdk",
        "nemoclaw-provider",
        "openshell",
        "nemo-fabric",
        "bollard",
        "tonic",
    ] {
        assert!(
            !lock.contains(name),
            "unexpected runtime dependency: {name}"
        );
    }
    let manifest = first.iter().find(|(name, _)| name == "Cargo.toml").unwrap();
    let manifest = String::from_utf8_lossy(&manifest.1);
    assert!(!manifest.contains("openshell"));
    assert!(!manifest.contains("onboarding"));
    assert!(
        first
            .iter()
            .any(|(name, _)| name == "crates/nemoclaw-runtime/NOTICE.md")
    );
    for name in [
        "crates/nemoclaw-sdk/src/lib.rs",
        "image/fabric/catalog.json",
        "examples/onboarding-tui/src/lib.rs",
        "runtimes/qwen38/prepare.py",
    ] {
        let path = root.path().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "unrelated change").unwrap();
    }
    let path = root.path().join("Cargo.toml");
    fs::write(
        &path,
        format!(
            "{}\n[workspace.dependencies]\nterminal_size = \"99\"\n",
            fs::read_to_string(&path).unwrap()
        ),
    )
    .unwrap();
    let path = root.path().join("Cargo.lock");
    fs::write(
        &path,
        format!(
            "{}\n[[package]]\nname = \"unrelated-owner\"\nversion = \"99.0.0\"\n",
            fs::read_to_string(&path).unwrap()
        ),
    )
    .unwrap();
    assert_eq!(
        first,
        nemoclaw_build::runtime_source_inputs(root.path()).unwrap()
    );
    let path = root.path().join("crates/nemoclaw-runtime/src/lib.rs");
    fs::write(&path, format!("{}\n", fs::read_to_string(&path).unwrap())).unwrap();
    assert_ne!(
        source_version(&first),
        source_version(&nemoclaw_build::runtime_source_inputs(root.path()).unwrap())
    );
}
