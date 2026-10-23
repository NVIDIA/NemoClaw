// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Bind a fresh assessment to saved release inputs; local evidence is not publication approval.
use super::{Assessment, AssessmentError, Status, Subject, input, policy};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Serialize)]
pub struct ReleaseEvidence {
    pub schema_version: u8,
    pub status: Status,
    pub publication_authorized: bool,
    pub release_tag: String,
    pub controller_revision: String,
    pub inventory_sha256: String,
    pub sboms_sha256: String,
    pub assessment_sha256: String,
    pub policy: policy::PolicyEvaluation,
    pub images: Vec<ReleaseImage>,
}

#[derive(Debug, Serialize)]
pub struct ReleaseImage {
    pub name: String,
    pub reference: String,
    pub subjects: Vec<ReleaseSubject>,
}

#[derive(Debug, Serialize)]
pub struct ReleaseSubject {
    pub reference: String,
    pub platform: String,
    pub sbom_asset: String,
    pub sbom_sha256: String,
}

#[derive(Debug, Serialize)]
pub struct ReleaseCatalog {
    pub candidate_revision: String,
    pub source_revision: String,
    pub agents: Vec<String>,
    pub images: Vec<String>,
}

/// Validate candidate-produced names as inert data in the trusted controller.
pub fn catalog(
    bytes: &[u8],
    candidate_revision: &str,
    source_revision: &str,
) -> Result<ReleaseCatalog, AssessmentError> {
    let value = document(bytes)?;
    if !hex(candidate_revision, 40)
        || !hex(source_revision, 40)
        || value["candidate_revision"] != candidate_revision
        || value["source_revision"] != source_revision
        || value.as_object().is_none_or(|v| v.len() != 3)
    {
        return Err(invalid(
            "candidate image catalog does not match the tag and selected source",
        ));
    }
    let names = value["agents"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 128)
        .ok_or_else(|| invalid("candidate image catalog must contain production agents"))?;
    let mut agents = BTreeSet::new();
    for name in names {
        let name = name
            .as_str()
            .ok_or_else(|| invalid("candidate image name is invalid"))?;
        if name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .next()
                .is_some_and(|v| v.is_ascii_lowercase() || v.is_ascii_digit())
            || !name
                .bytes()
                .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || v == b'-')
            || matches!(
                name,
                "dummy"
                    | "ollama-proxy"
                    | "vllm"
                    | "ollama"
                    | "supervisor"
                    | "lint"
                    | "unit-tests"
                    | "reference-tests"
                    | "proxy-tests"
            )
            || !agents.insert(name.to_string())
        {
            return Err(invalid(
                "candidate image catalog contains an unsafe, duplicate, or non-production agent",
            ));
        }
    }
    let agents: Vec<_> = agents.into_iter().collect();
    let images = agents
        .iter()
        .cloned()
        .chain(
            ["ollama-proxy", "vllm", "ollama"]
                .into_iter()
                .map(str::to_string),
        )
        .collect();
    Ok(ReleaseCatalog {
        candidate_revision: candidate_revision.into(),
        source_revision: source_revision.into(),
        agents,
        images,
    })
}

fn invalid(reason: &str) -> AssessmentError {
    AssessmentError::Input {
        reason: reason.into(),
    }
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

fn digest(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|value| hex(value, 64))
}

fn hash(bytes: &[u8]) -> String {
    crate::hex(&Sha256::digest(bytes))
}

