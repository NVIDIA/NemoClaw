// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{env, fs, process::ExitCode};

const START: &str = "<!-- agent-session-report:v1 -->";
const END: &str = "<!-- /agent-session-report -->";
const OPENING: &str = "<summary>Authoring session — opening</summary>";

fn validate(body: &str) -> Result<(), &'static str> {
    let body = body.replace("\r\n", "\n");
    let body = body.trim();
    if !body.starts_with("<details>\n")
        || !body.ends_with("\n</details>")
        || body.matches("<details").count() != 1
        || body.matches("</details>").count() != 1
    {
        return Err("wrap the comment in <details> without an open attribute");
    }
    if body.matches(START).count() != 1 || body.matches(END).count() != 1 {
        return Err("include exactly one v1 report; see .github/SESSION_REPORT_TEMPLATE.md");
    }
    let before_report = body.split_once(START).unwrap().0;
    if body.matches("<summary>").count() != 1
        || body.matches("</summary>").count() != 1
        || !before_report
            .split_once("<summary>")
            .and_then(|(_, rest)| rest.split_once("</summary>"))
            .is_some_and(|(title, _)| !title.trim().is_empty())
    {
        return Err("include one nonempty summary before the report table");
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
        return Err("use the report table header from .github/SESSION_REPORT_TEMPLATE.md");
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

fn check(args: &[String]) -> Result<(), &'static str> {
    if args.first().map(String::as_str) == Some("--pr") {
        let description = fs::read_to_string(args.get(1).ok_or("expected a PR description file")?)
            .map_err(|_| "cannot read PR description file")?;
        if description.contains("<!-- agent-session-report:")
            || description.contains(END)
            || description.contains(OPENING)
        {
            return Err("keep session reports in separate comments, outside the PR description");
        }
        let comments = args[2..]
            .iter()
            .map(|path| fs::read_to_string(path).map_err(|_| "cannot read PR-author comment file"))
            .collect::<Result<Vec<_>, _>>()?;
        let mut openings = comments.iter().filter(|body| body.contains(OPENING));
        let opening = openings
            .next()
            .ok_or("PR author must post an opening report comment")?;
        if openings.next().is_some() {
            return Err("PR author must have exactly one opening report comment");
        }
        return validate(opening);
    }
    args.first()
        .ok_or("expected a report comment file")
        .and_then(|path| {
            let body = fs::read_to_string(path).map_err(|_| "cannot read report comment file")?;
            validate(&body)
        })
}

fn main() -> ExitCode {
    match check(&env::args().skip(1).collect::<Vec<_>>()) {
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
    fn posted_report_acceptance_cases() {
        let directory = env::temp_dir().join(format!("report-cases-{}", std::process::id()));
        fs::create_dir(&directory).unwrap();
        for (name, body) in [
            ("description", "Description".to_string()),
            ("opening", report()),
            (
                "later",
                report().replace(OPENING, "<summary>Later report</summary>"),
            ),
            ("expanded", report().replace("<details>", "<details open>")),
            ("malformed", report().replace("| Models |", "| Skills |")),
        ] {
            fs::write(directory.join(name), body).unwrap();
        }
        let cases = [
            (true, "description opening"),
            (true, "description opening later description"),
            (false, "description"),
            (false, "description later"),
            (false, "description opening opening"),
            (false, "opening"),
            (false, "opening opening"),
            (false, "description expanded"),
            (false, "description malformed"),
            (false, "description missing-file"),
        ];
        let results: Vec<_> = cases
            .iter()
            .map(|(_, files)| {
                let args = std::iter::once("--pr".to_string())
                    .chain(
                        files
                            .split_whitespace()
                            .map(|name| directory.join(name).to_str().unwrap().to_string()),
                    )
                    .collect::<Vec<_>>();
                check(&args).is_ok()
            })
            .collect();
        fs::remove_dir_all(directory).unwrap();
        for ((expected, files), actual) in cases.iter().zip(results) {
            assert_eq!(actual, *expected, "{files}");
        }
    }

    #[test]
    fn missing_report_is_rejected_even_when_prose_mentions_skills() {
        assert!(validate("## Changes\nRead skills and ran tests.").is_err());
    }

    fn report() -> String {
        format!(
            "<details>\n<summary>Authoring session — opening</summary>\n\n{START}\n| Field | Status | Value | Evidence or limit |\n| --- | --- | --- | --- |\n\
| Harness | recorded | Codex | Authoring session header |\n\
| Skills | partial | test-driven-development (complete read) | Earlier context unavailable |\n\
| Instruction files | partial | AGENTS.md (complete read); WRITING.md (injected) | Full contents retained; earlier injection coverage unavailable |\n\
| Tool calls | recorded | read: 2; shell: 1 | Recorded invocations, including failed attempts |\n\
| Session window | recorded | 2026-10-27T12:00Z to 2026-10-27T12:10Z; 10 min | First event through report cutoff |\n\
| Compactions | recorded | 0 | Complete session record through cutoff |\n\
| Models | unavailable | - | Model metadata absent |\n\
| Reasoning levels | unavailable | - | Level metadata absent |\n{END}\n\n</details>"
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
    fn windows_line_endings_are_accepted() {
        assert!(validate(&report().replace('\n', "\r\n")).is_ok());
    }

    #[test]
    fn collapsed_report_has_one_summary_before_its_table() {
        for invalid in [
            report().replace(OPENING, ""),
            report().replace(OPENING, &format!("{OPENING}\n{OPENING}")),
            report()
                .replace(OPENING, "")
                .replace(END, &format!("{END}\n{OPENING}")),
        ] {
            assert!(validate(&invalid).is_err());
        }
    }

    #[test]
    fn report_comments_must_be_collapsed() {
        let collapsed = report();
        assert!(validate(&collapsed).is_ok());
        for invalid in [
            collapsed.replace("<details>", ""),
            collapsed.replace("<details>", "<details open>"),
            collapsed.replace("<details>", "<details open=\"false\">"),
            collapsed.replace("</details>", ""),
        ] {
            assert!(
                validate(&invalid).is_err(),
                "accepted an uncollapsed report"
            );
        }
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
        assert!(validate(include_str!("../../.github/SESSION_REPORT_TEMPLATE.md")).is_ok());
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
