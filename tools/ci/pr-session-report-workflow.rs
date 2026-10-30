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
        [[range(100) | {{user: {{id: 8, login: "outsider"}}, body: $report}}], [{{user: {{id: 7, login: "author"}}, body: $report}}]]
        | if $scenario == "missing" then []
          elif $scenario == "outsider" then .[:1]
          elif $scenario == "duplicate" then .[1] += .[1]
          elif $scenario == "malformed" then .[1][0].body |= gsub("Models"; "Skills")
          elif $scenario == "maintainer" or $scenario == "permission_failure" or $scenario == "duplicate_maintainer" or $scenario == "malformed_maintainer" then .[1][0].user = {{id: 9, login: "maintainer"}}
          elif $scenario == "admin" then .[1][0].user = {{id: 10, login: "admin"}}
          elif $scenario == "writer" then .[1][0].user = {{id: 11, login: "writer"}}
          elif $scenario == "triage" then .[1][0].user = {{id: 12, login: "triage"}}
          else . end
        | if $scenario == "duplicate_maintainer" then .[1] += .[1]
          elif $scenario == "malformed_maintainer" then .[1][0].body |= gsub("Models"; "Skills")
          else . end' ;;
    api\ repos/example/repo/collaborators/*/permission*)
      if [ "$scenario" = permission_failure ]; then return 42; fi
      case "$2" in
        */maintainer/permission) identity='{{id: 9, permissions: {{maintain: true}}}}' ;;
        */admin/permission) identity='{{id: 10, permissions: {{admin: true}}}}' ;;
        */writer/permission) identity='{{id: 11, permissions: {{push: true}}}}' ;;
        */triage/permission) identity='{{id: 12, permissions: {{triage: true}}}}' ;;
        *) identity='{{id: 8, permissions: {{pull: true}}}}' ;;
      esac
      jq -n "{{user: $identity}}" | jq -r "${{@: -1}}" ;;
    *) return 43 ;;
  esac
}}
check() {{
{adapter}
}}
# A fresh invocation after publication must recover from the initial missing report.
for scenario in missing valid outsider maintainer admin writer triage duplicate duplicate_maintainer malformed malformed_maintainer api_failure permission_failure maintainer; do
  set +e
  (set -e; check) > "$RUNNER_TEMP/output" 2>&1
  actual=$?
  set -e
  case "$scenario" in valid|maintainer|admin) expected=0 ;; api_failure|permission_failure) expected=42 ;; *) expected=1 ;; esac
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