fn document(bytes: &[u8]) -> Result<Value, AssessmentError> {
    if bytes.is_empty() || bytes.len() > 16_000_000 {
        return Err(invalid("release evidence document is empty or oversized"));
    }
    serde_json::from_slice(bytes)
        .map_err(|_| invalid("release evidence document is not valid JSON"))
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, AssessmentError> {
    value[key]
        .as_str()
        .filter(|v| !v.is_empty() && !v.chars().any(char::is_control))
        .ok_or_else(|| invalid("release evidence has a missing or invalid identity"))
}

type Inventory = (BTreeMap<String, Value>, BTreeSet<(String, String)>);

fn inventories(bytes: &[u8]) -> Result<Inventory, AssessmentError> {
    let document = document(bytes)?;
    let subjects = input::expected_subjects(&document)
        .map_err(|reason| invalid(&reason))?
        .into_keys()
        .collect();
    let entries = document
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| invalid("release inventory must contain expected images"))?;
    let mut images = BTreeMap::new();
    let mut repositories = BTreeSet::new();
    for entry in entries {
        let name = text(entry, "name")?;
        let repository = text(entry, "repository")?;
        if !name
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'-' | b'_'))
            || !repository.contains('/')
            || repository.contains('@')
            || repository.contains(':')
            || repository.bytes().any(|v| v.is_ascii_whitespace())
            || !repositories.insert(repository)
            || !digest(text(entry, "index_digest")?)
            || entry["manifests"]["manifests"]
                .as_array()
                .is_none_or(|v| v.is_empty())
            || images.insert(name.to_string(), entry.clone()).is_some()
        {
            return Err(invalid(
                "release inventory contains an invalid or duplicate image",
            ));
        }
    }
    Ok((images, subjects))
}

/// This records what a trusted controller just scanned. It is neither a signature
/// nor an approval token; the controller owns review, disclosure, and publishing.
#[allow(clippy::too_many_arguments)]
pub fn bind(
    tag: &str,
    controller_revision: &str,
    inventory: &[u8],
    mapping: &[u8],
    subjects: &[Subject],
    assessment: &Assessment,
    policy_bytes: &[u8],
    reviewed_policy_sha256: &str,
) -> Result<ReleaseEvidence, AssessmentError> {
    let Some(version) = tag.strip_prefix("v0.1.") else {
        return Err(invalid("release tag must name a v0.1 release"));
    };
    let (patch, suffix) = version.split_once('-').unwrap_or((version, ""));
    if patch.is_empty()
        || !patch.bytes().all(|v| v.is_ascii_digit())
        || (version.contains('-') && suffix.is_empty())
        || !suffix
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'.' | b'-'))
        || !hex(controller_revision, 40)
    {
        return Err(invalid("release tag or controller revision is invalid"));
    }
    if subjects.is_empty()
        || subjects.len() != assessment.subjects.len()
        || assessment.status == Status::Incomplete
        || assessment.publication_authorized
        || !assessment.problems.is_empty()
        || assessment.scanner.is_none()
        || assessment.database.is_none()
        || assessment.subjects.iter().any(|v| !v.problems.is_empty())
    {
        return Err(invalid("a release needs a complete fresh assessment"));
    }
    let (inventory_images, expected_subjects) = inventories(inventory)?;
    if expected_subjects
        != subjects
            .iter()
            .map(|v| (v.reference.clone(), v.platform.clone()))
            .collect()
    {
        return Err(invalid(
            "release inventory differs from the exact verified subject set",
        ));
    }
    let mapping_sha256 = hash(mapping);
    let mapping = document(mapping)?;
    let entries = mapping
        .as_array()
        .filter(|v| v.len() == subjects.len())
        .ok_or_else(|| invalid("release SBOM mapping does not match assessed subjects"))?;
    let mut seen = BTreeSet::new();
    let mut images = BTreeMap::<String, ReleaseImage>::new();
    for subject in subjects {
        if !seen.insert((&subject.reference, &subject.platform)) {
            return Err(invalid("release assessment contains duplicate subjects"));
        }
        let report = assessment
            .subjects
            .iter()
            .filter(|v| v.reference == subject.reference && v.platform == subject.platform)
            .collect::<Vec<_>>();
        if report.len() != 1
            || report[0].name != subject.name
            || report[0].sbom_sha256 != subject.sha256
            || report[0].sbom_asset != subject.asset
        {
            return Err(invalid(
                "release assessment differs from verified SBOM subjects",
            ));
        }
        if entries
            .iter()
            .filter(|v| {
                v["reference"] == subject.reference
                    && v["platform"] == subject.platform
                    && v["sha256"] == subject.sha256
                    && v["asset"] == subject.asset
            })
            .count()
            != 1
        {
            return Err(invalid("release SBOM mapping differs from assessed bytes"));
        }
        let image = inventory_images
            .get(&subject.name)
            .ok_or_else(|| invalid("assessed image is absent from release inventory"))?;
        let repository = text(image, "repository")?;
        let (os, architecture) = subject
            .platform
            .split_once('/')
            .ok_or_else(|| invalid("assessed platform is invalid"))?;
        let manifest_digest = subject
            .reference
            .strip_prefix(&format!("{repository}@"))
            .ok_or_else(|| invalid("assessed repository differs from release inventory"))?;
        if !image["manifests"]["manifests"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|v| {
                v["digest"] == manifest_digest
                    && v["platform"]["os"] == os
                    && v["platform"]["architecture"] == architecture
            })
        {
            return Err(invalid(
                "assessed platform digest differs from release inventory",
            ));
        }
        images
            .entry(subject.name.clone())
            .or_insert_with(|| ReleaseImage {
                name: subject.name.clone(),
                reference: format!(
                    "{repository}@{}",
                    image["index_digest"].as_str().unwrap_or_default()
                ),
                subjects: Vec::new(),
            })
            .subjects
            .push(ReleaseSubject {
                reference: subject.reference.clone(),
                platform: subject.platform.clone(),
                sbom_asset: subject.asset.clone(),
                sbom_sha256: subject.sha256.clone(),
            });
    }
    if images.len() != inventory_images.len() {
        return Err(invalid("release assessment omits an expected image"));
    }
    let policy = policy::evaluate(
        assessment,
        policy_bytes,
        reviewed_policy_sha256,
        time::OffsetDateTime::now_utc(),
    )
    .map_err(|error| invalid(&error.to_string()))?;
    let assessment_bytes = serde_json::to_vec(assessment)
        .map_err(|_| invalid("could not encode release assessment"))?;
    Ok(ReleaseEvidence {
        schema_version: 1,
        status: policy.status,
        publication_authorized: false,
        release_tag: tag.into(),
        controller_revision: controller_revision.into(),
        inventory_sha256: hash(inventory),
        sboms_sha256: mapping_sha256,
        assessment_sha256: hash(&assessment_bytes),
        policy,
        images: images.into_values().collect(),
    })
}

