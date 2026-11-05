// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Local SARIF reports for assessed image inventories.
use super::{Assessment, Finding, Status, SubjectReport};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

fn plain(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if character.is_control()
            || matches!(character, '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        {
            output.extend(character.escape_default());
        } else {
            output.push(character);
        }
    }
    output
}

fn usable_asset(asset: &str) -> bool {
    asset.ends_with(".spdx.json")
        && asset
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn rule_id(advisory: &str) -> String {
    format!(
        "image-vulnerability/{}",
        crate::hex(&Sha256::digest(advisory.as_bytes()))
    )
}

fn fingerprint(subject: &SubjectReport, finding: &Finding) -> String {
    let mut hash = Sha256::new();
    for part in [
        subject.reference.as_str(),
        subject.platform.as_str(),
        finding.package.as_str(),
        finding.version.as_str(),
        finding.purl.as_deref().unwrap_or_default(),
        finding.advisory.as_str(),
    ] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    crate::hex(&hash.finalize())
}

/// Code scanning keeps 5,000 results per run, and a release has thousands of
/// lower-severity findings; those stay in the assessment document.
fn reported(finding: &Finding) -> bool {
    !matches!(
        finding.severity.as_str(),
        "Medium" | "Low" | "Negligible" | "Unknown"
    )
}
fn image(subject: &SubjectReport) -> Value {
    json!({"name":subject.name,"reference":subject.reference,"platform":subject.platform,"sbom_asset":subject.sbom_asset,"sbom_sha256":subject.sbom_sha256})
}

/// Generate a report without uploading it or authorizing disclosure.
pub fn document(assessment: &Assessment) -> Value {
    let mut subjects: Vec<_> = assessment.subjects.iter().collect();
    subjects.sort_by_key(|subject| (&subject.reference, &subject.platform, &subject.sbom_asset));
    let mut notifications: Vec<_> = assessment
        .problems
        .iter()
        .map(|problem| json!({"level":"error", "message":{"text":plain(&problem.to_string())}, "properties":{"problem":problem}}))
        .collect();
    let advisories: BTreeSet<_> = assessment
        .subjects
        .iter()
        .flat_map(|subject| {
            subject
                .findings
                .iter()
                .filter(|finding| reported(finding))
                .map(|finding| finding.advisory.as_str())
        })
        .collect();
    let rules: Vec<_> = advisories.into_iter().map(|advisory| json!({
        "id":rule_id(advisory),
        "shortDescription":{"text":format!("Known package vulnerability {}",plain(advisory)).chars().take(1024).collect::<String>()},
        "properties":{"tags":["security"],"advisory":advisory}
    })).collect();
    let artifacts: Vec<_> = subjects
        .iter()
        .map(|subject| {
            let mut artifact = json!({
                "hashes":{"sha-256":subject.sbom_sha256},
                "mimeType":"application/spdx+json",
                "roles":["analysisTarget"]
            });
            if usable_asset(&subject.sbom_asset) {
                artifact["location"] = json!({"uri":subject.sbom_asset});
            }
            artifact
        })
        .collect();
    let mut results = Vec::new();
    for (index, subject) in subjects.into_iter().enumerate() {
        notifications.extend(subject.problems.iter().map(|problem| {
            json!({
                "level":"error", "message":{"text":plain(&problem.to_string())},
                "properties":{"image":image(subject),"problem":problem}
            })
        }));
        let asset_valid = usable_asset(&subject.sbom_asset);
        if !asset_valid {
            notifications.push(json!({
                "level":"error", "message":{"text":"The saved SPDX artifact name is invalid; its physical location cannot be reported safely."},
                "properties":{"image":image(subject)}
            }));
        }
        for finding in subject.findings.iter().filter(|finding| reported(finding)) {
            let (level, kind) = match finding.severity.as_str() {
                "Critical" | "High" => ("error", "fail"),
                _ => {
                    notifications.push(json!({
                        "level":"error", "message":{"text":"A finding has unknown or unsupported severity; review is required."},
                        "properties":{"image":image(subject),"advisory":finding.advisory,"severity":finding.severity}
                    }));
                    ("warning", "review")
                }
            };
            let identity = fingerprint(subject, finding);
            let mut location = json!({"logicalLocations":[{"name":plain(&finding.package),"fullyQualifiedName":plain(finding.purl.as_deref().unwrap_or(&finding.package)),"kind":"package"}]});
            if asset_valid {
                location["physicalLocation"] =
                    json!({"artifactLocation":{"uri":subject.sbom_asset,"index":index}});
            }
            results.push(json!({
                "ruleId":rule_id(&finding.advisory),
                "level":level,
                "kind":kind,
                "message":{"text":plain(&format!("{} affects {}@{} ({}) in {} ({}).",finding.advisory,finding.package,finding.version,finding.severity,subject.reference,subject.platform))},
                "locations":[location],
                "partialFingerprints":{"primaryLocationLineHash":identity,"imageFinding/v1":identity},
                "properties":{
                    "image":image(subject),
                    "package":{"name":finding.package,"version":finding.version,"purl":finding.purl},
                    "advisory":finding.advisory,"severity":finding.severity,"severity_source":finding.severity_source,
                    "ratings":finding.ratings,"fixed_versions":finding.fixed_versions,"aliases":finding.aliases
                }
            }));
        }
    }
    results.sort_by_cached_key(|result| {
        result["partialFingerprints"]["primaryLocationLineHash"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    });
    if assessment.status == Status::Incomplete && notifications.is_empty() {
        notifications.push(json!({"level":"error", "message":{"text":"Assessment evidence is incomplete; absence of results does not establish a clean scan."}}));
    }
    notifications.sort_by_cached_key(Value::to_string);
    let successful = assessment.status != Status::Incomplete && notifications.is_empty();
    json!({
        "$schema":"https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
        "version":"2.1.0",
        "runs":[{
            "tool":{"driver":{"name":"NemoClaw image assessment","version":env!("CARGO_PKG_VERSION"),"rules":rules}},
            "invocations":[{"executionSuccessful":successful,
                "toolExecutionNotifications":notifications}],
            "artifacts":artifacts,
            "results":results,
            "properties":{"status":assessment.status,"publication_authorized":false,"scanner":assessment.scanner,"database":assessment.database}
        }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release_assessment::{
        AssessmentError, DatabaseEvidence, Finding, ScanOperation, ScannerEvidence, SubjectReport,
    };

    fn assessment() -> Assessment {
        Assessment {
            status: Status::Blocked,
            publication_authorized: false,
            scanner: Some(ScannerEvidence {
                name: "grype".into(),
                version: "0.121.0".into(),
                sha256: "a".repeat(64),
                configuration_sha256: "b".repeat(64),
            }),
            database: Some(DatabaseEvidence {
                schema_version: "v6.1.10".into(),
                built: "2026-10-21T00:00:00Z".into(),
                sha256: "c".repeat(64),
                age_seconds: 3600,
            }),
            subjects: vec![SubjectReport {
                name: "hermes".into(),
                reference: format!("fixture.invalid/hermes@sha256:{}", "d".repeat(64)),
                platform: "linux/amd64".into(),
                sbom_asset: "hermes-amd64.spdx.json".into(),
                sbom_sha256: "e".repeat(64),
                findings: vec![Finding {
                    advisory: "CVE-2026-12345".into(),
                    package: "example-package".into(),
                    version: "1.0.0".into(),
                    purl: Some("pkg:npm/example-package@1.0.0".into()),
                    severity: "High".into(),
                    severity_source: Some("https://advisories.example/CVE-2026-12345".into()),
                    ratings: vec![
                        json!({"advisory":"CVE-2026-12345", "source":"upstream", "cvss":[{"version":"3.1", "metrics":{"baseScore":8.2}}]}),
                    ],
                    fixed_versions: vec!["1.0.1".into()],
                    aliases: vec!["GHSA-aaaa-bbbb-cccc".into()],
                }],
                problems: Vec::new(),
                unidentified_packages: 0,
                suppressed_matches: 0,
            }],
            problems: Vec::new(),
        }
    }

    #[test]
    fn incomplete_assessment_cannot_be_reported_as_a_successful_clean_scan() {
        let report = document(&Assessment::incomplete(AssessmentError::Input {
            reason: "expected ARM64 inventory is missing".into(),
        }));
        let invocation = &report["runs"][0]["invocations"][0];
        assert_eq!(invocation["executionSuccessful"], false);
        let notifications = invocation["toolExecutionNotifications"].as_array().unwrap();
        assert!(
            notifications.iter().any(|n| n["level"] == "error"
                && n["message"]["text"].as_str().unwrap().contains("ARM64"))
        );
        assert_eq!(
            report["runs"][0]["properties"]["publication_authorized"],
            false
        );
    }

    #[test]
    fn findings_identify_the_saved_inventory_without_claiming_a_source_location() {
        let assessment = assessment();
        let report = document(&assessment);
        let run = &report["runs"][0];
        let result = &run["results"][0];
        assert_eq!(run["invocations"][0]["executionSuccessful"], true);
        assert_eq!(result["level"], "error");
        assert_eq!(result["kind"], "fail");
        assert_eq!(result["properties"]["package"]["name"], "example-package");
        assert_eq!(result["properties"]["package"]["version"], "1.0.0");
        assert_eq!(result["properties"]["fixed_versions"], json!(["1.0.1"]));
        assert_eq!(
            result["properties"]["aliases"],
            json!(["GHSA-aaaa-bbbb-cccc"])
        );
        assert_eq!(
            result["properties"]["ratings"],
            json!(assessment.subjects[0].findings[0].ratings)
        );
        assert_eq!(
            result["properties"]["image"]["reference"],
            assessment.subjects[0].reference
        );
        assert_eq!(result["properties"]["image"]["platform"], "linux/amd64");
        assert_eq!(result["properties"]["image"]["sbom_sha256"], "e".repeat(64));
        let location = &result["locations"][0]["physicalLocation"];
        assert_eq!(
            location["artifactLocation"]["uri"],
            "hermes-amd64.spdx.json"
        );
        assert!(location.get("region").is_none());
        assert_eq!(run["artifacts"][0]["hashes"]["sha-256"], "e".repeat(64));
        assert_eq!(run["properties"]["scanner"]["version"], "0.121.0");
        assert_eq!(run["properties"]["database"]["sha256"], "c".repeat(64));
        assert!(
            run["tool"]["driver"]["rules"]
                .as_array()
                .unwrap()
                .iter()
                .any(|rule| rule["id"] == result["ruleId"])
        );
        assert!(result.get("suppressions").is_none());
    }

    #[test]
    fn rescans_keep_fingerprints_and_reordered_inventory_produces_the_same_document() {
        let mut assessment = assessment();
        let mut second = assessment.subjects[0].clone();
        second.reference = format!("fixture.invalid/hermes@sha256:{}", "f".repeat(64));
        second.platform = "linux/arm64".into();
        second.sbom_asset = "hermes-arm64.spdx.json".into();
        assessment.subjects.push(second);
        let mut other = assessment.subjects[0].findings[0].clone();
        other.advisory = "CVE-2026-54321".into();
        assessment.subjects[0].findings.push(other);
        let first = document(&assessment);
        assessment.subjects.reverse();
        for subject in &mut assessment.subjects {
            subject.findings.reverse();
        }
        assert_eq!(first, document(&assessment));
        assessment.database.as_mut().unwrap().age_seconds += 3600;
        assessment.database.as_mut().unwrap().sha256 = "9".repeat(64);
        assessment.scanner.as_mut().unwrap().configuration_sha256 = "8".repeat(64);
        for subject in &mut assessment.subjects {
            subject.sbom_sha256 = "7".repeat(64);
            for finding in &mut subject.findings {
                finding.fixed_versions.push("1.0.2".into());
            }
        }
        let fingerprints = |report: &Value| {
            report["runs"][0]["results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|result| result["partialFingerprints"]["primaryLocationLineHash"].clone())
                .collect::<Vec<_>>()
        };
        let original = fingerprints(&first);
        assert_eq!(original, fingerprints(&document(&assessment)));
        assert_ne!(original[0], original[1]);
    }

    #[test]
    fn only_high_and_critical_findings_become_results() {
        // rc7 had 15,442 findings; code scanning keeps 5,000 results per run.
        let mut assessment = assessment();
        let high = assessment.subjects[0].findings[0].clone();
        let mut findings: Vec<_> = ["Critical", "Medium", "Low", "Negligible", "Unknown"]
            .into_iter()
            .enumerate()
            .map(|(index, severity)| Finding {
                advisory: format!("CVE-2026-{index}"),
                severity: severity.into(),
                ..high.clone()
            })
            .collect();
        findings.push(high);
        assessment.subjects[0].findings = findings;
        let report = document(&assessment);
        let run = &report["runs"][0];
        let mut severities: Vec<_> = run["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|result| result["properties"]["severity"].as_str().unwrap())
            .collect();
        severities.sort_unstable();
        assert_eq!(severities, ["Critical", "High"]);
        assert_eq!(run["tool"]["driver"]["rules"].as_array().unwrap().len(), 2);
        assert_eq!(run["invocations"][0]["executionSuccessful"], true);
    }

    #[test]
    fn unusable_severity_retains_the_finding_and_scanner_failure_context() {
        let mut assessment = assessment();
        assessment.status = Status::Incomplete;
        assessment.subjects[0].findings[0].severity = "Unsupported".into();
        assessment.subjects[0]
            .problems
            .push(AssessmentError::Scanner {
                operation: ScanOperation::Scan,
                reason: "scanner failed after partial output".into(),
                exit_code: Some(17),
            });
        let report = document(&assessment);
        let run = &report["runs"][0];
        let result = &run["results"][0];
        assert_eq!(result["kind"], "review");
        assert_eq!(result["level"], "warning");
        assert_eq!(result["properties"]["severity"], "Unsupported");
        let invocation = &run["invocations"][0];
        assert_eq!(invocation["executionSuccessful"], false);
        let notifications = invocation["toolExecutionNotifications"].as_array().unwrap();
        assert!(notifications.iter().any(|notification| {
            notification["level"] == "error"
                && notification["properties"]["problem"]["operation"] == "scan"
                && notification["properties"]["problem"]["exit_code"] == 17
                && notification["properties"]["image"]["reference"]
                    == assessment.subjects[0].reference
        }));
    }

    #[test]
    fn untrusted_metadata_cannot_supply_paths_links_or_formatted_messages() {
        let mut assessment = assessment();
        assessment.subjects[0].sbom_asset = "../../outside.spdx.json".into();
        assessment.subjects[0].findings[0].package =
            "package\n\u{1b}[2J[execute](https://attacker.invalid)".into();
        assessment.subjects[0].findings[0].advisory = "https://attacker.invalid/$(command)".into();
        let report = document(&assessment);
        let run = &report["runs"][0];
        assert_eq!(run["invocations"][0]["executionSuccessful"], false);
        assert!(run["artifacts"][0].get("location").is_none());
        let result = &run["results"][0];
        assert!(result["locations"][0].get("physicalLocation").is_none());
        assert!(result["message"].get("markdown").is_none());
        let message = result["message"]["text"].as_str().unwrap();
        assert!(!message.chars().any(char::is_control));
        assert!(message.contains("\\n\\u{1b}"));
        let rule = &run["tool"]["driver"]["rules"][0];
        assert!(rule.get("helpUri").is_none());
        assert!(
            rule["id"]
                .as_str()
                .unwrap()
                .starts_with("image-vulnerability/")
        );
        assert!(run["invocations"][0].get("commandLine").is_none());
    }
}
