// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde_json::Value;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{fs, path::Path, process::Command};

#[test]
fn unavailable_inventory_returns_an_incomplete_json_assessment() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .args(["release-assess", "--inventory"])
        .arg(root.path().join("missing-inventory.json"))
        .arg("--sboms")
        .arg(root.path().join("sboms.json"))
        .arg("--sbom-directory")
        .arg(root.path())
        .arg("--grype")
        .arg(root.path().join("must-not-run"))
        .arg("--database")
        .arg(root.path().join("db"))
        .args(["--max-db-age-hours", "24", "--format", "json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["status"], "incomplete");
    assert_eq!(report["publication_authorized"], false);
    assert!(!report["problems"].as_array().unwrap().is_empty());
    assert_eq!(report["problems"][0]["category"], "input");
}

#[test]
fn release_gate_keeps_input_failures_private_and_never_writes_a_passing_receipt() {
    let root = tempfile::tempdir().unwrap();
    let evidence = root.path().join("evidence");
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .args(["release-gate", "--inventory"])
        .arg(root.path().join("missing-inventory.json"))
        .arg("--sboms")
        .arg(root.path().join("sboms.json"))
        .arg("--sbom-directory")
        .arg(root.path())
        .arg("--grype")
        .arg(root.path().join("must-not-run"))
        .arg("--database")
        .arg(root.path().join("db"))
        .args([
            "--max-db-age-hours",
            "24",
            "--release-tag",
            "v0.1.0-rc1",
            "--controller-revision",
        ])
        .arg("a".repeat(40))
        .arg("--exceptions")
        .arg(root.path().join("exceptions.json"))
        .arg("--reviewed-policy-sha256")
        .arg("b".repeat(64))
        .arg("--output-directory")
        .arg(&evidence)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(3),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let summary: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(summary["status"], "incomplete");
    assert_eq!(summary["publication_authorized"], false);
    assert!(!String::from_utf8_lossy(&output.stdout).contains("missing-inventory"));
    let assessment: Value =
        serde_json::from_slice(&fs::read(evidence.join("assessment.json")).unwrap()).unwrap();
    assert_eq!(assessment["status"], "incomplete");
    assert!(!evidence.join("gate.json").exists());
}

#[test]
fn monitoring_an_explicitly_empty_support_list_emits_an_empty_matrix() {
    let root = tempfile::tempdir().unwrap();
    let manifest = root.path().join("supported.json");
    fs::write(&manifest, br#"{"schema_version":1,"releases":[]}"#).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
        .args(["release-monitor-plan", "--supported"])
        .arg(&manifest)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap(),
        json!({"include":[]})
    );
}

fn image_blob(root: &Path, bytes: &[u8], media_type: &str) -> Value {
    let hash = nemoclaw_build::hex(&Sha256::digest(bytes));
    fs::write(root.join("blobs/sha256").join(&hash), bytes).unwrap();
    json!({"mediaType":media_type,"digest":format!("sha256:{hash}"),"size":bytes.len()})
}

/// Metadata-only OCI images exercise image catalogers without starting a workload.
fn fixture_image(root: &Path, variant: &str) -> Value {
    let fixed = variant != "vulnerable";
    let files = if variant == "safe" {
        vec![("Cargo.lock", "version = 3\n[[package]]\nname = \"nemoclaw-scan-contract-fixture\"\nversion = \"1.0.0\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n".into())]
    } else {
        let (npm, python, rust, deb) = if fixed {
            ("4.17.21", "1.26.5", "1.5.5", "3.0.13-1~deb12u1")
        } else {
            ("4.17.20", "1.26.4", "1.5.4", "3.0.11-1~deb12u2")
        };
        vec![
            (
                "node_modules/lodash/package.json",
                json!({"name":"lodash","version":npm,"license":"MIT"}).to_string(),
            ),
            (
                "site-packages/urllib3.dist-info/METADATA",
                format!("Metadata-Version: 2.1\nName: urllib3\nVersion: {python}\n"),
            ),
            (
                "Cargo.lock",
                format!(
                    "version = 3\n[[package]]\nname = \"regex\"\nversion = \"{rust}\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n"
                ),
            ),
            (
                "etc/os-release",
                "ID=debian\nVERSION_ID=12\nVERSION_CODENAME=bookworm\n".into(),
            ),
            (
                "var/lib/dpkg/status",
                format!(
                    "Package: openssl\nStatus: install ok installed\nArchitecture: amd64\nSource: openssl\nVersion: {deb}\nDescription: Metadata-only fixture\n\n"
                ),
            ),
        ]
    };
    let mut layer = tar::Builder::new(Vec::new());
    for (name, contents) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o444);
        header.set_uid(10001);
        header.set_gid(10001);
        header.set_mtime(0);
        header.set_cksum();
        layer
            .append_data(&mut header, name, contents.as_bytes())
            .unwrap();
    }
    layer.finish().unwrap();
    fs::create_dir_all(root.join("blobs/sha256")).unwrap();
    let layer = image_blob(
        root,
        &layer.into_inner().unwrap(),
        "application/vnd.oci.image.layer.v1.tar",
    );
    let manifests: Vec<_> = ["amd64", "arm64"].into_iter().map(|architecture| {
        let config = image_blob(root, &serde_json::to_vec(&json!({"architecture":architecture,"os":"linux","config":{},"rootfs":{"type":"layers","diff_ids":[layer["digest"]]}})).unwrap(), "application/vnd.oci.image.config.v1+json");
        let mut manifest = image_blob(root, &serde_json::to_vec(&json!({"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":config,"layers":[layer]})).unwrap(), "application/vnd.oci.image.manifest.v1+json");
        manifest["platform"] = json!({"os":"linux","architecture":architecture});
        manifest
    }).collect();
    let index = json!({"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":manifests});
    fs::write(root.join("index.json"), serde_json::to_vec(&index).unwrap()).unwrap();
    fs::write(
        root.join("oci-layout"),
        br#"{"imageLayoutVersion":"1.0.0"}"#,
    )
    .unwrap();
    index
}

