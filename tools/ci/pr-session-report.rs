// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{env, fs, process::ExitCode};

const START: &str = "<!-- agent-session-report:v1 -->";
const END: &str = "<!-- /agent-session-report -->";

fn validate(body: &str) -> Result<(), &'static str> {
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
        .ok_or("expected a PR body file")
        .and_then(|path| {
            let body = fs::read_to_string(path).map_err(|_| "cannot read PR body file")?;
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
    fn missing_report_is_rejected_even_when_prose_mentions_skills() {
        assert!(validate("## Changes\nRead skills and ran tests.").is_err());
    }

    fn report() -> String {
        format!(
            "{START}\n| Field | Status | Value | Evidence or limit |\n| --- | --- | --- | --- |\n\
| Harness | recorded | Codex | Authoring session header |\n\
| Skills | partial | test-driven-development (complete read) | Earlier context unavailable |\n\
| Instruction files | partial | AGENTS.md (complete read); WRITING.md (injected) | Full contents retained; earlier injection coverage unavailable |\n\
| Tool calls | recorded | read: 2; shell: 1 | Recorded invocations, including failed attempts |\n\
| Session window | recorded | 2026-10-27T12:00Z to 2026-10-27T12:10Z; 10 min | First event through report cutoff |\n\
| Compactions | recorded | 0 | Complete session record through cutoff |\n\
| Models | unavailable | - | Model metadata absent |\n\
| Reasoning levels | unavailable | - | Level metadata absent |\n{END}"
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
        assert!(validate(include_str!("../../.github/PULL_REQUEST_TEMPLATE.md")).is_ok());
    }

    #[test]
    fn prose_and_shell_syntax_in_values_are_inert_data() {
        let body = format!(
            "## Outcome\nExample prose\n{}\n## Validation\nTests passed.",
            report().replace(
                "test-driven-development (complete read)",
                "$(exit 42); `false`; <script>"
            )
        );
        assert!(validate(&body).is_ok());
    }
}
