// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Exercise image commands with a Docker double, not a daemon.
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::{Command, Output},
    sync::OnceLock,
};

const REVISION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn docker_bin() -> &'static Path {
    static BIN: OnceLock<tempfile::TempDir> = OnceLock::new();
    BIN.get_or_init(|| {
        let bin = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .args(["--edition=2024", "--crate-name", "image_docker"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/image_docker.rs"))
            .arg("-o")
            .arg(bin.path().join("docker"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        bin
    })
    .path()
}

struct Fixture {
    root: tempfile::TempDir,
    bridge: Value,
    catalog: Value,
    inspection: Value,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("image.tar"), b"candidate archive").unwrap();
        fs::write(
            root.path().join("metadata.json"),
            json!({"openclaw": {"containerimage.digest": DIGEST}}).to_string(),
        )
        .unwrap();
        let bridge = json!({"interface_version": 1, "capabilities": ["configure", "invoke"]});
        let catalog = json!({
            "bridge": bridge,
            "runtime": {
                "command": ["/opt/fabric/bin/python", "-m", "fabric"],
                "binaries": {"nvidia.fabric.openclaw": ["/usr/bin/openclaw"]}
            }
        });
        let inspection = json!([{
            "Os": "linux", "Architecture": "amd64",
            "RepoDigests": [format!("nc-fabric@{DIGEST}")],
            "Config": {"Labels": {
                "io.nemoclaw.fabric.bridge": bridge.to_string(),
                "io.nemoclaw.fabric.catalog": catalog.to_string()
            }}
        }]);
        Self {
            root,
            bridge,
            catalog,
            inspection,
        }
    }

    fn environment(&self, command: &mut Command) {
        let mut paths = vec![docker_bin().to_owned()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        command
            .current_dir(self.root.path())
            .env("PATH", std::env::join_paths(paths).unwrap())
            .env(
                "BAKE_PLAN",
                json!({"target": {"openclaw": {"tags": ["nc-fabric:openclaw"]}}}).to_string(),
            )
            .env("BRIDGE", self.bridge.to_string())
            .env("CATALOG", self.catalog.to_string())
            .env("INSPECTION", self.inspection.to_string());
    }

    fn images(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"));
        command.arg("images").args(args);
        self.environment(&mut command);
        command
    }

    fn candidate(&self, action: &str, revision: &str) -> Output {
        let mut command = self.images(&["candidate", action]);
        command.arg(self.root.path()).arg(revision);
        command.output().unwrap()
    }

    fn record(&self) {
        success(self.candidate("record", REVISION));
    }

    fn calls(&self) -> Vec<Vec<String>> {
        fs::read_to_string(self.root.path().join("docker.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| line.split('\0').map(str::to_owned).collect())
            .collect()
    }

    fn no_image_ref(&self) {
        assert!(!self.root.path().join("image-ref").exists());
    }
}

fn success(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn candidate_without_installed_catalog_is_rejected_before_image_ref_write() {
    let mut fixture = Fixture::new();
    fixture.record();
    fixture.inspection[0]["Config"]["Labels"]
        .as_object_mut()
        .unwrap()
        .remove("io.nemoclaw.fabric.catalog");
    let result = fixture.candidate("load", REVISION);
    assert!(
        !result.status.success(),
        "accepted an image without installed metadata"
    );
    assert!(String::from_utf8_lossy(&result.stderr).contains("installed Fabric metadata"));
    assert_eq!(fixture.calls().len(), 2);
    fixture.no_image_ref();
}

#[test]
fn candidate_rejects_malformed_runtime_metadata_before_image_ref_write() {
    let valid = Fixture::new().catalog;
    let mut invalid = vec![
        ("non-JSON label".to_owned(), json!("{")),
        ("non-string label".to_owned(), json!(42)),
        ("null catalog".to_owned(), json!("null")),
        ("array catalog".to_owned(), json!("[]")),
        ("missing runtime".to_owned(), json!("{}")),
    ];
    for path in [
        "/runtime",
        "/runtime/command",
        "/runtime/binaries",
        "/runtime/binaries/nvidia.fabric.openclaw",
    ] {
        for value in [
            Value::Null,
            json!([]),
            json!("wrong type"),
            json!({}),
            json!([""]),
            json!(["valid", 42]),
        ] {
            let mut catalog = valid.clone();
            *catalog.pointer_mut(path).unwrap() = value.clone();
            invalid.push((format!("{path}={value}"), json!(catalog.to_string())));
        }
    }
    let mut accepted = Vec::new();
    for (name, label) in invalid {
        let mut fixture = Fixture::new();
        fixture.record();
        fixture.inspection[0]["Config"]["Labels"]["io.nemoclaw.fabric.catalog"] = label;
        let result = fixture.candidate("load", REVISION);
        if result.status.success() || fixture.root.path().join("image-ref").exists() {
            accepted.push(name);
        } else {
            assert!(
                String::from_utf8_lossy(&result.stderr).contains("metadata"),
                "{result:?}"
            );
            assert_eq!(fixture.calls().len(), 2);
        }
    }
    assert!(
        accepted.is_empty(),
        "accepted malformed metadata: {accepted:?}"
    );
}

#[test]
fn candidate_roundtrip_preserves_revision_checksum_and_digest() {
    use sha2::{Digest, Sha256};
    let fixture = Fixture::new();
    fixture.record();
    let manifest: Value =
        serde_json::from_slice(&fs::read(fixture.root.path().join("candidate.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["revision"], REVISION);
    assert_eq!(
        manifest["sha256"],
        nemoclaw_build::hex(&Sha256::digest(b"candidate archive"))
    );
    assert_eq!(manifest["image"], format!("nc-fabric@{DIGEST}"));
    success(fixture.candidate("load", REVISION));
    assert_eq!(
        fs::read_to_string(fixture.root.path().join("image-ref")).unwrap(),
        format!("nc-fabric@{DIGEST}\n")
    );
    let calls = fixture.calls();
    assert_eq!(&calls[0][..3], ["image", "load", "-i"]);
    assert_eq!(calls[1], ["image", "inspect", "nc-fabric:openclaw"]);
}

#[test]
fn candidate_identity_failures_stop_before_docker_load() {
    for failure in ["revision", "checksum", "digest"] {
        let fixture = Fixture::new();
        fixture.record();
        let revision = if failure == "revision" {
            "another-revision"
        } else {
            REVISION
        };
        if failure == "checksum" {
            fs::write(fixture.root.path().join("image.tar"), b"substituted").unwrap();
        }
        if failure == "digest" {
            let file = fixture.root.path().join("candidate.json");
            let mut manifest: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
            manifest["image"] = json!("nc-fabric:openclaw");
            fs::write(file, manifest.to_string()).unwrap();
        }
        assert!(
            !fixture.candidate("load", revision).status.success(),
            "{failure}"
        );
        assert!(fixture.calls().is_empty(), "{failure}");
        fixture.no_image_ref();
    }
}

#[test]
fn candidate_loaded_platform_and_digest_must_match() {
    for (field, wrong) in [
        ("Os", json!("windows")),
        ("Architecture", json!("arm64")),
        (
            "RepoDigests",
            json!([format!("nc-fabric@sha256:{}", "c".repeat(64))]),
        ),
    ] {
        let mut fixture = Fixture::new();
        fixture.record();
        fixture.inspection[0][field] = wrong;
        assert!(
            !fixture.candidate("load", REVISION).status.success(),
            "{field}"
        );
        assert_eq!(fixture.calls().len(), 2);
        fixture.no_image_ref();
    }
}

#[test]
fn candidate_record_rejects_non_digest_build_identity() {
    let fixture = Fixture::new();
    fs::write(
        fixture.root.path().join("metadata.json"),
        json!({"openclaw": {"containerimage.digest": "mutable-tag"}}).to_string(),
    )
    .unwrap();
    assert!(!fixture.candidate("record", REVISION).status.success());
    assert!(!fixture.root.path().join("candidate.json").exists());
}

#[test]
fn export_uses_both_installed_labels_and_reports_the_final_build_metadata() {
    let fixture = Fixture::new();
    success(
        fixture
            .images(&[
                "build",
                "--platform",
                "linux/amd64",
                "--output",
                "type=oci,dest=image.tar",
                "--metadata-file",
                "metadata.json",
                "openclaw",
            ])
            .output()
            .unwrap(),
    );
    let calls = fixture.calls();
    let export = calls
        .iter()
        .find(|args| {
            args.iter()
                .any(|arg| arg == "openclaw.output=type=oci,dest=image.tar")
        })
        .unwrap();
    let label = |name: &str| -> Value {
        let prefix = format!("openclaw.labels.{name}=");
        serde_json::from_str(
            export
                .iter()
                .find_map(|arg| arg.strip_prefix(&prefix))
                .unwrap(),
        )
        .unwrap()
    };
    assert_eq!(label("io.nemoclaw.fabric.bridge"), fixture.bridge);
    assert_eq!(label("io.nemoclaw.fabric.catalog"), fixture.catalog);
    assert!(
        export
            .windows(2)
            .any(|args| args == ["--metadata-file", "metadata.json"])
    );
    let discovery = calls
        .iter()
        .position(|args| args.iter().any(|arg| arg == "--installed"))
        .unwrap();
    let exported = calls.iter().position(|args| args == export).unwrap();
    assert!(discovery < exported);
    assert!(
        calls[discovery]
            .iter()
            .any(|arg| arg == "/opt/nemoclaw/catalog.py")
    );
    assert!(
        calls[discovery]
            .iter()
            .any(|arg| arg == "/opt/nemoclaw/provenance.json")
    );
    for args in calls.iter().filter(|args| args[0] == "run") {
        assert!(args.iter().any(|arg| arg == "--network=none"));
        assert!(args.iter().any(|arg| arg == "--read-only"));
    }
    assert_eq!(&calls.last().unwrap()[..2], ["image", "rm"]);
}

#[test]
fn export_requires_one_resolved_target_before_building() {
    for targets in [
        json!({}),
        json!({"openclaw": {"tags": ["nc-fabric:openclaw"]}, "hermes": {"tags": ["nc-fabric:hermes"]}}),
    ] {
        let fixture = Fixture::new();
        let result = fixture
            .images(&[
                "build",
                "--platform",
                "linux/amd64",
                "--output",
                "type=oci,dest=image.tar",
                "agents",
            ])
            .env("BAKE_PLAN", json!({"target": targets}).to_string())
            .output()
            .unwrap();
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("exactly one image target"));
        assert_eq!(fixture.calls().len(), 1, "must only plan, not build");
    }
}

#[test]
fn metadata_file_requires_an_export_destination() {
    let fixture = Fixture::new();
    let result = fixture
        .images(&[
            "build",
            "--platform",
            "linux/amd64",
            "--metadata-file",
            "metadata.json",
            "openclaw",
        ])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("--output"));
    assert!(fixture.calls().is_empty());
}

#[test]
fn local_build_still_tags_the_image_with_both_installed_labels() {
    let fixture = Fixture::new();
    success(
        fixture
            .images(&["build", "--platform", "linux/amd64", "openclaw"])
            .output()
            .unwrap(),
    );
    let calls = fixture.calls();
    let labeled = calls.iter().find(|args| args[0] == "build").unwrap();
    let labels: Vec<_> = labeled
        .windows(2)
        .filter(|pair| pair[0] == "--label")
        .map(|pair| pair[1].split_once('=').unwrap())
        .collect();
    for (key, expected) in [
        ("io.nemoclaw.fabric.bridge", fixture.bridge),
        ("io.nemoclaw.fabric.catalog", fixture.catalog),
    ] {
        let value = labels.iter().find(|(name, _)| *name == key).unwrap().1;
        assert_eq!(serde_json::from_str::<Value>(value).unwrap(), expected);
    }
    assert!(
        labeled
            .windows(2)
            .any(|args| args == ["--tag", "nc-fabric:openclaw"])
    );
    assert_eq!(&calls.last().unwrap()[..2], ["image", "rm"]);
}

#[test]
fn failed_export_cleans_up_only_its_temporary_image() {
    let fixture = Fixture::new();
    let result = fixture
        .images(&[
            "build",
            "--platform",
            "linux/amd64",
            "--output",
            "type=oci,dest=image.tar",
            "openclaw",
        ])
        .env("FAIL_DOCKER", "openclaw.output=")
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("export openclaw"));
    let calls = fixture.calls();
    let temporary = calls
        .iter()
        .flatten()
        .find_map(|arg| arg.strip_prefix("openclaw.tags="))
        .unwrap();
    assert_eq!(calls.last().unwrap(), &["image", "rm", temporary]);
    assert_eq!(
        calls
            .iter()
            .filter(|args| args.starts_with(&["image".into(), "rm".into()]))
            .count(),
        1
    );
}

#[test]
fn docker_load_or_inspection_failure_never_writes_image_ref() {
    for failure in ["image load", "image inspect"] {
        let fixture = Fixture::new();
        fixture.record();
        let result = fixture
            .images(&["candidate", "load"])
            .arg(fixture.root.path())
            .arg(REVISION)
            .env("FAIL_DOCKER", failure)
            .output()
            .unwrap();
        assert!(!result.status.success());
        fixture.no_image_ref();
    }
}

#[test]
fn guest_loads_with_the_transferred_rust_helper_without_a_toolchain() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let fixture = Fixture::new();
    fixture.record();
    let guest = tempfile::tempdir().unwrap();
    fs::write(guest.path().join("source-revision"), REVISION).unwrap();
    symlink(fixture.root.path(), guest.path().join("image-candidate")).unwrap();
    let helper = fixture.root.path().join("image-tool");
    fs::copy(env!("CARGO_BIN_EXE_nemoclaw-build"), &helper).unwrap();
    // Artifact downloads do not preserve executable permissions.
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o644)).unwrap();
    let mut command = Command::new("/bin/bash");
    command
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tools/e2e/brev-v1-guest.sh"))
        .arg("load-image")
        .env("NEMOCLAW_BREV_ROOT", guest.path());
    fixture.environment(&mut command);
    // No Cargo or rustc is available to the guest script.
    command.env(
        "PATH",
        std::env::join_paths([docker_bin(), Path::new("/usr/bin"), Path::new("/bin")]).unwrap(),
    );
    success(command.output().unwrap());
    assert_eq!(
        fs::read_to_string(fixture.root.path().join("image-ref")).unwrap(),
        format!("nc-fabric@{DIGEST}\n")
    );
}