#[test]
#[ignore = "requires verified Syft 1.55.0, Grype 0.121.0, and a prepared advisory database"]
fn real_image_catalogs_retain_four_ecosystems_and_targeted_fixes() {
    let syft = std::env::var("NEMOCLAW_TEST_SYFT").unwrap();
    let grype = std::env::var("NEMOCLAW_TEST_GRYPE").unwrap();
    let database = std::env::var("NEMOCLAW_TEST_GRYPE_DB").unwrap();
    let version = Command::new(&syft)
        .env_clear()
        .args(["version", "-o", "json"])
        .output()
        .unwrap();
    assert!(version.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&version.stdout).unwrap()["version"],
        "1.55.0"
    );
    let root = tempfile::tempdir().unwrap();
    let mut reports = Vec::new();
    let exceptions = root.path().join("exceptions.json");
    let policy = br#"{"schema_version":1,"exceptions":[]}"#;
    fs::write(&exceptions, policy).unwrap();
    let policy_sha256 = nemoclaw_build::hex(&Sha256::digest(policy));
    for variant in ["vulnerable", "fixed", "safe"] {
        let image = root.path().join(variant);
        let index = fixture_image(&image, variant);
        let index_digest = format!(
            "sha256:{}",
            nemoclaw_build::hex(&Sha256::digest(fs::read(image.join("index.json")).unwrap()))
        );
        let repository = format!("fixture.invalid/candidates/{variant}");
        let mut mapping = Vec::new();
        for manifest in index["manifests"].as_array().unwrap() {
            let architecture = manifest["platform"]["architecture"].as_str().unwrap();
            let platform = format!("linux/{architecture}");
            let asset = format!("{variant}-{architecture}.spdx.json");
            let spdx = root.path().join(&asset);
            let output = Command::new(&syft)
                .env_clear()
                .env("SYFT_CHECK_FOR_APP_UPDATE", "false")
                .arg(format!("oci-dir:{}", image.display()))
                .args([
                    "--platform",
                    &platform,
                    "--select-catalogers",
                    "+rust-cargo-lock-cataloger",
                    "-o",
                ])
                .arg(format!("spdx-json={}", spdx.display()))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "Syft failed for {variant}/{architecture}"
            );
            let digest = manifest["digest"].as_str().unwrap();
            mapping.push(json!({"reference":format!("{repository}@{digest}"),"platform":platform,"asset":asset,"sha256":nemoclaw_build::hex(&Sha256::digest(fs::read(&spdx).unwrap()))}));
        }
        let inventory = root.path().join("inventory.json");
        let sboms = root.path().join("sboms.json");
        fs::write(
            &inventory,
            serde_json::to_vec(
                &json!([{"name":variant,"repository":repository,"index_digest":index_digest,"manifests":index}]),
            )
            .unwrap(),
        )
        .unwrap();
        fs::write(&sboms, serde_json::to_vec(&mapping).unwrap()).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
            .arg("release-assess")
            .arg("--inventory")
            .arg(&inventory)
            .arg("--sboms")
            .arg(&sboms)
            .arg("--sbom-directory")
            .arg(root.path())
            .arg("--grype")
            .arg(&grype)
            .arg("--database")
            .arg(&database)
            .args(["--max-db-age-hours", "24", "--format", "json"])
            .output()
            .unwrap();
        let report: Value = serde_json::from_slice(&output.stdout).unwrap();
        match variant {
            "safe" => assert_eq!(output.status.code(), Some(0), "{report}"),
            "vulnerable" => assert_eq!(output.status.code(), Some(2), "{report}"),
            _ => assert!(matches!(output.status.code(), Some(0 | 2)), "{report}"),
        }
        assert_eq!(report["publication_authorized"], false);
        assert!(report["problems"].as_array().unwrap().is_empty());
        let gate_directory = root.path().join(format!("{variant}-gate"));
        let gate = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
            .arg("release-gate")
            .arg("--inventory")
            .arg(&inventory)
            .arg("--sboms")
            .arg(&sboms)
            .arg("--sbom-directory")
            .arg(root.path())
            .arg("--grype")
            .arg(&grype)
            .arg("--database")
            .arg(&database)
            .args([
                "--max-db-age-hours",
                "24",
                "--release-tag",
                "v0.1.0-rc1",
                "--controller-revision",
            ])
            .arg("a".repeat(40))
            .arg("--exceptions")
            .arg(&exceptions)
            .arg("--reviewed-policy-sha256")
            .arg(&policy_sha256)
            .arg("--output-directory")
            .arg(&gate_directory)
            .output()
            .unwrap();
        assert_eq!(
            gate.status.code(),
            output.status.code(),
            "{}",
            String::from_utf8_lossy(&gate.stderr)
        );
        let receipt: Value =
            serde_json::from_slice(&fs::read(gate_directory.join("gate.json")).unwrap()).unwrap();
        assert_eq!(receipt["publication_authorized"], false);
        assert_eq!(
            receipt["assessment_sha256"],
            nemoclaw_build::hex(&Sha256::digest(
                fs::read(gate_directory.join("assessment.json")).unwrap()
            ))
        );
        assert_eq!(
            receipt["inventory_sha256"],
            nemoclaw_build::hex(&Sha256::digest(fs::read(&inventory).unwrap()))
        );
        assert_eq!(
            receipt["sboms_sha256"],
            nemoclaw_build::hex(&Sha256::digest(fs::read(&sboms).unwrap()))
        );
        assert_eq!(receipt["policy"]["policy_sha256"], policy_sha256);
        let sarif: Value =
            serde_json::from_slice(&fs::read(gate_directory.join("assessment.sarif")).unwrap())
                .unwrap();
        assert_eq!(
            sarif["runs"][0]["invocations"][0]["executionSuccessful"],
            true
        );
        assert_eq!(
            sarif["runs"][0]["results"].as_array().unwrap().len(),
            report["subjects"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s["findings"].as_array().unwrap().len())
                .sum::<usize>()
        );
        reports.push(report);
    }
    let targets = [
        ("lodash", "CVE-2021-23337"),
        ("urllib3", "CVE-2021-33503"),
        ("regex", "CVE-2022-24713"),
        ("openssl", "CVE-2023-5678"),
    ];
    for (index, report) in reports[..2].iter().enumerate() {
        for subject in report["subjects"].as_array().unwrap() {
            for (package, advisory) in targets {
                let found = subject["findings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|finding| {
                        finding["package"] == package
                            && (finding["advisory"] == advisory
                                || finding["aliases"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .any(|alias| alias == advisory))
                    });
                assert_eq!(found, index == 0, "{package}/{advisory} in {subject}");
            }
        }
    }
}
