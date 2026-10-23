// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Match proposed upstream-base exceptions without granting release approval.
//!
//! The 30-day maximum is this candidate policy's explicit choice. Origin evidence
//! and the tracking issue are review inputs; this module does not fetch or
//! authenticate them. A protected controller must review that evidence and the
//! exact policy bytes before using the matching outcome in its release decision.
//! Entry-specific validation applies only to the exact digest/platform subjects
//! being assessed, so supported releases can share one policy snapshot.
use super::{Assessment, Finding, Status, SubjectReport};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceReference {
    pub reference: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Exception {
    pub reference: String,
    pub platform: String,
    pub advisory: String,
    pub package: String,
    pub version: String,
    pub purl: Option<String>,
    pub upstream_base: String,
    pub origin_evidence: EvidenceReference,
    pub tracking_issue: String,
    pub rationale: String,
    pub valid_from: String,
    pub expires: String,
}

#[derive(Debug, Serialize)]
pub struct PolicyEvaluation {
    pub status: Status,
    pub publication_authorized: bool,
    pub policy_sha256: String,
    pub matched_exceptions: Vec<Exception>,
    pub blocking_findings: usize,
}

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "category", rename_all = "snake_case")]
pub enum PolicyError {
    #[error("exception policy: {reason}")]
    Input { reason: String },
    #[error("exception policy checksum differs from the controller's expected checksum")]
    Checksum,
    #[error("exception policy entry {index}: {reason}")]
    Entry { index: usize, reason: String },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    schema_version: u32,
    exceptions: Vec<Exception>,
}

fn matches_finding(entry: &Exception, subject: &SubjectReport, finding: &Finding) -> bool {
    entry.reference == subject.reference
        && entry.platform == subject.platform
        && entry.advisory == finding.advisory
        && entry.package == finding.package
        && entry.version == finding.version
        && entry.purl == finding.purl
}

fn lowercase_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

