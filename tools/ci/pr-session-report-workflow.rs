// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Exercise the workflow's shell adapter with paginated API responses, without credentials.

#[cfg(test)]
mod tests {
    use std::{
        fs,
        process::Command,
        sync::atomic::{AtomicUsize, Ordering},
    };

    fn comment(author: u64, body: &str) -> String {
        let body = body
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n")
            .replace('\r', "\\r");
        format!("{{\"user\":{{\"id\":{author}}},\"body\":\"{body}\"}}")
    }

    fn opening(author: u64) -> String {
        comment(
            author,
            include_str!("fixtures/pr-session-report/opening.txt"),
        )
    }

    fn run(pages: &str, api_failure: bool) -> std::process::Output {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "report-adapter-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("pages.json"), pages).unwrap();
        let built = Command::new("rustc")
            .args([
                "--edition=2024",
                "-D",
                "warnings",
                "tools/ci/pr-session-report.rs",
                "-o",
            ])
            .arg(dir.join("report-check"))
            .output()
            .unwrap();
        assert!(
            built.status.success(),
            "{}",
            String::from_utf8_lossy(&built.stderr)
        );
        let adapter = include_str!("../../.github/workflows/commit-lint.yaml")
            .split("        run: |\n")
            .last()
            .unwrap()
            .lines()
            .map(|line| line.strip_prefix("          ").unwrap_or(line))
            .collect::<Vec<_>>()
            .join("\n");
        let script = format!(
            r#"
set -euo pipefail
gh() {{
  if [ "$API_FAILURE" = true ]; then return 42; fi
  case "$*" in
    'api repos/example/repo/pulls/1 --jq .body // ""') printf 'Description\n' ;;
    'api --paginate --slurp repos/example/repo/issues/1/comments?per_page=100') cat "$RUNNER_TEMP/pages.json" ;;
    *) printf 'Unexpected API request\n' >&2; return 43 ;;
  esac
}}
{adapter}
"#
        );
        let result = Command::new("bash")
            .args(["-c", &script])
            .env("RUNNER_TEMP", &dir)
            .env("GITHUB_REPOSITORY", "example/repo")
            .env("PR_NUMBER", "1")
            .env("PR_AUTHOR_ID", "7")
            .env("API_FAILURE", api_failure.to_string())
            .output()
            .unwrap();
        fs::remove_dir_all(dir).unwrap();
        result
    }

    #[test]
    fn later_page_author_opening_passes_despite_outsider_lookalike() {
        let mut first_page = vec![opening(8)];
        first_page.extend((0..99).map(|_| comment(7, "Unrelated comment")));
        let output = run(
            &format!("[[{}],[{}]]", first_page.join(","), opening(7)),
            false,
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn outsider_only_is_missing_and_two_author_openings_fail() {
        for pages in [
            format!("[[{}]]", opening(8)),
            format!("[[{},{}]]", opening(7), opening(7)),
        ] {
            let output = run(&pages, false);
            assert!(!output.status.success());
            assert!(String::from_utf8_lossy(&output.stderr).contains("Session report:"));
        }
    }

    #[test]
    fn api_failure_stops_before_validation() {
        let output = run("[]", true);
        assert_eq!(output.status.code(), Some(42));
    }

    #[test]
    fn missing_report_can_pass_on_rerun_after_publication() {
        let before = run("[[]]", false);
        assert!(!before.status.success());
        assert!(String::from_utf8_lossy(&before.stderr).contains("must post an opening"));
        assert!(run(&format!("[[{}]]", opening(7)), false).status.success());
    }
}
