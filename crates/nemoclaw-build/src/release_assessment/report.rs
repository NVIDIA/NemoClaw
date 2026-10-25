// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Assessment, Status};

fn safe(value: &str) -> String {
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

fn line(output: &mut String, label: &str, value: &str) {
    output.push_str(label);
    output.push_str(&safe(value));
    output.push('\n');
}

/// Keep verified findings visible when another part of the assessment failed.
pub fn text(assessment: &Assessment) -> String {
    let mut output = match assessment.status {
        Status::Passed => "Assessment passed\n".to_owned(),
        Status::Blocked => "Assessment blocked\n".to_owned(),
        Status::Incomplete => "Assessment incomplete\n".to_owned(),
    };
    output.push_str("Publication is not authorized by this assessment.\n");
    output.push_str(match assessment.status {
        Status::Passed => "Next action: Handle release approvals separately.\n",
        Status::Blocked => {
            "Next action: Update the affected dependency or base-image pin and reassess its new image digest.\n"
        }
        Status::Incomplete => {
            "Next action: Repair verification or review unusable finding severity, then rerun; retain the findings below.\n"
        }
    });
    if let Some(scanner) = &assessment.scanner {
        line(&mut output, "Scanner: ", &scanner.name);
        line(&mut output, "Scanner version: ", &scanner.version);
        line(&mut output, "Scanner SHA-256: ", &scanner.sha256);
        line(
            &mut output,
            "Configuration SHA-256: ",
            &scanner.configuration_sha256,
        );
    }
    if let Some(database) = &assessment.database {
        line(
            &mut output,
            "Database schema version: ",
            &database.schema_version,
        );
        line(&mut output, "Database built: ", &database.built);
        line(&mut output, "Database SHA-256: ", &database.sha256);
        line(
            &mut output,
            "Database age (seconds): ",
            &database.age_seconds.to_string(),
        );
    }
    for problem in &assessment.problems {
        line(&mut output, "Verification problem: ", &problem.to_string());
    }
    for subject in &assessment.subjects {
        output.push('\n');
        line(&mut output, "Subject: ", &subject.name);
        line(&mut output, "Platform: ", &subject.platform);
        line(&mut output, "Image: ", &subject.reference);
        line(&mut output, "SBOM SHA-256: ", &subject.sbom_sha256);
        output.push_str(&format!("Findings: {}\n", subject.findings.len()));
        for finding in &subject.findings {
            line(&mut output, "  Advisory: ", &finding.advisory);
            line(
                &mut output,
                "  Package: ",
                &format!("{}@{}", finding.package, finding.version),
            );
            line(&mut output, "  Severity: ", &finding.severity);
            if let Some(source) = &finding.severity_source {
                line(&mut output, "  Severity source: ", source);
            }
            if let Some(purl) = &finding.purl {
                line(&mut output, "  Package URL: ", purl);
            }
            if finding.fixed_versions.is_empty() {
                output.push_str("  Fixed version: none reported\n");
            } else {
                line(
                    &mut output,
                    "  Fixed versions: ",
                    &finding.fixed_versions.join(", "),
                );
            }
            if !finding.aliases.is_empty() {
                line(&mut output, "  Aliases: ", &finding.aliases.join(", "));
            }
        }
        for problem in &subject.problems {
            line(
                &mut output,
                "  Verification problem: ",
                &problem.to_string(),
            );
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::release_assessment::{
        AssessmentError, DatabaseEvidence, Finding, ScanOperation, ScannerEvidence, Status,
        SubjectReport,
    };

    fn partial_assessment() -> Assessment {
        Assessment {
            status: Status::Incomplete,
            publication_authorized: false,
            scanner: Some(ScannerEvidence {
                name: "grype".into(),
                version: "0.121.0".into(),
                sha256: "scanner-checksum".into(),
                configuration_sha256: "configuration-checksum".into(),
            }),
            database: Some(DatabaseEvidence {
                schema_version: "v6.1.10".into(),
                built: "2026-10-21T00:00:00Z".into(),
                sha256: "database-checksum".into(),
                age_seconds: 3600,
            }),
            subjects: vec![SubjectReport {
                name: "hermes".into(),
                reference: "registry.example/hermes@sha256:abcd".into(),
                platform: "linux/arm64".into(),
                sbom_sha256: "1234".into(),
                sbom_asset: "hermes-amd64.spdx.json".into(),
                findings: vec![Finding {
                    advisory: "CVE-2026-12345".into(),
                    package: "example-package".into(),
                    version: "1.0.0".into(),
                    purl: Some("pkg:npm/example-package@1.0.0".into()),
                    severity: "High".into(),
                    severity_source: Some("github".into()),
                    ratings: Vec::new(),
                    fixed_versions: vec!["1.0.1".into()],
                    aliases: vec!["GHSA-aaaa-bbbb-cccc".into()],
                }],
                problems: vec![AssessmentError::Scanner {
                    operation: ScanOperation::Scan,
                    reason: "second result could not be verified".into(),
                    exit_code: Some(1),
                }],
                unidentified_packages: 0,
                suppressed_matches: 0,
            }],
            problems: vec![AssessmentError::Input {
                reason: "one platform assessment failed".into(),
            }],
        }
    }

    #[test]
    fn incomplete_assessment_retains_findings_and_requires_verification() {
        let report = text(&partial_assessment());
        assert!(report.contains("Assessment incomplete"));
        assert!(report.contains("CVE-2026-12345"));
        assert!(report.contains("example-package@1.0.0"));
        assert!(report.contains("1.0.1"));
        assert!(report.contains("GHSA-aaaa-bbbb-cccc"));
        assert!(report.contains("one platform assessment failed"));
        assert!(report.contains("Repair verification"));
        assert!(report.contains("Publication is not authorized"));
        assert!(report.contains("Scanner version: 0.121.0"));
        assert!(report.contains("Database SHA-256: database-checksum"));
        assert!(report.contains("Database age (seconds): 3600"));
    }

    #[test]
    fn outcomes_explain_the_action_without_granting_publication() {
        for (status, heading, action) in [
            (
                Status::Passed,
                "Assessment passed",
                "Handle release approvals",
            ),
            (
                Status::Blocked,
                "Assessment blocked",
                "Update the affected dependency",
            ),
            (
                Status::Incomplete,
                "Assessment incomplete",
                "Repair verification",
            ),
        ] {
            let mut assessment = partial_assessment();
            assessment.status = status;
            let report = text(&assessment);
            assert!(report.starts_with(heading));
            assert!(report.contains(action));
            assert!(report.contains("Publication is not authorized"));
            assert!(report.contains("CVE-2026-12345"));
        }
    }

    #[test]
    fn untrusted_fields_cannot_inject_terminal_controls_or_status_lines() {
        let mut assessment = partial_assessment();
        assessment.subjects[0].name = "image\nAssessment passed\u{1b}[2J".into();
        assessment.subjects[0].findings[0].package = "package\u{202e}name".into();
        assessment.problems[0] = AssessmentError::Input {
            reason: "failed\rAssessment passed".into(),
        };
        assessment.scanner.as_mut().unwrap().version = "0.121.0\nforged".into();
        let report = text(&assessment);
        assert!(report.starts_with("Assessment incomplete\n"));
        assert!(!report.contains('\u{1b}'));
        assert!(!report.contains('\r'));
        assert!(!report.contains('\u{202e}'));
        assert!(!report.contains("\nAssessment passed"));
        assert!(report.contains("image\\nAssessment passed\\u{1b}[2J"));
        assert!(report.contains("Scanner version: 0.121.0\\nforged"));
    }
}
