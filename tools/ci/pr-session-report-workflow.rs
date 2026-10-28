// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Run the workflow adapter with fake API responses and the real validator, without credentials.

#[test]
fn posted_comment_checks_and_publication_recovery() {
    use std::{env, fs, process::Command};
    let directory = env::temp_dir().join(format!("report-adapter-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    let workflow =
        env::var("REPORT_WORKFLOW").unwrap_or(".github/workflows/pr-metadata.yml".into());
    let workflow = fs::read_to_string(workflow).unwrap();
    let adapter = workflow
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
rustc --edition=2024 -D warnings tools/ci/pr-session-report.rs -o "$RUNNER_TEMP/report-check"
gh() {{
  if [ "$scenario" = api_failure ]; then return 42; fi
  case "$*" in
    'api repos/example/repo/pulls/1 --jq .body // ""') printf 'Description\n' ;;
    'api --paginate --slurp repos/example/repo/issues/1/comments?per_page=100')
      jq -n --rawfile report .github/SESSION_REPORT_TEMPLATE.md --arg scenario "$scenario" '
        [[range(100) | {{user: {{id: 8}}, body: $report}}], [{{user: {{id: 7}}, body: $report}}]]
        | if $scenario == "missing" then []
          elif $scenario == "outsider" then .[:1]
          elif $scenario == "duplicate" then .[1] += .[1]
          elif $scenario == "malformed" then .[1][0].body |= gsub("Models"; "Skills")
          else . end' ;;
    *) return 43 ;;
  esac
}}
check() {{
{adapter}
}}
# A fresh invocation after publication must recover from the initial missing report.
for scenario in missing valid outsider duplicate malformed api_failure valid; do
  set +e
  (set -e; check) > "$RUNNER_TEMP/output" 2>&1
  actual=$?
  set -e
  case "$scenario" in valid) expected=0 ;; api_failure) expected=42 ;; *) expected=1 ;; esac
  if [ "$actual" -ne "$expected" ]; then
    cat "$RUNNER_TEMP/output" >&2
    printf '%s: expected %s, got %s\n' "$scenario" "$expected" "$actual" >&2
    exit 1
  fi
done
"#
    );
    let result = Command::new("bash")
        .args(["-c", &script])
        .env("RUNNER_TEMP", &directory)
        .env("GITHUB_REPOSITORY", "example/repo")
        .env("PR_NUMBER", "1")
        .env("PR_AUTHOR_ID", "7")
        .output()
        .unwrap();
    fs::remove_dir_all(directory).unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
