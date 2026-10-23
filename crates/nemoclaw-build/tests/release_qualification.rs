// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Opt-in qualification of actual, externally selected release images.
//!
//! Set NEMOCLAW_QUALIFICATION_CONFIG to an absolute JSON configuration path,
//! and NEMOCLAW_TEST_GRYPE, NEMOCLAW_TEST_GRYPE_DB to the verified scanner and
//! prepared database. NEMOCLAW_TEST_DOCKER names the Docker
//! CLI with Buildx for read-only index observations; no workload is started.
//! The configuration names the inventory, sboms, sbom_directory,
//! exception policy, reviewed_policy_sha256, release_tag, controller_revision,
//! tool checksums, a fresh absolute output_directory, and subject expectations.
//! Each expectation has image, platform, and packages; each package has family
//! (os, fabric_python, node, supervisor_rust, or proxy_rust), name, version,
//! purl, and source_path as observed independently in the selected image.
//! This test observes registry indexes and reads saved staging assets; it does
//! not run workloads, update the database, upload reports, or publish anything.

use nemoclaw_build::release_qualification::{Family, Package, SubjectExpectation, package_matches};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    inventory: PathBuf,
    sboms: PathBuf,
    sbom_directory: PathBuf,
    exceptions: PathBuf,
    reviewed_policy_sha256: String,
    release_tag: String,
    controller_revision: String,
    grype_sha256: String,
    output_directory: PathBuf,
    expectations: Vec<SubjectExpectation>,
}

fn bytes(path: &Path) -> Vec<u8> {
    let mut data = Vec::new();
    fs::File::open(path)
        .expect("qualification input unavailable")
        .take(16_000_001)
        .read_to_end(&mut data)
        .expect("qualification input cannot be read");
    assert!(
        !data.is_empty() && data.len() <= 16_000_000,
        "qualification input empty or oversized"
    );
    data
}

fn value(path: &Path) -> Value {
    serde_json::from_slice(&bytes(path)).expect("qualification input is not JSON")
}

fn hash(data: &[u8]) -> String {
    nemoclaw_build::hex(&Sha256::digest(data))
}

fn file_hash(path: &Path) -> String {
    let mut file = fs::File::open(path).expect("qualification tool unavailable");
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 << 10];
    loop {
        let count = file
            .read(&mut buffer)
            .expect("qualification tool cannot be read");
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    nemoclaw_build::hex(&digest.finalize())
}

fn environment_path(name: &str) -> PathBuf {
    let path = PathBuf::from(
        std::env::var_os(name)
            .unwrap_or_else(|| panic!("set {name} before running actual-image qualification")),
    );
    assert!(path.is_absolute(), "qualification paths must be absolute");
    path
}

fn tool_version(path: &Path, expected: &str) {
    let output = Command::new(path)
        .env_clear()
        .args(["version", "-o", "json"])
        .output()
        .expect("qualification tool cannot start");
    assert!(
        output.status.success(),
        "qualification tool version check failed"
    );
    let document: Value =
        serde_json::from_slice(&output.stdout).expect("qualification tool version is not JSON");
    assert_eq!(
        document["version"], expected,
        "qualification tool version mismatch"
    );
}

fn run(command: &mut Command, directory: &Path, name: &str) -> ExitStatus {
    command
        .stdin(Stdio::null())
        .stdout(
            fs::File::create(directory.join(format!("{name}.stdout")))
                .expect("cannot capture private qualification output"),
        )
        .stderr(
            fs::File::create(directory.join(format!("{name}.stderr")))
                .expect("cannot capture private qualification diagnostic"),
        )
        .status()
        .expect("qualification process could not start")
}