fn readable(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096
        && !value.chars().any(|v| v.is_control() || matches!(v, '\u{2028}' | '\u{2029}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
}

fn immutable_image(value: &str) -> bool {
    let Some((repository, digest)) = value.split_once("@sha256:") else {
        return false;
    };
    lowercase_hex(digest, 64)
        && repository.len() <= 1024
        && repository.contains('/')
        && repository
            .split('/')
            .all(|part| !part.is_empty() && !matches!(part, "." | ".."))
        && repository
            .rsplit('/')
            .next()
            .is_some_and(|part| !part.contains(':'))
        && repository.bytes().all(|v| {
            v.is_ascii_lowercase()
                || v.is_ascii_digit()
                || matches!(v, b'.' | b'-' | b'_' | b'/' | b':')
        })
}

fn immutable_evidence(reference: &EvidenceReference) -> bool {
    if !lowercase_hex(&reference.sha256, 64) || reference.reference.len() > 2048 {
        return false;
    }
    let Ok(url) = url::Url::parse(&reference.reference) else {
        return false;
    };
    let Some(segments) = url.path_segments() else {
        return false;
    };
    let segments: Vec<_> = segments.collect();
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.as_str() == reference.reference
        && segments.len() >= 5
        && segments[2] == "blob"
        && lowercase_hex(segments[3], 40)
        && segments
            .iter()
            .all(|part| !part.is_empty() && !matches!(*part, "." | ".."))
}

fn tracking_issue(value: &str) -> bool {
    value
        .strip_prefix("https://github.com/NVIDIA/NemoClaw/issues/")
        .and_then(|number| number.parse::<u64>().ok().map(|id| (number, id)))
        .is_some_and(|(number, id)| id > 0 && number == id.to_string())
}

/// The expected checksum must come from the protected controller's approved
/// snapshot. Supplying a local checksum does not establish review or origin.
pub fn evaluate(
    assessment: &Assessment,
    policy_bytes: &[u8],
    expected_policy_sha256: &str,
    now: OffsetDateTime,
) -> Result<PolicyEvaluation, PolicyError> {
    if policy_bytes.is_empty() || policy_bytes.len() > 1 << 20 {
        return Err(PolicyError::Input {
            reason: "requires a nonempty policy within the 1 MiB size limit".into(),
        });
    }
    if crate::hex(&Sha256::digest(policy_bytes)) != expected_policy_sha256 {
        return Err(PolicyError::Checksum);
    }
    let policy: Policy = serde_json::from_slice(policy_bytes).map_err(|_| PolicyError::Input {
        reason: "expected the versioned exception-policy JSON format".into(),
    })?;
    if policy.schema_version != 1 || policy.exceptions.len() > 1024 {
        return Err(PolicyError::Input {
            reason: "requires schema version 1 and at most 1024 exceptions".into(),
        });
    }
    let assessed_subjects: BTreeSet<_> = assessment
        .subjects
        .iter()
        .map(|subject| (subject.reference.as_str(), subject.platform.as_str()))
        .collect();
    let mut seen = BTreeSet::new();
    for (index, entry) in policy.exceptions.iter().enumerate() {
        if !assessed_subjects.contains(&(entry.reference.as_str(), entry.platform.as_str())) {
            continue;
        }
        let invalid = |reason: &str| PolicyError::Entry {
            index,
            reason: reason.into(),
        };
        if !immutable_image(&entry.reference)
            || !matches!(entry.platform.as_str(), "linux/amd64" | "linux/arm64")
            || ![
                &entry.advisory,
                &entry.package,
                &entry.version,
                &entry.rationale,
            ]
            .into_iter()
            .all(|v| readable(v))
            || entry
                .purl
                .as_ref()
                .is_some_and(|v| !readable(v) || !v.starts_with("pkg:"))
        {
            return Err(invalid(
                "subject, package, advisory, and rationale must have exact usable identities",
            ));
        }
        if !immutable_image(&entry.upstream_base)
            || entry.upstream_base == entry.reference
            || !immutable_evidence(&entry.origin_evidence)
            || !tracking_issue(&entry.tracking_issue)
        {
            return Err(invalid(
                "requires an upstream-base digest, immutable origin evidence and checksum, and a tracking issue",
            ));
        }
        let start = OffsetDateTime::parse(&entry.valid_from, &Rfc3339)
            .map_err(|_| invalid("valid_from must be an RFC 3339 timestamp"))?;
        let end = OffsetDateTime::parse(&entry.expires, &Rfc3339)
            .map_err(|_| invalid("expires must be an RFC 3339 timestamp"))?;
        if start > now || end <= now || end <= start || end - start > time::Duration::days(30) {
            return Err(invalid(
                "exception must be current and expire within 30 days of valid_from",
            ));
        }
        if !seen.insert((
            &entry.reference,
            &entry.platform,
            &entry.advisory,
            &entry.package,
            &entry.version,
            &entry.purl,
        )) {
            return Err(invalid("duplicates another exception"));
        }
        let matches = assessment
            .subjects
            .iter()
            .flat_map(|subject| {
                subject
                    .findings
                    .iter()
                    .map(move |finding| (subject, finding))
            })
            .filter(|(subject, finding)| {
                matches!(finding.severity.as_str(), "High" | "Critical")
                    && matches_finding(entry, subject, finding)
            })
            .count();
        if matches != 1 {
            return Err(invalid(
                "must match exactly one High or Critical finding in the assessed subject",
            ));
        }
    }
    let mut matched_exceptions = Vec::new();
    let mut blocking_findings = 0;
    let mut incomplete = assessment.status == Status::Incomplete
        || !assessment.problems.is_empty()
        || assessment.scanner.is_none()
        || assessment.database.is_none()
        || assessment.subjects.is_empty();
    for subject in &assessment.subjects {
        incomplete |= !subject.problems.is_empty();
        for finding in &subject.findings {
            incomplete |= !matches!(
                finding.severity.as_str(),
                "Critical" | "High" | "Medium" | "Low" | "Negligible"
            );
            if matches!(finding.severity.as_str(), "High" | "Critical") {
                if let Some(exception) = policy
                    .exceptions
                    .iter()
                    .find(|entry| matches_finding(entry, subject, finding))
                {
                    matched_exceptions.push(exception.clone());
                } else {
                    blocking_findings += 1;
                }
            }
        }
    }
    Ok(PolicyEvaluation {
        status: if incomplete {
            Status::Incomplete
        } else if blocking_findings > 0 {
            Status::Blocked
        } else {
            Status::Passed
        },
        publication_authorized: false,
        policy_sha256: expected_policy_sha256.into(),
        matched_exceptions,
        blocking_findings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release_assessment::{DatabaseEvidence, Finding, ScannerEvidence, SubjectReport};
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};

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
                age_seconds: 100,
            }),
            subjects: vec![SubjectReport {
                name: "hermes".into(),
                reference: format!(
                    "ghcr.io/nvidia/nemoclaw/v1/hermes@sha256:{}",
                    "d".repeat(64)
                ),
                platform: "linux/amd64".into(),
                sbom_asset: "hermes-amd64.spdx.json".into(),
                sbom_sha256: "e".repeat(64),
                findings: vec![Finding {
                    advisory: "CVE-2026-12345".into(),
                    package: "openssl".into(),
                    version: "3.0.0".into(),
                    purl: Some("pkg:deb/debian/openssl@3.0.0?arch=amd64".into()),
                    severity: "High".into(),
                    severity_source: None,
                    ratings: Vec::new(),
                    fixed_versions: vec!["3.0.1".into()],
                    aliases: Vec::new(),
                }],
                problems: Vec::new(),
            }],
            problems: Vec::new(),
        }
    }

    fn run(assessment: &Assessment, policy: &Value) -> Result<PolicyEvaluation, PolicyError> {
        let bytes = serde_json::to_vec(policy).unwrap();
        evaluate(
            assessment,
            &bytes,
            &crate::hex(&Sha256::digest(&bytes)),
            OffsetDateTime::parse(
                "2026-10-21T12:00:00Z",
                &time::format_description::well_known::Rfc3339,
            )
            .unwrap(),
        )
    }

    fn policy(assessment: &Assessment) -> Value {
        let subject = &assessment.subjects[0];
        let finding = &subject.findings[0];
        json!({"schema_version":1,"exceptions":[{
            "reference": subject.reference, "platform": subject.platform,
            "advisory": finding.advisory, "package": finding.package,
            "version": finding.version, "purl": finding.purl,
            "upstream_base": format!("docker.io/library/debian@sha256:{}", "f".repeat(64)),
            "origin_evidence": {
                "reference": format!("https://github.com/NVIDIA/NemoClaw/blob/{}/image/base-evidence.json", "1".repeat(40)),
                "sha256": "2".repeat(64)
            },
            "tracking_issue": "https://github.com/NVIDIA/NemoClaw/issues/13523",
            "rationale": "Track the upstream base pin update; this exception does not cover owned changes.",
            "valid_from": "2026-10-20T12:00:00Z", "expires": "2026-10-23T12:00:00Z"
        }]})
    }

    #[test]
    fn unreviewed_high_findings_block_with_an_empty_policy() {
        let assessment = assessment();
        let evaluated = run(&assessment, &json!({"schema_version":1,"exceptions":[]})).unwrap();
        assert_eq!(evaluated.status, Status::Blocked);
        assert_eq!(evaluated.blocking_findings, 1);
        assert!(!evaluated.publication_authorized);
        assert_eq!(assessment.subjects[0].findings.len(), 1);
    }

    #[test]
    fn matching_upstream_candidate_keeps_findings_without_authorizing_publication() {
        let assessment = assessment();
        let evaluated = run(&assessment, &policy(&assessment)).unwrap();
        assert_eq!(evaluated.status, Status::Passed);
        assert_eq!(evaluated.blocking_findings, 0);
        assert_eq!(evaluated.matched_exceptions.len(), 1);
        assert!(!evaluated.publication_authorized);
        assert_eq!(assessment.status, Status::Blocked);
        assert_eq!(assessment.subjects[0].findings.len(), 1);
    }

    #[test]
    fn a_substituted_policy_cannot_use_the_controllers_expected_checksum() {
        let assessment = assessment();
        let bytes = serde_json::to_vec(&policy(&assessment)).unwrap();
        let result = evaluate(
            &assessment,
            &bytes,
            &"0".repeat(64),
            OffsetDateTime::now_utc(),
        );
        assert!(matches!(result, Err(PolicyError::Checksum)));
    }

    #[test]
    fn exception_window_is_current_and_at_most_thirty_days() {
        let assessment = assessment();
        let mut accepted = Vec::new();
        for (start, end) in [
            ("2026-10-20T12:00:00Z", "2026-10-21T12:00:00Z"),
            ("2026-10-20T12:00:00Z", "2026-10-21T11:59:59Z"),
            ("2026-10-22T12:00:00Z", "2026-10-23T12:00:00Z"),
            ("2026-10-20T12:00:00Z", "2026-10-19T12:00:00Z"),
            ("2026-10-20T12:00:00Z", "2026-11-20T12:00:00Z"),
            ("not-a-date", "2026-10-23T12:00:00Z"),
        ] {
            let mut policy = policy(&assessment);
            policy["exceptions"][0]["valid_from"] = start.into();
            policy["exceptions"][0]["expires"] = end.into();
            if run(&assessment, &policy).is_ok() {
                accepted.push((start, end));
            }
        }
        assert!(
            accepted.is_empty(),
            "invalid windows accepted: {accepted:?}"
        );
        let mut boundary = policy(&assessment);
        boundary["exceptions"][0]["expires"] = "2026-11-19T12:00:00Z".into();
        assert_eq!(run(&assessment, &boundary).unwrap().status, Status::Passed);
    }

    #[test]
    fn missing_or_incomplete_raw_evidence_cannot_become_a_policy_pass() {
        let mut accepted = Vec::new();
        for case in 0..7 {
            let mut assessment = assessment();
            assessment.subjects[0].findings.clear();
            assessment.status = Status::Passed;
            match case {
                0 => assessment.status = Status::Incomplete,
                1 => assessment
                    .problems
                    .push(crate::release_assessment::AssessmentError::Input {
                        reason: "incomplete input".into(),
                    }),
                2 => assessment.subjects[0].problems.push(
                    crate::release_assessment::AssessmentError::Input {
                        reason: "incomplete subject".into(),
                    },
                ),
                3 => assessment.scanner = None,
                4 => assessment.database = None,
                5 => {
                    assessment.subjects[0].findings =
                        self::assessment().subjects.remove(0).findings;
                    assessment.subjects[0].findings[0].severity = "Unknown".into();
                }
                _ => assessment.subjects.clear(),
            }
            let evaluated = run(&assessment, &json!({"schema_version":1,"exceptions":[]})).unwrap();
            if evaluated.status != Status::Incomplete {
                accepted.push(case);
            }
        }
        assert!(
            accepted.is_empty(),
            "incomplete cases accepted: {accepted:?}"
        );
        let mut assessment = assessment();
        assessment.status = Status::Incomplete;
        let evaluated = run(&assessment, &policy(&assessment)).unwrap();
        assert_eq!(evaluated.status, Status::Incomplete);
        assert_eq!(evaluated.matched_exceptions.len(), 1);
    }

    #[test]
    fn an_exception_must_match_exactly_one_blocking_finding() {
        let assessment = assessment();
        let mut accepted = Vec::new();
        for (field, replacement) in [
            ("advisory", "CVE-2026-99999"),
            ("package", "other"),
            ("version", "3.0.1"),
            ("purl", "pkg:deb/debian/openssl@3.0.1?arch=amd64"),
        ] {
            let mut policy = policy(&assessment);
            policy["exceptions"][0][field] = replacement.into();
            if run(&assessment, &policy).is_ok() {
                accepted.push(field);
            }
        }
        assert!(
            accepted.is_empty(),
            "unbound exceptions accepted: {accepted:?}"
        );
        let mut duplicated = policy(&assessment);
        let entry = duplicated["exceptions"][0].clone();
        duplicated["exceptions"].as_array_mut().unwrap().push(entry);
        assert!(run(&assessment, &duplicated).is_err());
        let mut duplicated_finding = assessment.clone();
        let finding = duplicated_finding.subjects[0].findings[0].clone();
        duplicated_finding.subjects[0].findings.push(finding);
        assert!(run(&duplicated_finding, &policy(&assessment)).is_err());
    }

    #[test]
    fn global_policy_entries_apply_only_to_the_exact_assessed_release() {
        let release_a = assessment();
        let mut release_b = assessment();
        release_b.subjects[0].reference = format!(
            "ghcr.io/nvidia/nemoclaw/v1/hermes@sha256:{}",
            "0".repeat(64)
        );
        let mut global = policy(&release_a);
        global["exceptions"]
            .as_array_mut()
            .unwrap()
            .push(policy(&release_b)["exceptions"][0].clone());
        let mut failures = Vec::new();
        for (name, assessed) in [("release A", &release_a), ("release B", &release_b)] {
            match run(assessed, &global) {
                Ok(evaluated)
                    if evaluated.status == Status::Passed
                        && evaluated.matched_exceptions.len() == 1
                        && evaluated.matched_exceptions[0].reference
                            == assessed.subjects[0].reference
                        && !evaluated.publication_authorized => {}
                result => failures.push(format!("{name}: {result:?}")),
            }
        }
        // An old exception for B must not invalidate release A's assessment.
        global["exceptions"][1]["expires"] = "2026-10-21T11:59:59Z".into();
        match run(&release_a, &global) {
            Ok(evaluated) if evaluated.status == Status::Passed => {}
            result => failures.push(format!("foreign expiry: {result:?}")),
        }
        assert!(
            failures.is_empty(),
            "unrelated release policies interfered: {failures:?}"
        );
        assert!(
            run(&release_b, &global).is_err(),
            "relevant expiry must still fail"
        );
    }

    #[test]
    fn other_platform_or_digest_exceptions_cannot_waive_a_finding() {
        let assessment = assessment();
        for (field, value) in [
            (
                "reference",
                format!(
                    "ghcr.io/nvidia/nemoclaw/v1/hermes@sha256:{}",
                    "0".repeat(64)
                ),
            ),
            ("platform", "linux/arm64".into()),
        ] {
            let mut candidate = policy(&assessment);
            candidate["exceptions"][0][field] = value.into();
            let evaluation = run(&assessment, &candidate).unwrap();
            assert_eq!(evaluation.status, Status::Blocked);
            assert_eq!(evaluation.blocking_findings, 1);
            assert!(evaluation.matched_exceptions.is_empty());
        }
    }

    #[test]
    fn mutable_or_missing_upstream_evidence_cannot_support_an_exception() {
        let assessment = assessment();
        let mut accepted = Vec::new();
        for case in 0..9 {
            let mut policy = policy(&assessment);
            let entry = &mut policy["exceptions"][0];
            match case {
                0 => entry["upstream_base"] = "docker.io/library/debian:bookworm".into(),
                1 => entry["upstream_base"] = assessment.subjects[0].reference.clone().into(),
                2 => entry["origin_evidence"]["reference"] = "https://github.com/NVIDIA/NemoClaw/blob/v1/image/base-evidence.json".into(),
                3 => entry["origin_evidence"]["reference"] = "http://github.com/NVIDIA/NemoClaw/blob/1111111111111111111111111111111111111111/evidence.json".into(),
                4 => entry["origin_evidence"]["sha256"] = "not-a-checksum".into(),
                5 => entry["tracking_issue"] = "https://github.com/NVIDIA/NemoClaw/issues/0".into(),
                6 => entry["rationale"] = " ".into(),
                7 => entry["rationale"] = "upstream\n::notice::forged".into(),
                _ => entry["tracking_issue"] = "https://github.com/NVIDIA/NemoClaw/pull/13523".into(),
            }
            if run(&assessment, &policy).is_ok() {
                accepted.push(case);
            }
        }
        assert!(
            accepted.is_empty(),
            "unusable review inputs accepted: {accepted:?}"
        );
    }

    #[test]
    fn oversized_policy_data_is_rejected_before_parsing() {
        let mut bytes = br#"{"schema_version":1,"exceptions":[]}"#.to_vec();
        bytes.resize((1 << 20) + 1, b' ');
        let result = evaluate(
            &assessment(),
            &bytes,
            &crate::hex(&Sha256::digest(&bytes)),
            OffsetDateTime::now_utc(),
        );
        assert!(matches!(result, Err(PolicyError::Input { .. })));
    }

    #[test]
    fn one_upstream_exception_does_not_waive_other_blocking_content() {
        let mut assessment = assessment();
        let candidate = policy(&assessment);
        let mut owned = assessment.subjects[0].findings[0].clone();
        owned.advisory = "GHSA-owned-dependency".into();
        owned.package = "owned-dependency".into();
        owned.purl = Some("pkg:cargo/owned-dependency@3.0.0".into());
        owned.severity = "Critical".into();
        assessment.subjects[0].findings.push(owned);
        let evaluated = run(&assessment, &candidate).unwrap();
        assert_eq!(evaluated.status, Status::Blocked);
        assert_eq!(evaluated.blocking_findings, 1);
        assert_eq!(evaluated.matched_exceptions.len(), 1);
        assert_eq!(assessment.subjects[0].findings.len(), 2);
    }

    #[test]
    fn editable_review_flags_and_unknown_policy_fields_are_rejected() {
        let assessment = assessment();
        let mut candidate = policy(&assessment);
        candidate["exceptions"][0]["reviewed"] = true.into();
        assert!(run(&assessment, &candidate).is_err());
        let mut candidate = policy(&assessment);
        candidate["publication_authorized"] = true.into();
        assert!(run(&assessment, &candidate).is_err());
        let mut candidate = policy(&assessment);
        candidate["schema_version"] = 2.into();
        assert!(run(&assessment, &candidate).is_err());
    }
}
