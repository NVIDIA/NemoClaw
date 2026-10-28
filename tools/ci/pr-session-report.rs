// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Collapsed wrapper adapted from main PR #13876 at b245d56471d0aa4ce4378eb33f58e63a799df199.
// Retain V1's standalone Rust validator and use workflow-owned comment selection.

use std::{env, fs, process::ExitCode};

const START: &str = "<!-- agent-session-report:v1 -->";
const END: &str = "<!-- /agent-session-report -->";

fn validate(body: &str) -> Result<(), &'static str> {
    let normalized = body.replace("\r\n", "\n");
    let body = normalized.trim();
    let mut inner = None;
    for (kind, label) in [
        ("opening", "PR opening"),
        ("commit", "Commit update"),
        ("merge", "PR merge"),
    ] {
        let prefix = format!(
            "<!-- agent-session-report:{kind} -->\n<details>\n<summary>Authoring session report: {label}</summary>\n\n"
        );
        if let Some(content) = body
            .strip_prefix(&prefix)
            .and_then(|s| s.strip_suffix("\n</details>"))
        {
            inner = Some(content);
        }
    }
    let body = inner.ok_or("use the collapsed session report comment template")?;
    let lower = body.to_ascii_lowercase();
    if ["<details", "</details", "<summary", "</summary"]
        .iter()
        .any(|tag| lower.contains(tag))
    {
        return Err("use one collapsed section for the report");
    }
    if body.matches(START).count() != 1 || body.matches(END).count() != 1 {
        return Err("include exactly one v1 report; see the PR template");
    }
    let report = body
        .split_once(START)
        .unwrap()
        .1
        .split_once(END)
        .ok_or("report end must follow its start")?
        .0;
    let mut lines = report
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    if lines.next() != Some("| Field | Status | Value | Evidence or limit |")
        || lines.next() != Some("| --- | --- | --- | --- |")
    {
        return Err("use the report table header from the PR template");
    }
    let fields = [
        "Harness",
        "Skills",
        "Instruction files",
        "Tool calls",
        "Session window",
        "Compactions",
        "Models",
        "Reasoning levels",
    ];
    let mut seen = std::collections::BTreeSet::new();
    for line in lines {
        let cells: Vec<_> = line.split('|').map(str::trim).collect();
        if cells.len() != 6 || !cells[0].is_empty() || !cells[5].is_empty() {
            return Err("each report row must have four cells; use semicolons inside cells");
        }
        let (field, status, value, evidence) = (cells[1], cells[2], cells[3], cells[4]);
        if !fields.contains(&field) || !seen.insert(field) {
            return Err("report fields must be known and unique");
        }
        if !matches!(status, "recorded" | "partial" | "unavailable") {
            return Err("status must be recorded, partial, or unavailable");
        }
        if value.is_empty() || evidence.is_empty() || evidence == "-" {
            return Err("every field needs a value and evidence or an availability limit");
        }
        if (status == "unavailable") != (value == "-") {
            return Err("use '-' only for unavailable values");
        }
    }
    if seen.len() != fields.len() {
        return Err("include all eight report fields, even when unavailable");
    }
    Ok(())
}

