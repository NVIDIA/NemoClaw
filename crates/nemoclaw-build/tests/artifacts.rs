// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_build::{bundle_version, extract_tofu, source_version};
use std::io::{Cursor, Write};
use std::path::Path;
fn git(repository: &Path, args: &[&str]) {
    // A commit hook's GIT_DIR would point these commands at its repository.
    let status = std::process::Command::new("git")
        .current_dir(repository)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .args([
            "-c",
            "user.name=NemoClaw",
            "-c",
            "user.email=nemoclaw@example.com",
        ])
        .args(["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"])
        .args(args)
        .stdout(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}
#[test]
fn bundle_reports_the_tag_of_a_clean_tagged_checkout_and_its_sources_otherwise() {
    let repository = tempfile::tempdir().unwrap();
    let repository = repository.path();
    let dev = "0.1.0-dev.0123456789abcdef";
    git(repository, &["init", "--quiet"]);
    std::fs::write(repository.join("Cargo.toml"), "first").unwrap();
    git(repository, &["add", "Cargo.toml"]);
    git(repository, &["commit", "--quiet", "--message", "first"]);
    assert_eq!(bundle_version(repository, dev), dev, "untagged commit");
    git(repository, &["tag", "v0.1.0-rc12"]);
    assert_eq!(
        bundle_version(repository, dev),
        "0.1.0-rc12",
        "release candidate tag"
    );
    std::fs::write(repository.join("Cargo.toml"), "changed").unwrap();
    assert_eq!(bundle_version(repository, dev), dev, "uncommitted change");
    git(
        repository,
        &["commit", "--quiet", "--all", "--message", "second"],
    );
    git(repository, &["tag", "v0.1.0"]);
    assert_eq!(bundle_version(repository, dev), "0.1.0", "release tag");
    git(repository, &["tag", "--delete", "v0.1.0"]);
    git(repository, &["tag", "nightly"]);
    assert_eq!(bundle_version(repository, dev), dev, "other tag");
    assert_eq!(
        bundle_version(&repository.join("missing"), dev),
        dev,
        "no repository"
    );
}
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
        "crates/nemoclaw-onboarding/src/lib.rs",
        "examples/onboarding/openclaw.yaml",
        "image/ollama/Dockerfile",
        "image/supervisor/Dockerfile",
        "image/vllm/Dockerfile",
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
    assert_eq!(first.len(), 15);
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
        root.path().join("crates/nemoclaw-onboarding/src/lib.rs"),
        "changed questionnaire",
    )
    .unwrap();
    let changed = nemoclaw_build::source_inputs(root.path()).unwrap();
    assert_ne!(
        nemoclaw_build::source_version(&first),
        nemoclaw_build::source_version(&changed)
    );
}

#[cfg(feature = "sdk")]
#[test]
fn docker_provider_bundle_retains_the_verified_binary_and_license() {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("terraform-provider-docker_v4.7.0", "binary"),
        ("LICENSE", "upstream MPL license"),
    ] {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes.as_bytes()).unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    let root = tempfile::tempdir().unwrap();
    let files =
        nemoclaw_build::docker_provider::install(root.path(), &bytes, "4.7.0", "linux_arm64")
            .unwrap();
    let binary = "providers/registry.opentofu.org/kreuzwerker/docker/4.7.0/linux_arm64/terraform-provider-docker_v4.7.0";
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
            &archive("terraform-provider-docker_v4.7.0", b"binary"),
            "4.7.0",
            "linux_arm64"
        )
        .is_err()
    );
    assert!(
        nemoclaw_build::docker_provider::install(root.path(), &bytes, "4.5.0", "linux_arm64")
            .is_err()
    );
}

#[cfg(feature = "sdk")]
#[test]
fn helm_provider_bundle_retains_the_native_binary_and_upstream_license() {
    for platform in [
        "linux_arm64",
        "linux_amd64",
        "darwin_arm64",
        "darwin_amd64",
        "windows_amd64",
    ] {
        let extension = if platform == "windows_amd64" {
            ".exe"
        } else {
            ""
        };
        let name = format!("terraform-provider-helm_v3.3.0_x5{extension}");
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (entry, bytes) in [
            (name.as_str(), "native provider"),
            ("LICENSE.txt", "unchanged upstream MPL license"),
        ] {
            zip.start_file(entry, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes.as_bytes()).unwrap();
        }
        let archive = zip.finish().unwrap().into_inner();
        let root = tempfile::tempdir().unwrap();
        let files =
            nemoclaw_build::helm_provider::install(root.path(), &archive, "3.3.0", platform)
                .unwrap();
        let binary =
            format!("providers/registry.opentofu.org/hashicorp/helm/3.3.0/{platform}/{name}");
        assert_eq!(
            std::fs::read(root.path().join(&binary)).unwrap(),
            b"native provider"
        );
        assert_eq!(
            std::fs::read(root.path().join("licenses/helm-provider-LICENSE")).unwrap(),
            b"unchanged upstream MPL license"
        );
        assert_eq!(files.len(), 2);
        for (path, hash) in files {
            assert_eq!(
                hash,
                nemoclaw_sdk::bundle::hash_file(&root.path().join(path)).unwrap()
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.path().join(binary))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o755
            );
        }
    }
}

#[cfg(feature = "sdk")]
#[test]
fn helm_provider_rejects_incomplete_or_substituted_inputs_before_writing() {
    for (name, version, platform) in [
        ("terraform-provider-helm_v3.3.0_x5", "3.3.0", "linux_amd64"),
        ("LICENSE.txt", "3.3.0", "linux_amd64"),
        ("terraform-provider-helm_v3.3.0_x5", "3.2.0", "linux_amd64"),
        (
            "terraform-provider-helm_v3.3.0_x5",
            "3.3.0",
            "../../outside",
        ),
        (
            "terraform-provider-helm_v3.3.0_x5",
            "3.3.0",
            "windows_amd64",
        ),
        (
            "nested/terraform-provider-helm_v3.3.0_x5",
            "3.3.0",
            "linux_amd64",
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        assert!(
            nemoclaw_build::helm_provider::install(
                root.path(),
                &archive(name, b"fixture"),
                version,
                platform
            )
            .is_err()
        );
        assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
    }
}