fn expected_subjects(config: &Configuration, inventory: &Value) {
    let mut subjects = BTreeSet::new();
    for image in inventory
        .as_array()
        .expect("qualification inventory must list images")
    {
        let name = image["name"]
            .as_str()
            .expect("qualification image needs a name");
        assert!(
            !name.is_empty()
                && name
                    .bytes()
                    .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || v == b'-'),
            "qualification image name is invalid"
        );
        assert_eq!(
            image["repository"],
            format!("ghcr.io/nvidia/nemoclaw/v1/{name}"),
            "qualification requires the intended v1 release repository"
        );
        assert!(
            image["index_digest"]
                .as_str()
                .is_some_and(|v| v.starts_with("sha256:") && v.len() == 71),
            "qualification inventory requires index digests"
        );
        for manifest in image["manifests"]["manifests"]
            .as_array()
            .expect("qualification inventory lacks platforms")
        {
            if manifest["platform"]["os"] == "linux" {
                subjects.insert((
                    image["name"].as_str().unwrap().to_owned(),
                    format!(
                        "linux/{}",
                        manifest["platform"]["architecture"].as_str().unwrap()
                    ),
                ));
            }
        }
    }
    let mut covered = BTreeSet::new();
    let mut families = BTreeSet::new();
    for expected in &config.expectations {
        assert!(
            covered.insert((expected.image.clone(), expected.platform.clone())),
            "qualification expectation repeats a subject"
        );
        assert!(
            !expected.packages.is_empty(),
            "each actual subject needs independent package expectations"
        );
        families.extend(
            expected
                .packages
                .iter()
                .map(|p| (expected.platform.as_str(), p.family)),
        );
    }
    assert_eq!(
        covered, subjects,
        "qualification must describe every selected image/platform"
    );
    for platform in ["linux/amd64", "linux/arm64"] {
        assert!(
            [
                Family::Os,
                Family::FabricPython,
                Family::Node,
                Family::SupervisorRust
            ]
            .into_iter()
            .all(|family| families.contains(&(platform, family))),
            "qualification must include the four release-content coverage dimensions on both platforms"
        );
    }
}

fn gate(
    config: &Configuration,
    inventory: &Path,
    mapping: &Path,
    sboms: &Path,
    grype: &Path,
    database: &Path,
    output: &Path,
) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"));
    command
        .arg("release-gate")
        .arg("--inventory")
        .arg(inventory)
        .arg("--sboms")
        .arg(mapping)
        .arg("--sbom-directory")
        .arg(sboms)
        .arg("--grype")
        .arg(grype)
        .arg("--database")
        .arg(database)
        .args(["--max-db-age-hours", "24", "--release-tag"])
        .arg(&config.release_tag)
        .arg("--controller-revision")
        .arg(&config.controller_revision)
        .arg("--exceptions")
        .arg(&config.exceptions)
        .arg("--reviewed-policy-sha256")
        .arg(&config.reviewed_policy_sha256)
        .arg("--output-directory")
        .arg(output);
    command
}