fn main() -> ExitCode {
    let result = env::args()
        .nth(1)
        .ok_or("expected a report comment file")
        .and_then(|path| {
            let body = fs::read_to_string(path).map_err(|_| "cannot read report comment file")?;
            validate(&body)
        });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("Session report: {message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_must_be_collapsed_comments() {
        assert!(validate(&report().replace("<details>", "<details open>")).is_err());
        assert!(validate(&report().replace("<details>", "")).is_err());
        assert!(validate(&format!("Prose outside the section\n{}", report())).is_err());
        assert!(
            validate(&report().replace("</details>", "</details>\n<details>extra</details>"))
                .is_err()
        );
        assert!(validate(&report().replace("PR opening", "PR merge")).is_err());
    }

    #[test]
    fn later_reports_use_distinct_labels_and_the_same_table() {
        for (kind, label) in [("commit", "Commit update"), ("merge", "PR merge")] {
            let later = report()
                .replace("report:opening", &format!("report:{kind}"))
                .replace("PR opening", label);
            assert!(validate(&later).is_ok());
        }
    }

    #[test]
    fn workflow_selects_one_opening_across_all_comment_pages() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        // Execute the workflow's actual selector so pagination and duplicate handling
        // are covered at the boundary between GitHub JSON and the Rust validator.
        let workflow = include_str!("../../.github/workflows/pr-metadata.yml");
        let query = workflow
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("jq -er '")
                    .and_then(|s| s.split_once('\'').map(|p| p.0))
            })
            .unwrap();
        for (input, expected) in [
            (
                r#"[[{"body":"ordinary review"}],[{"body":"<!-- agent-session-report:commit -->"},{"body":"\n<!-- agent-session-report:opening -->\nreport"}]]"#,
                true,
            ),
            (
                r#"[[{"body":"<!-- agent-session-report:opening -->"}],[{"body":"<!-- agent-session-report:opening -->"}]]"#,
                false,
            ),
            (
                r#"[[{"body":"<!-- agent-session-report:merge -->"}],[]]"#,
                false,
            ),
        ] {
            let mut child = Command::new("jq")
                .args(["-er", query])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .expect("jq is required by the metadata workflow");
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert_eq!(output.status.success(), expected);
            if expected {
                assert_eq!(
                    String::from_utf8(output.stdout).unwrap(),
                    "\n<!-- agent-session-report:opening -->\nreport\n"
                );
            }
        }
    }

    #[test]
    fn missing_report_is_rejected_even_when_prose_mentions_skills() {
        assert!(validate("## Changes\nRead skills and ran tests.").is_err());
    }

    fn report() -> String {
        format!(
            "<!-- agent-session-report:opening -->\n<details>\n<summary>Authoring session report: PR opening</summary>\n\n{START}\n| Field | Status | Value | Evidence or limit |\n| --- | --- | --- | --- |\n\
| Harness | recorded | Codex | Authoring session header |\n\
| Skills | partial | test-driven-development (complete read) | Earlier context unavailable |\n\
| Instruction files | partial | AGENTS.md (complete read); WRITING.md (injected) | Full contents retained; earlier injection coverage unavailable |\n\
| Tool calls | recorded | read: 2; shell: 1 | Recorded invocations, including failed attempts |\n\
| Session window | recorded | 2026-10-27T12:00Z to 2026-10-27T12:10Z; 10 min | First event through report cutoff |\n\
| Compactions | recorded | 0 | Complete session record through cutoff |\n\
| Models | unavailable | - | Model metadata absent |\n\
| Reasoning levels | unavailable | - | Level metadata absent |\n{END}\n</details>"
        )
    }

    #[test]
    fn incomplete_or_ambiguous_reports_are_rejected() {
        let valid = report();
        for invalid in [
            format!("{START}\n{END}"),
            format!("{END}\n{START}"),
            format!("{valid}\n{valid}"),
            valid.replace("| Models | unavailable | - | Model metadata absent |\n", ""),
            valid.replace("| Models |", "| Skills |"),
            valid.replace("| recorded |", "| compliant |"),
            valid.replace("| 0 |", "| |"),
            valid.replace("| Model metadata absent |", "| |"),
            valid.replace("| unavailable | - |", "| unavailable | 0 |"),
            valid.replace(
                "| partial | test-driven-development (complete read) |",
                "| partial | - |",
            ),
            valid.replace("| Models |", "| Extra |"),
        ] {
            assert!(validate(&invalid).is_err(), "accepted malformed report");
        }
    }

    #[test]
    fn recorded_partial_and_unavailable_fields_are_valid() {
        assert!(validate(&report()).is_ok());
    }

    #[test]
    fn skills_do_not_replace_the_instruction_files_field() {
        let body = report()
            .lines()
            .filter(|line| !line.starts_with("| Instruction files |"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(validate(&body).is_err());
    }

    #[test]
    fn template_with_all_fields_unavailable_is_valid() {
        assert!(validate(include_str!("../../.agents/skills/nemoclaw-contributor-create-pr/references/session-report-template.md")).is_ok());
    }

    #[test]
    fn prose_and_shell_syntax_in_values_are_inert_data() {
        let body = report().replace(
            "test-driven-development (complete read)",
            "$(exit 42); `false`; <script>",
        );
        assert!(validate(&body).is_ok());
    }
}
