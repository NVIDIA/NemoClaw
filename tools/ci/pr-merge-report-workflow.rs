// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Exercise the real reporter and gh's jq expressions without credentials or writes.

#[test]
fn preview_publication_pagination_and_failures() {
    use std::{env, fs, process::Command};
    let directory = env::temp_dir().join(format!("merge-report-test-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    let script = r##"
set -euo pipefail
rustc --edition=2024 tools/ci/pr-merge-report.rs -o "$FIXTURE/reporter"
cat > "$FIXTURE/gh" <<'MOCK'
#!/bin/bash
set -euo pipefail
endpoint=''; query='.'; post=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --jq) query="$2"; shift ;;
    --method) if [ "$2" = POST ]; then post=true; fi; shift ;;
    -f) if [[ "$2" = body=* ]]; then printf '%s' "${2#body=}" > "$FIXTURE/posted-body"; fi; shift ;;
    repos/*) endpoint="$1" ;;
  esac
  shift
done
printf '%s\n' "$endpoint" >> "$FIXTURE/requests"
if $post; then
  printf 'POST\n' >> "$FIXTURE/writes"
  printf '123\n'
  exit 0
fi
case "$endpoint" in
  repos/example/repo/pulls/1)
    jq -n --arg scenario "$SCENARIO" '{merged:($scenario != "unmerged"),base:{ref:"v1"},head:{sha:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",ref:"fork-feature",repo:{id:99}},created_at:"2026-01-01T00:00:00Z",merged_at:"2026-01-01T00:10:00Z",additions:209,deletions:10,changed_files:5}' ;;
  repos/example/repo/pulls/1/commits*)
    printf '[{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]\n[{"sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]\n' ;;
  repos/example/repo/pulls/1/reviews*)
    printf '[{"id":7,"state":"CHANGES_REQUESTED","commit_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","submitted_at":"2026-01-01T00:03:00Z"}]\n' ;;
  repos/example/repo/actions/runs\?*)
    printf '{"total_count":1,"workflow_runs":[{"id":11,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","created_at":"2026-01-01T00:01:00Z","workflow_id":9,"event":"pull_request","head_branch":"fork-feature","pull_requests":[{"number":1}]}]}\n'
    printf '{"total_count":1,"workflow_runs":[{"id":12,"head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","created_at":"2026-01-01T00:04:00Z","workflow_id":9,"event":"pull_request","head_branch":"fork-feature","pull_requests":[]}]}\n' ;;
  repos/example/repo/commits/*/check-runs*)
    if [ "$SCENARIO" = api_failure ]; then exit 42; fi
    if [[ "$endpoint" = */aaaaaaaa*/check-runs* ]]; then
      printf '{"check_runs":[{"id":101,"name":"Unit | <script> @someone","app":{"id":1,"slug":"github-actions"},"started_at":"2026-01-01T00:01:10Z","completed_at":"2026-01-01T00:02:00Z","conclusion":"failure","details_url":"https://github.com/example/repo/actions/runs/11/job/101"}]}\n'
      printf '{"check_runs":[{"id":90,"name":"Prior branch","app":{"id":1,"slug":"github-actions"},"started_at":"2025-12-31T23:01:10Z","completed_at":"2025-12-31T23:02:00Z","conclusion":"failure","details_url":"https://github.com/example/repo/actions/runs/9/job/90"}]}\n'
      printf '{"check_runs":[{"id":91,"name":"Unrelated branch","app":{"id":1,"slug":"github-actions"},"started_at":"2026-01-01T00:01:20Z","completed_at":"2026-01-01T00:02:10Z","conclusion":"failure","details_url":"https://github.com/example/repo/actions/runs/8/job/91"}]}\n'
    else
      printf '{"check_runs":[{"id":102,"name":"Unit | <script> @someone","app":{"id":1,"slug":"github-actions"},"started_at":"2026-01-01T00:04:10Z","completed_at":"2026-01-01T00:05:00Z","conclusion":"success","details_url":"https://github.com/example/repo/actions/runs/12/job/102"}]}\n'
    fi ;;
  repos/example/repo/actions/runs/9)
    printf '{"id":9,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","created_at":"2025-12-31T23:01:00Z","workflow_id":9,"event":"push","head_branch":"main","pull_requests":[]}\n' ;;
  repos/example/repo/actions/runs/8)
    printf '{"id":8,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","created_at":"2026-01-01T00:01:15Z","workflow_id":9,"head_branch":"other-feature","pull_requests":[{"number":2}]}\n' ;;
  repos/example/repo/commits/*/statuses*)
    printf '[{"id":103,"context":"Legacy gate","state":"success","created_at":"2026-01-01T00:06:00Z","updated_at":"2026-01-01T00:06:00Z"}]\n' ;;
  repos/example/repo/issues/1/comments*)
    printf '[{"user":{"login":"outsider"},"body":"<!-- nemoclaw-merge-report:v1 -->"}]\n'
    if [ "$SCENARIO" = existing ]; then
      printf '[{"user":{"login":"github-actions[bot]"},"body":"<!-- nemoclaw-merge-report:v1 -->"}]\n'
    else printf '[]\n'; fi ;;
  repos/example/repo/issues/comments/123)
    if [ "$SCENARIO" = readback ]; then jq -n '{body:"edited"}'
    else jq -n --rawfile body "$FIXTURE/posted-body" '{body:$body}'; fi ;;
  *) printf 'Unexpected endpoint: %s\n' "$endpoint" >&2; exit 43 ;;
esac | jq -r "$query"
MOCK
chmod +x "$FIXTURE/gh"
export PATH="$FIXTURE:$PATH"
export SCENARIO=valid
"$FIXTURE/reporter" example/repo 1 > "$FIXTURE/preview"
grep -Fq '+209 / -10 lines across 5 files' "$FIXTURE/preview"
grep -Fq '| Repair rounds | 1 (observed revisions after failed checks) |' "$FIXTURE/preview"
grep -Fq '| Review rounds | 1 changes-requested reviews; 1 observed follow-up revisions |' "$FIXTURE/preview"
grep -Fq 'Unit &#124; &#60;script&#62; &#64;someone' "$FIXTURE/preview"
grep -Fq '| success | 50 |' "$FIXTURE/preview"
grep -Fq 'Legacy gate' "$FIXTURE/preview"
if grep -Fq 'Prior branch' "$FIXTURE/preview"; then exit 1; fi
if grep -Fq 'Unrelated branch' "$FIXTURE/preview"; then exit 1; fi
test ! -e "$FIXTURE/writes"
"$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/posted"
test "$(wc -l < "$FIXTURE/writes" | tr -d ' ')" = 1
grep -Fq 'repos/example/repo/issues/comments/123' "$FIXTURE/requests"
rm "$FIXTURE/writes"
SCENARIO=existing "$FIXTURE/reporter" example/repo 1 --post
test ! -e "$FIXTURE/writes"
for SCENARIO in api_failure unmerged; do
  export SCENARIO
  if "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/output" 2>&1; then
    cat "$FIXTURE/output" >&2
    exit 1
  fi
  test ! -e "$FIXTURE/writes"
done
if SCENARIO=readback "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/output" 2> "$FIXTURE/readback-error"; then
  exit 1
fi
grep -Fq 'did not match readback' "$FIXTURE/readback-error"
grep -Fq '<summary>Merge outcomes</summary>' "$FIXTURE/output"
"##;
    let output = Command::new("bash")
        .args(["-c", script])
        .env("FIXTURE", &directory)
        .output()
        .unwrap();
    fs::remove_dir_all(directory).unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
