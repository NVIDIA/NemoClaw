// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_build::{Run, build_kind, extract_tofu, source_version, stamped_version};
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
const HASH: &str = "0123456789abcdef";

fn upstream(git_ref: &str, number: &str, attempt: &str) -> Run {
    Run {
        repository: "NVIDIA/NemoClaw".into(),
        workflow_ref: format!("NVIDIA/NemoClaw/.github/workflows/rust.yml@{git_ref}"),
        event: "push".into(),
        git_ref: git_ref.into(),
        number: number.into(),
        attempt: attempt.into(),
    }
}
/// An attempt of CI / Bundle's run for a v1 push.
fn ci(number: &str, attempt: &str) -> Run {
    upstream("refs/heads/v1", number, attempt)
}
/// An attempt of CI / Bundle's run for a tag's push.
fn tag_push(tag: &str, number: &str, attempt: &str) -> Run {
    upstream(&format!("refs/tags/{tag}"), number, attempt)
}
fn repository() -> tempfile::TempDir {
    let repository = tempfile::tempdir().unwrap();
    git(repository.path(), &["init", "--quiet"]);
    commit(repository.path(), "first");
    repository
}
fn commit(repository: &Path, contents: &str) {
    std::fs::write(repository.join("Cargo.toml"), contents).unwrap();
    git(repository, &["add", "Cargo.toml"]);
    git(repository, &["commit", "--quiet", "--message", contents]);
}
fn version(repository: &Path, run: &Run) -> String {
    stamped_version(repository, "0.1.0", HASH, run).unwrap()
}

#[test]
fn each_build_reports_its_version_form_and_the_forms_sort_in_release_order() {
    let repository = repository();
    let repository = repository.path();
    let local = Run::default();
    let mut versions = vec![
        version(repository, &ci("8700", "1")),
        version(repository, &ci("10000", "1")),
        version(repository, &local),
    ];
    git(repository, &["tag", "v0.1.0-rc.1"]);
    versions.push(version(repository, &tag_push("v0.1.0-rc.1", "8705", "1")));
    commit(repository, "after rc.1");
    versions.push(version(repository, &ci("8710", "1")));
    git(repository, &["tag", "v0.1.0-rc.12"]);
    versions.push(version(repository, &tag_push("v0.1.0-rc.12", "8860", "1")));
    commit(repository, "after rc.12");
    versions.push(version(repository, &ci("8870", "1")));
    versions.push(version(repository, &ci("8870", "2")));
    versions.push(version(repository, &ci("8871", "1")));
    commit(repository, "rc.13");
    git(repository, &["tag", "v0.1.0-rc.13"]);
    versions.push(version(repository, &tag_push("v0.1.0-rc.13", "8875", "1")));
    commit(repository, "release");
    git(repository, &["tag", "v0.1.0"]);
    versions.push(version(repository, &tag_push("v0.1.0", "8790", "1")));
    commit(repository, "after the release");
    versions.push(version(repository, &ci("8800", "1")));
    versions.push(version(repository, &local));
    git(repository, &["tag", "v0.1.1-rc.1"]);
    versions.push(version(repository, &tag_push("v0.1.1-rc.1", "8805", "1")));
    commit(repository, "next release");
    git(repository, &["tag", "v0.1.1"]);
    versions.push(version(repository, &tag_push("v0.1.1", "8810", "1")));

    assert_eq!(
        versions,
        [
            "0.1.0-8700",
            "0.1.0-10000",
            "0.1.0-dev.0123456789abcdef",
            "0.1.0-rc.1",
            "0.1.0-rc.1.8710",
            "0.1.0-rc.12",
            "0.1.0-rc.12.8870",
            "0.1.0-rc.12.8870.2",
            "0.1.0-rc.12.8871",
            "0.1.0-rc.13",
            "0.1.0",
            "0.1.1-8800",
            "0.1.1-dev.0123456789abcdef",
            "0.1.1-rc.1",
            "0.1.1",
        ]
    );
    let parsed: Vec<_> = versions
        .iter()
        .map(|version| semver::Version::parse(version).unwrap())
        .collect();
    for pair in parsed.windows(2) {
        assert!(pair[0] < pair[1], "{} sorts before {}", pair[0], pair[1]);
    }
    for version in &versions {
        let expected = if version.contains('-') {
            "dev"
        } else {
            "release"
        };
        assert_eq!(build_kind(version), expected, "{version}");
    }
}