#[test]
#[ignore = "reads actual release registry images; requires explicit qualification config, verified tools, and prepared database"]
fn actual_release_images_preserve_reviewed_package_coverage_and_gate_binding() {
    let config: Configuration =
        serde_json::from_slice(&bytes(&environment_path("NEMOCLAW_QUALIFICATION_CONFIG")))
            .expect("invalid qualification configuration");
    assert!(
        config.inventory.is_absolute()
            && config.sboms.is_absolute()
            && config.sbom_directory.is_absolute()
            && config.exceptions.is_absolute()
            && config.output_directory.is_absolute(),
        "qualification configuration paths must be absolute"
    );
    assert!(
        !config.output_directory.exists(),
        "qualification output must be fresh"
    );
    let inventory = value(&config.inventory);
    expected_subjects(&config, &inventory);
    assert_eq!(
        hash(&bytes(&config.exceptions)),
        config.reviewed_policy_sha256,
        "qualification policy checksum mismatch"
    );
    let grype = environment_path("NEMOCLAW_TEST_GRYPE");
    let database = environment_path("NEMOCLAW_TEST_GRYPE_DB");
    let docker = environment_path("NEMOCLAW_TEST_DOCKER");
    assert_eq!(
        file_hash(&grype),
        config.grype_sha256,
        "qualification Grype checksum mismatch"
    );
    tool_version(&grype, "0.121.0");
    let private = tempfile::tempdir_in(config.output_directory.parent().unwrap())
        .expect("cannot create private qualification directory");
    fs::rename(private.path(), &config.output_directory)
        .expect("cannot expose private qualification directory");
    let root = &config.output_directory;
    for image in inventory.as_array().unwrap() {
        let name = image["name"].as_str().unwrap();
        let reference = format!(
            "{}@{}",
            image["repository"].as_str().unwrap(),
            image["index_digest"].as_str().unwrap()
        );
        let mut digest = Command::new(&docker);
        digest.args([
            "buildx",
            "imagetools",
            "inspect",
            &reference,
            "--format",
            "{{.Manifest.Digest}}",
        ]);
        assert!(
            run(&mut digest, root, &format!("index-{name}-digest")).success(),
            "actual release index digest observation failed; inspect private evidence"
        );
        assert_eq!(
            String::from_utf8(bytes(&root.join(format!("index-{name}-digest.stdout"))))
                .unwrap()
                .trim(),
            image["index_digest"].as_str().unwrap(),
            "actual release index digest differs from the selected inventory"
        );
        let mut index = Command::new(&docker);
        index.args(["buildx", "imagetools", "inspect", &reference, "--raw"]);
        assert!(
            run(&mut index, root, &format!("index-{name}-body")).success(),
            "actual release index observation failed; inspect private evidence"
        );
        assert!(
            value(&root.join(format!("index-{name}-body.stdout"))) == image["manifests"],
            "actual release index platform descriptors differ from the selected inventory"
        );
    }
    let sboms = &config.sbom_directory;
    let mapping_path = &config.sboms;
    let mapping = value(mapping_path);
    let expectations = root.join("package-expectations.json");
    fs::write(
        &expectations,
        serde_json::to_vec(&config.expectations).unwrap(),
    )
    .unwrap();
    let coverage = root.join("package-coverage.json");
    let mut qualify = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"));
    qualify
        .arg("release-qualify")
        .arg("--inventory")
        .arg(&config.inventory)
        .arg("--sboms")
        .arg(mapping_path)
        .arg("--sbom-directory")
        .arg(sboms)
        .arg("--expectations")
        .arg(&expectations)
        .arg("--output")
        .arg(&coverage);
    assert!(
        run(&mut qualify, root, "qualify").success(),
        "actual representative coverage is incomplete; inspect private evidence"
    );
    let coverage = value(&coverage);
    assert_eq!(coverage["representative_coverage_verified"], true);
    assert_eq!(coverage["publication_authorized"], false);
    assert_eq!(
        coverage["inventory_sha256"],
        hash(&bytes(&config.inventory))
    );
    assert_eq!(coverage["sboms_sha256"], hash(&bytes(mapping_path)));
    assert_eq!(coverage["expectations_sha256"], hash(&bytes(&expectations)));
    let output = root.join("gate");
    let status = run(
        &mut gate(
            &config,
            &config.inventory,
            mapping_path,
            sboms,
            &grype,
            &database,
            &output,
        ),
        root,
        "gate",
    );
    assert!(
        matches!(status.code(), Some(0 | 2)),
        "actual assessment incomplete; inspect private evidence"
    );
    let receipt = value(&output.join("gate.json"));
    assert_eq!(receipt["publication_authorized"], false);
    assert_eq!(receipt["release_tag"], config.release_tag);
    assert_eq!(receipt["controller_revision"], config.controller_revision);
    assert_eq!(receipt["inventory_sha256"], hash(&bytes(&config.inventory)));
    assert_eq!(receipt["sboms_sha256"], hash(&bytes(mapping_path)));
    assert_eq!(
        receipt["assessment_sha256"],
        hash(&bytes(&output.join("assessment.json")))
    );
    assert_eq!(
        receipt["policy"]["policy_sha256"],
        config.reviewed_policy_sha256
    );
    let assessment = value(&output.join("assessment.json"));
    assert!(assessment["problems"].as_array().unwrap().is_empty());
    assert_eq!(
        assessment["subjects"].as_array().unwrap().len(),
        config.expectations.len()
    );
    for entry in mapping.as_array().unwrap() {
        let report: Vec<_> = assessment["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|s| {
                s["reference"] == entry["reference"]
                    && s["platform"] == entry["platform"]
                    && s["sbom_sha256"] == entry["sha256"]
            })
            .collect();
        assert_eq!(
            report.len(),
            1,
            "actual assessment substituted an image/platform/inventory"
        );
        assert!(report[0]["problems"].as_array().unwrap().is_empty());
    }
    let sarif = value(&output.join("assessment.sarif"));
    assert_eq!(sarif["version"], "2.1.0");
    assert_eq!(
        sarif["runs"][0]["invocations"][0]["executionSuccessful"],
        true
    );
    assert_eq!(
        sarif["runs"][0]["results"].as_array().unwrap().len(),
        assessment["subjects"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["findings"].as_array().unwrap().len())
            .sum::<usize>()
    );
    for case in ["checksum", "digest"] {
        let mut input = inventory.clone();
        let mut map = mapping.clone();
        if case == "checksum" {
            map[0]["sha256"] = json!("0".repeat(64));
        } else {
            input[0]["manifests"]["manifests"][0]["digest"] =
                json!(format!("sha256:{}", "0".repeat(64)));
        }
        let altered_inventory = root.join(format!("negative-{case}-inventory.json"));
        let altered_mapping = root.join(format!("negative-{case}-sboms.json"));
        fs::write(&altered_inventory, serde_json::to_vec(&input).unwrap()).unwrap();
        fs::write(&altered_mapping, serde_json::to_vec(&map).unwrap()).unwrap();
        let denied = root.join(format!("negative-{case}-gate"));
        let status = run(
            &mut gate(
                &config,
                &altered_inventory,
                &altered_mapping,
                sboms,
                &root.join("must-not-run"),
                &database,
                &denied,
            ),
            root,
            &format!("negative-{case}"),
        );
        assert_eq!(
            status.code(),
            Some(3),
            "substituted actual release evidence was accepted"
        );
        assert!(
            !denied.join("gate.json").exists(),
            "substitution produced a release receipt"
        );
        assert_eq!(
            value(&denied.join("assessment.json"))["problems"][0]["category"],
            "input"
        );
    }
    let summary = json!({"schema_version":1,"actual_registry_images":true,"publication_authorized":false,"release_tag":config.release_tag,"controller_revision":config.controller_revision,"tested_binary_sha256":file_hash(Path::new(env!("CARGO_BIN_EXE_nemoclaw-build"))),"grype_sha256":config.grype_sha256,"docker_cli_sha256":file_hash(&docker),"platform_subjects":config.expectations.len(),"status":receipt["status"],"limits":["No workload execution or exploitability qualification","No registry visibility, hosted approval, or code-scanning ingestion qualification","Caller supplies saved staging assets, independent package expectations and approved policy identity"]});
    fs::write(
        root.join("qualification-summary.json"),
        serde_json::to_vec_pretty(&summary).unwrap(),
    )
    .unwrap();
}

