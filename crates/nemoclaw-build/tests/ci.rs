// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `cargo ci` runs the same steps as `CI / Native`, so a local run predicts the PR result.

use nemoclaw_build::ci::{self, Step};
use std::io::{Cursor, Write};

fn workflow() -> serde_json::Value {
    serde_saphyr::from_str(include_str!("../../../.github/workflows/rust.yml")).unwrap()
}

#[test]
fn every_native_workflow_step_runs_through_cargo_ci_in_order() {
    let steps = workflow()["jobs"]["native"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|step| step["run"].as_str())
        .map(str::trim)
        .map(String::from)
        .collect::<Vec<_>>();
    let expected = Step::ALL
        .iter()
        .filter(|step| **step != Step::Tools)
        .map(|step| format!("cargo ci {}", step.name()))
        .collect::<Vec<_>>();
    // The workflow may not run anything the local runner cannot reproduce.
    assert_eq!(steps, expected);
}

#[test]
fn shared_setup_installs_pinned_tools_without_python() {
    let action: serde_json::Value = serde_saphyr::from_str(include_str!(
        "../../../.github/actions/setup-rust/action.yml"
    ))
    .unwrap();
    let commands = action["runs"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|step| step["run"].as_str())
        .collect::<String>();
    assert!(commands.contains("cargo ci tools"), "{commands}");
    for workflow in [
        include_str!("../../../.github/workflows/rust.yml"),
        include_str!("../../../.github/actions/setup-rust/action.yml"),
    ] {
        assert!(!workflow.contains("python"), "{workflow}");
    }
}

#[test]
fn dependency_cache_survives_workspace_manifest_changes() {
    // The cache action can restore an older cache only when the part of its
    // key outside its own lockfile hash is unchanged. A root manifest hash
    // there turns every workspace change into a cold build on every platform.
    let action: serde_json::Value = serde_saphyr::from_str(include_str!(
        "../../../.github/actions/setup-rust/action.yml"
    ))
    .unwrap();
    let cache = action["runs"]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|step| {
            step["uses"]
                .as_str()
                .is_some_and(|uses| uses.starts_with("Swatinem/rust-cache@"))
        })
        .expect("Rust dependency cache step");
    let key = cache["with"]["key"].as_str().unwrap_or_default();
    assert!(!key.contains("hashFiles"), "{key}");
    assert_eq!(cache["with"]["add-rust-environment-hash-key"], "true");
    // Profiles change compiled dependencies, so they live where the cache
    // action hashes them: .cargo/config.toml, not the root manifest.
    let manifest = include_str!("../../../Cargo.toml");
    assert!(
        !manifest.lines().any(|line| line.starts_with("[profile")),
        "move profiles to .cargo/config.toml"
    );
    let config = include_str!("../../../.cargo/config.toml");
    assert!(config.lines().any(|line| line == "[profile.dev]"));
}

#[test]
fn every_bundle_platform_pins_its_ci_tools() {
    let pins: serde_json::Value =
        serde_json::from_str(include_str!("../../../versions.json")).unwrap();
    let version = pins["nextest"].as_str().expect("nextest version pin");
    for (platform, artifacts) in pins["platforms"].as_object().unwrap() {
        let target = ci::nextest_target(platform).unwrap();
        assert_eq!(
            artifacts["nextest"]["url"],
            format!(
                "https://github.com/nextest-rs/nextest/releases/download/cargo-nextest-{version}/cargo-nextest-{version}-{target}.tar.gz"
            ),
            "{platform}"
        );
        assert_eq!(
            artifacts["protoc"]["url"]
                .as_str()
                .unwrap()
                .split('/')
                .nth(7),
            Some(format!("v{}", pins["protobuf"].as_str().unwrap()).as_str()),
            "{platform}"
        );
        for tool in ["nextest", "protoc"] {
            let checksum = artifacts[tool]["sha256"].as_str().unwrap();
            assert_eq!(checksum.len(), 64, "{platform} {tool}");
            assert!(checksum.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
    }
}

#[test]
fn unknown_steps_and_platforms_are_rejected_before_any_work() {
    assert_eq!(Step::parse("lifecycle"), Some(Step::Lifecycle));
    assert_eq!(Step::parse("python"), None);
    assert!(ci::nextest_target("plan9_amd64").is_err());
}

fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        if name.ends_with('/') {
            zip.add_directory(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
        } else {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
    }
    zip.finish().unwrap().into_inner()
}

#[test]
fn protoc_archive_is_installed_with_its_includes_and_an_executable_compiler() {
    let directory = tempfile::tempdir().unwrap();
    let archive = zip(&[
        ("bin/", b""),
        ("bin/protoc", b"compiler"),
        ("include/google/protobuf/any.proto", b"syntax"),
        ("readme.txt", b"notice"),
    ]);
    let binary = ci::install_protoc(&archive, directory.path(), false).unwrap();
    assert_eq!(binary, directory.path().join("bin/protoc"));
    assert_eq!(std::fs::read(&binary).unwrap(), b"compiler");
    assert!(
        directory
            .path()
            .join("include/google/protobuf/any.proto")
            .is_file()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&binary).unwrap().permissions().mode() & 0o111,
            0o111
        );
    }
}

#[test]
fn archives_cannot_write_outside_the_tool_directory_or_omit_the_compiler() {
    let directory = tempfile::tempdir().unwrap();
    let escape = directory.path().join("escape");
    for archive in [
        zip(&[("bin/protoc", b"x"), ("../escape", b"x")]),
        zip(&[("include/a.proto", b"x")]),
    ] {
        assert!(ci::install_protoc(&archive, &directory.path().join("tool"), false).is_err());
    }
    assert!(!escape.exists());
}

fn tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
        Vec::new(),
        flate2::Compression::default(),
    ));
    for (name, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        // Write the raw name so tests can model hostile paths the builder rejects.
        header.as_old_mut().name[..name.len()].copy_from_slice(name.as_bytes());
        header.set_size(bytes.len() as u64);
        header.set_mode(0o755);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_cksum();
        tar.append(&header, *bytes).unwrap();
    }
    tar.into_inner().unwrap().finish().unwrap()
}

#[test]
fn nextest_archive_installs_only_its_single_executable() {
    let directory = tempfile::tempdir().unwrap();
    let binary = ci::install_nextest(
        &tar_gz(&[("cargo-nextest", b"runner")]),
        directory.path(),
        false,
    )
    .unwrap();
    assert_eq!(binary, directory.path().join("cargo-nextest"));
    assert_eq!(std::fs::read(&binary).unwrap(), b"runner");
    for archive in [
        tar_gz(&[("cargo-nextest", b"runner"), ("extra", b"x")]),
        tar_gz(&[("../cargo-nextest", b"runner")]),
        tar_gz(&[]),
    ] {
        assert!(ci::install_nextest(&archive, &directory.path().join("other"), false).is_err());
    }
}