#[test]
fn ci_builds_of_one_commit_differ_and_attempts_of_a_tag_push_report_the_tag() {
    let repository = repository();
    let repository = repository.path();
    let brev = Run {
        workflow_ref: "NVIDIA/NemoClaw/.github/workflows/brev.yml@refs/heads/v1".into(),
        ..ci("55", "1")
    };
    let fork = Run {
        repository: "fork/NemoClaw".into(),
        workflow_ref: "fork/NemoClaw/.github/workflows/rust.yml@refs/heads/v1".into(),
        ..ci("55", "1")
    };
    // Two attempts, two runs, and two workflows of one commit.
    let builds = [ci("55", "1"), ci("55", "2"), ci("56", "1"), brev];
    let versions: std::collections::BTreeSet<_> =
        builds.iter().map(|run| version(repository, run)).collect();
    assert_eq!(versions.len(), builds.len(), "{versions:?}");
    assert_eq!(
        version(repository, &fork),
        "0.1.0-dev.0123456789abcdef",
        "a fork's run numbers name nothing"
    );

    git(repository, &["tag", "v0.1.0-rc.1"]);
    for attempt in ["1", "2", "3"] {
        assert_eq!(
            version(repository, &tag_push("v0.1.0-rc.1", "60", attempt)),
            "0.1.0-rc.1",
            "attempt {attempt} of the tag's run"
        );
    }
    assert_eq!(
        version(repository, &ci("61", "1")),
        "0.1.0-rc.1.61",
        "a branch's run at the tagged commit"
    );
    let fork_tag = Run {
        repository: "fork/NemoClaw".into(),
        workflow_ref: "fork/NemoClaw/.github/workflows/rust.yml@refs/tags/v0.1.0-rc.1".into(),
        ..tag_push("v0.1.0-rc.1", "3", "1")
    };
    assert_eq!(version(repository, &fork_tag), "0.1.0-dev.0123456789abcdef");
    std::fs::write(repository.join("Cargo.toml"), "changed").unwrap();
    assert_eq!(
        version(repository, &tag_push("v0.1.0-rc.1", "62", "1")),
        "0.1.0-rc.1.62",
        "a tag's run with changed files"
    );
    git(repository, &["checkout", "--quiet", "Cargo.toml"]);
    git(repository, &["tag", "v0.1.0-rc2"]);
    assert_eq!(
        version(repository, &tag_push("v0.1.0-rc2", "63", "1")),
        "0.1.0-rc.1.63",
        "only rc.N candidate tags count"
    );
}

#[test]
fn the_next_version_is_the_workspace_version_or_the_patch_after_the_highest_release() {
    let repository = repository();
    let repository = repository.path();
    git(repository, &["tag", "v0.1.5"]);
    git(repository, &["tag", "v0.1.3"]);
    git(repository, &["tag", "v0.1.6-rc.4"]);
    git(repository, &["tag", "v0.2.0-rc.2"]);
    let run = ci("7", "1");
    assert_eq!(
        stamped_version(repository, "0.1.0", HASH, &run).unwrap(),
        "0.1.6-rc.4.7"
    );
    assert_eq!(
        stamped_version(repository, "0.2.0", HASH, &run).unwrap(),
        "0.2.0-rc.2.7",
        "a raised workspace version plans the next minor release"
    );
    assert_eq!(
        stamped_version(repository, "1.0.0", HASH, &run).unwrap(),
        "1.0.0-7"
    );
    git(
        repository,
        &["checkout", "--quiet", "--orphan", "unrelated"],
    );
    commit(repository, "unrelated");
    assert_eq!(
        stamped_version(repository, "0.1.0", HASH, &run).unwrap(),
        "0.1.0-7",
        "tags that HEAD can't reach"
    );
}

#[test]
fn versions_stay_valid_semver_when_the_hash_is_all_digits() {
    let missing = tempfile::tempdir().unwrap();
    let missing = missing.path().join("missing");
    for (hash, expected) in [
        ("0123456789012345", "0.1.0-dev.123456789012345"),
        ("0000000000000000", "0.1.0-dev.0"),
        ("1234567890123456", "0.1.0-dev.1234567890123456"),
    ] {
        let version = stamped_version(&missing, "0.1.0", hash, &Run::default()).unwrap();
        assert_eq!(version, expected);
        semver::Version::parse(&version).unwrap();
    }
}

#[test]
fn a_ci_build_needs_the_history_and_a_local_build_does_not() {
    let repository = repository();
    git(repository.path(), &["tag", "v0.1.0"]);
    commit(repository.path(), "second");
    let shallow = tempfile::tempdir().unwrap();
    let url = format!("file://{}", repository.path().display());
    git(
        shallow.path(),
        &["clone", "--quiet", "--depth", "1", &url, "checkout"],
    );
    let shallow = shallow.path().join("checkout");
    assert!(stamped_version(&shallow, "0.1.0", HASH, &ci("9", "1")).is_err());
    assert!(stamped_version(&shallow.join("missing"), "0.1.0", HASH, &ci("9", "1")).is_err());
    assert_eq!(
        stamped_version(&shallow.join("missing"), "0.1.0", HASH, &Run::default()).unwrap(),
        "0.1.0-dev.0123456789abcdef",
        "a local build without git"
    );
    assert_eq!(
        version(repository.path(), &Run::default()),
        "0.1.1-dev.0123456789abcdef",
        "a local build with the history"
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
        "examples/platforms/docker/openclaw-hosted.yaml",
        "image/llama-cpp/Dockerfile",
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
    assert_eq!(first.len(), 16);
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
        root.path()
            .join("examples/platforms/docker/openclaw-hosted.yaml"),
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