#[test]
fn representative_package_coverage_requires_version_locator_and_expected_source() {
    let expected = Package {
        family: Family::FabricPython,
        name: "nvidia-nemo-fabric".into(),
        version: "1.2.3".into(),
        purl: "pkg:pypi/nvidia-nemo-fabric@1.2.3".into(),
        source_path:
            "/opt/fabric/lib/python3.14/site-packages/nvidia_nemo_fabric.dist-info/METADATA".into(),
    };
    let package = json!({"name":expected.name,"versionInfo":expected.version,"externalRefs":[{"referenceType":"purl","referenceLocator":expected.purl}],"sourceInfo":format!("acquired package info from installed python package manifest file: {}", expected.source_path)});
    assert!(package_matches(&package, &expected));
    let mut multiple_sources = package.clone();
    multiple_sources["sourceInfo"] = json!(format!(
        "acquired package info from installed python package manifest file: {}, /opt/fabric/another/RECORD",
        expected.source_path
    ));
    assert!(package_matches(&multiple_sources, &expected));
    for changed in [
        json!({"name":expected.name}),
        json!({"name":expected.name,"versionInfo":"0.0.0"}),
        json!({"name":expected.name,"versionInfo":expected.version,"externalRefs":package["externalRefs"],"sourceInfo":"acquired package info from installed python package manifest file: /tmp/unrelated/METADATA"}),
    ] {
        assert!(!package_matches(&changed, &expected));
    }
}