/// Compare fresh registry observations to the approved immutable inventory.
pub fn verify_promoted(expected: &[u8], actual: &[u8]) -> Result<(), AssessmentError> {
    let expected = inventories(expected)?;
    let actual = inventories(actual)?;
    if expected != actual {
        return Err(invalid(
            "release image indexes or platform manifests changed after assessment",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release_assessment::{DatabaseEvidence, Finding, ScannerEvidence, SubjectReport};
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

    fn fixture() -> (Vec<Subject>, Assessment, Value, Value) {
        let mut subjects = Vec::new();
        let mut reports = Vec::new();
        let mut manifests = Vec::new();
        let mut mapping = Vec::new();
        for (architecture, digest) in [("amd64", "a"), ("arm64", "b")] {
            let digest = format!("sha256:{}", digest.repeat(64));
            let reference = format!("registry.example/hermes@{digest}");
            let platform = format!("linux/{architecture}");
            let sha256 = "c".repeat(64);
            subjects.push(Subject {
                name: "hermes".into(),
                reference: reference.clone(),
                platform: platform.clone(),
                asset: format!("hermes-{architecture}.spdx.json"),
                sha256: sha256.clone(),
                sbom: b"verified SBOM snapshot".to_vec(),
            });
            reports.push(SubjectReport {
                name: "hermes".into(),
                reference: reference.clone(),
                platform: platform.clone(),
                sbom_asset: format!("hermes-{architecture}.spdx.json"),
                sbom_sha256: sha256.clone(),
                findings: vec![],
                problems: vec![],
            });
            manifests.push(
                json!({"digest":digest,"platform":{"os":"linux","architecture":architecture}}),
            );
            mapping.push(json!({"reference":reference,"platform":platform,"sha256":sha256,"asset":format!("hermes-{architecture}.spdx.json")}));
        }
        let inventory = json!([{"name":"hermes","repository":"registry.example/hermes","index_digest":format!("sha256:{}","d".repeat(64)),"manifests":{"manifests":manifests}}]);
        let assessment = Assessment {
            status: Status::Passed,
            publication_authorized: false,
            scanner: Some(ScannerEvidence {
                name: "grype".into(),
                version: "0.121.0".into(),
                sha256: "e".repeat(64),
                configuration_sha256: "f".repeat(64),
            }),
            database: Some(DatabaseEvidence {
                schema_version: "v6.1.10".into(),
                built: "2026-10-21T00:00:00Z".into(),
                sha256: "1".repeat(64),
                age_seconds: 1,
            }),
            subjects: reports,
            problems: vec![],
        };
        (subjects, assessment, inventory, json!(mapping))
    }

    #[test]
    fn candidate_catalog_is_bound_to_the_tag_and_selected_image_source() {
        let candidate = "a".repeat(40);
        let source = "b".repeat(40);
        let value = json!({"candidate_revision":candidate,"source_revision":source,"agents":["candidate-only","hermes"]});
        let bytes = serde_json::to_vec(&value).unwrap();
        let result = catalog(&bytes, &candidate, &source).unwrap();
        assert_eq!(result.agents, ["candidate-only", "hermes"]);
        assert_eq!(
            result.images,
            ["candidate-only", "hermes", "ollama-proxy", "vllm", "ollama"]
        );
        for changed in [
            {
                let mut v = value.clone();
                v["candidate_revision"] = json!("c".repeat(40));
                v
            },
            {
                let mut v = value.clone();
                v["source_revision"] = json!("d".repeat(40));
                v
            },
            {
                let mut v = value.clone();
                v["agents"] = json!([]);
                v
            },
            {
                let mut v = value.clone();
                v["agents"] = json!(["hermes", "hermes"]);
                v
            },
            {
                let mut v = value.clone();
                v["agents"] = json!(["dummy"]);
                v
            },
            {
                let mut v = value.clone();
                v["agents"] = json!(["ollama-proxy"]);
                v
            },
            {
                let mut v = value.clone();
                v["agents"] = json!(["../substituted"]);
                v
            },
            {
                let mut v = value.clone();
                v["agents"] = json!(["hermes\nextra"]);
                v
            },
        ] {
            assert!(
                catalog(&serde_json::to_vec(&changed).unwrap(), &candidate, &source).is_err(),
                "{changed}"
            );
        }
    }

    fn evidence(
        subjects: &[Subject],
        assessment: &Assessment,
        inventory: &Value,
        mapping: &Value,
    ) -> Result<ReleaseEvidence, AssessmentError> {
        let policy = br#"{"schema_version":1,"exceptions":[]}"#;
        bind(
            "v0.1.0-rc1",
            &"2".repeat(40),
            &serde_json::to_vec(inventory).unwrap(),
            &serde_json::to_vec(mapping).unwrap(),
            subjects,
            assessment,
            policy,
            &crate::hex(&Sha256::digest(policy)),
        )
    }

    #[test]
    fn a_complete_assessment_binds_the_exact_release_without_authorizing_publication() {
        let (subjects, assessment, inventory, mapping) = fixture();
        let result = evidence(&subjects, &assessment, &inventory, &mapping).unwrap();
        assert_eq!(result.status, Status::Passed);
        assert!(!result.publication_authorized);
    }

    #[test]
    fn high_findings_without_a_reviewed_exception_block_release_evidence() {
        let (subjects, mut assessment, inventory, mapping) = fixture();
        assessment.status = Status::Blocked;
        assessment.subjects[0].findings.push(Finding {
            advisory: "CVE-2026-1234".into(),
            package: "example".into(),
            version: "1.0".into(),
            purl: Some("pkg:npm/example@1.0".into()),
            severity: "High".into(),
            severity_source: None,
            ratings: vec![],
            fixed_versions: vec![],
            aliases: vec![],
        });
        let result = evidence(&subjects, &assessment, &inventory, &mapping).unwrap();
        assert_eq!(result.status, Status::Blocked);
        assert!(!result.publication_authorized);
    }

    #[test]
    fn promotion_requires_the_same_index_and_every_platform_manifest() {
        let (_, _, inventory, _) = fixture();
        let bytes = serde_json::to_vec(&inventory).unwrap();
        verify_promoted(&bytes, &bytes).unwrap();
        for changed in [
            {
                let mut v = inventory.clone();
                v[0]["index_digest"] = json!(format!("sha256:{}", "3".repeat(64)));
                v
            },
            {
                let mut v = inventory.clone();
                v[0]["manifests"]["manifests"][0]["digest"] =
                    json!(format!("sha256:{}", "4".repeat(64)));
                v
            },
            {
                let mut v = inventory.clone();
                v[0]["repository"] = json!("registry.example/substituted");
                v
            },
            {
                let mut v = inventory.clone();
                v[0]["manifests"]["manifests"].as_array_mut().unwrap().pop();
                v
            },
        ] {
            assert!(verify_promoted(&bytes, &serde_json::to_vec(&changed).unwrap()).is_err());
        }
    }

    #[test]
    fn incomplete_or_substituted_report_inputs_never_bind() {
        let (subjects, assessment, inventory, mapping) = fixture();
        let mut report = assessment.clone();
        report.subjects.pop();
        assert!(evidence(&subjects, &report, &inventory, &mapping).is_err());
        let mut report = assessment.clone();
        report.subjects[0].sbom_sha256 = "5".repeat(64);
        assert!(evidence(&subjects, &report, &inventory, &mapping).is_err());
        let mut substituted = mapping.clone();
        substituted[0]["sha256"] = json!("6".repeat(64));
        assert!(evidence(&subjects, &assessment, &inventory, &substituted).is_err());
        let mut report = assessment;
        report.status = Status::Incomplete;
        assert!(evidence(&subjects, &report, &inventory, &mapping).is_err());
    }

    #[test]
    fn release_inventory_cannot_expand_or_relabel_the_verified_subject_set() {
        let (subjects, assessment, inventory, mapping) = fixture();
        for changed in [
            {
                let mut v = inventory.clone();
                let extra = v[0]["manifests"]["manifests"][0].clone();
                v[0]["manifests"]["manifests"]
                    .as_array_mut()
                    .unwrap()
                    .push(extra);
                v
            },
            {
                let mut v = inventory.clone();
                let mut extra = v[0]["manifests"]["manifests"][0].clone();
                extra["platform"]["architecture"] = json!("arm");
                v[0]["manifests"]["manifests"]
                    .as_array_mut()
                    .unwrap()
                    .push(extra);
                v
            },
            {
                let mut v = inventory.clone();
                let mut extra = v[0]["manifests"]["manifests"][0].clone();
                extra["platform"]["os"] = json!("windows");
                v[0]["manifests"]["manifests"]
                    .as_array_mut()
                    .unwrap()
                    .push(extra);
                v
            },
            {
                let mut v = inventory.clone();
                v[0]["manifests"]["manifests"].as_array_mut().unwrap().pop();
                v
            },
        ] {
            assert!(
                evidence(&subjects, &assessment, &changed, &mapping).is_err(),
                "{changed}"
            );
            let bytes = serde_json::to_vec(&changed).unwrap();
            assert!(
                verify_promoted(&bytes, &bytes).is_err(),
                "invalid observations cannot verify themselves"
            );
        }
        for changed in [
            {
                let mut v = mapping.clone();
                v[0]["reference"] = json!(format!(
                    "registry.example/substituted@sha256:{}",
                    "a".repeat(64)
                ));
                v
            },
            {
                let mut v = mapping.clone();
                v[0]["reference"] =
                    json!(format!("registry.example/hermes@sha256:{}", "7".repeat(64)));
                v
            },
        ] {
            assert!(
                evidence(&subjects, &assessment, &inventory, &changed).is_err(),
                "{changed}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn incomplete_and_blocked_assessments_remain_available_but_cannot_publish() {
        use std::{fs, os::unix::fs::PermissionsExt, process::Command};
        let workflow: Value =
            serde_saphyr::from_str(include_str!("../../../../.github/workflows/release.yml"))
                .unwrap();
        for (job, gate_name, pass_name) in [
            (
                "security",
                "Freshly assess the exact release inputs and reviewed policy",
                "Require a passing release policy",
            ),
            (
                "publish-security-reviewed",
                "Reassess immediately before publishing",
                "Require a passing final release policy",
            ),
        ] {
            let steps = workflow["jobs"][job]["steps"].as_array().unwrap();
            let gate = steps.iter().find(|v| v["name"] == gate_name).unwrap()["run"]
                .as_str()
                .unwrap();
            let pass = steps.iter().find(|v| v["name"] == pass_name).unwrap()["run"]
                .as_str()
                .unwrap();
            for result in [0, 2, 3] {
                let root = tempfile::tempdir().unwrap();
                let bin = root.path().join("bin");
                fs::create_dir(&bin).unwrap();
                let cargo = bin.join("cargo");
                fs::write(&cargo,"#!/bin/sh\n/bin/mkdir \"$RUNNER_TEMP/security-report\"\nprintf '%s' 'retained findings' > \"$RUNNER_TEMP/security-report/assessment.json\"\nexit \"$ASSESSMENT_RESULT\"\n").unwrap();
                fs::set_permissions(cargo, fs::Permissions::from_mode(0o700)).unwrap();
                let output_file = root.path().join("outputs");
                let output = Command::new("/bin/bash")
                    .args(["-euo", "pipefail", "-c", gate])
                    .env_clear()
                    .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                    .env("RUNNER_TEMP", root.path())
                    .env("GITHUB_OUTPUT", &output_file)
                    .env("TAG", "v0.1.0")
                    .env("CONTROLLER_REVISION", "a".repeat(40))
                    .env("POLICY_SHA256", "b".repeat(64))
                    .env("ASSESSMENT_RESULT", result.to_string())
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{job}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let outputs = fs::read_to_string(output_file).unwrap();
                assert!(
                    outputs.lines().any(|v| v == "report=true"),
                    "{job}: {outputs}"
                );
                assert_eq!(
                    fs::read(root.path().join("security-report/assessment.json")).unwrap(),
                    b"retained findings"
                );
                let pass = Command::new("/bin/bash")
                    .args(["-euo", "pipefail", "-c", pass])
                    .env_clear()
                    .env("RESULT", result.to_string())
                    .output()
                    .unwrap();
                assert_eq!(
                    pass.status.success(),
                    result == 0,
                    "{job}: exit {result} cannot bypass the final gate"
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn sarif_upload_refuses_truncation_and_keeps_the_complete_local_report() {
        use std::{fs, os::unix::fs::PermissionsExt, process::Command};
        let workflow: Value =
            serde_saphyr::from_str(include_str!("../../../../.github/workflows/release.yml"))
                .unwrap();
        let script = workflow["jobs"]["security"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "Report approved findings to code scanning")
            .unwrap()["run"]
            .as_str()
            .unwrap();
        for (count, allowed) in [(5000, true), (5001, false)] {
            let root = tempfile::tempdir().unwrap();
            let bin = root.path().join("bin");
            let report = root.path().join("security-report");
            fs::create_dir(&bin).unwrap();
            fs::create_dir(&report).unwrap();
            let gh = bin.join("gh");
            fs::write(&gh,"#!/bin/sh\nprintf 'called\\n' >> \"$RUNNER_TEMP/calls\"\ncase \"$*\" in *--method*POST*) printf 'upload-id\\n' ;; *) printf 'complete\\n' ;; esac\n").unwrap();
            fs::set_permissions(gh, fs::Permissions::from_mode(0o700)).unwrap();
            let bytes =
                serde_json::to_vec(&json!({"runs":[{"results":vec![json!({});count]}]})).unwrap();
            let path = report.join("assessment.sarif");
            fs::write(&path, &bytes).unwrap();
            let output = Command::new("/bin/bash")
                .args(["-euo", "pipefail", "-c", script])
                .env_clear()
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .env("RUNNER_TEMP", root.path())
                .env("GITHUB_REPOSITORY", "fixture/repo")
                .env("CANDIDATE_REVISION", "2".repeat(40))
                .env("TAG", "v0.1.0-rc1")
                .output()
                .unwrap();
            assert_eq!(
                output.status.success(),
                allowed,
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                root.path().join("calls").exists(),
                allowed,
                "an oversized run must never reach code scanning"
            );
            assert_eq!(
                fs::read(path).unwrap(),
                bytes,
                "full evidence must not be truncated"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn protected_review_scripts_deny_missing_reviewers_self_review_and_branch_bypasses() {
        use std::{fs, os::unix::fs::PermissionsExt, process::Command};
        let workflow: Value =
            serde_saphyr::from_str(include_str!("../../../../.github/workflows/release.yml"))
                .unwrap();
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let gh = bin.join("gh");
        fs::write(&gh,"#!/bin/sh\ncase \"$*\" in *deployment-branch-policies*) /bin/cat \"$FIXTURE/policies.json\" ;; *) /bin/cat \"$FIXTURE/environment.json\" ;; esac\n").unwrap();
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o700)).unwrap();
        let protected = json!({"protection_rules":[{"type":"required_reviewers","prevent_self_review":true,"reviewers":[{"type":"Team","reviewer":{"id":1}}]}],"deployment_branch_policy":{"custom_branch_policies":true,"protected_branches":false}});
        let tags = json!({"total_count":1,"branch_policies":[{"type":"tag","name":"v0.1.*"}]});
        for job in ["security", "publish-security-reviewed"] {
            let script = workflow["jobs"][job]["steps"]
                .as_array()
                .unwrap()
                .iter()
                .find(|v| v["name"] == "Require independent review and release-tag restrictions")
                .unwrap()["run"]
                .as_str()
                .unwrap();
            for (environment, policies, allowed) in [
                (protected.clone(), tags.clone(), true),
                (
                    {
                        let mut v = protected.clone();
                        v["protection_rules"] = json!([]);
                        v
                    },
                    tags.clone(),
                    false,
                ),
                (
                    {
                        let mut v = protected.clone();
                        v["protection_rules"][0]["prevent_self_review"] = json!(false);
                        v
                    },
                    tags.clone(),
                    false,
                ),
                (
                    {
                        let mut v = protected.clone();
                        v["protection_rules"][0]["reviewers"] = json!([]);
                        v
                    },
                    tags.clone(),
                    false,
                ),
                (
                    protected.clone(),
                    json!({"total_count":1,"branch_policies":[{"type":"branch","name":"v1"}]}),
                    false,
                ),
                (
                    protected.clone(),
                    json!({"total_count":2,"branch_policies":[{"type":"tag","name":"v0.1.*"},{"type":"branch","name":"*"}]}),
                    false,
                ),
                (
                    protected.clone(),
                    json!({"total_count":1,"branch_policies":[{"type":"tag","name":"*"}]}),
                    false,
                ),
                (protected.clone(), json!({}), false),
            ] {
                fs::write(
                    root.path().join("environment.json"),
                    serde_json::to_vec(&environment).unwrap(),
                )
                .unwrap();
                fs::write(
                    root.path().join("policies.json"),
                    serde_json::to_vec(&policies).unwrap(),
                )
                .unwrap();
                let output = Command::new("/bin/bash")
                    .args(["-euo", "pipefail", "-c", script])
                    .env_clear()
                    .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                    .env("FIXTURE", root.path())
                    .env("GITHUB_REPOSITORY", "fixture/repository")
                    .env("SECURITY_ENVIRONMENT", job)
                    .output()
                    .unwrap();
                assert_eq!(
                    output.status.success(),
                    allowed,
                    "{job}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
    }
}
