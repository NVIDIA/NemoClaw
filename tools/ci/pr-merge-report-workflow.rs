// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Exercise the reporter and workflow with controlled GitHub and checkout boundaries.
//! The workflow adapter test uses Ruby's standard-library YAML parser.

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
    --method) if [ "$2" = POST ]; then post=true; elif [ "$2" != GET ]; then printf "%s\n" "$2" >> "$FIXTURE/edits"; exit 45; fi; shift ;;
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
    jq -n --arg scenario "$SCENARIO" '[{id:7,state:"CHANGES_REQUESTED",commit_id:(if $scenario == "null_review" then null elif $scenario == "invalid_review" then "not-a-sha" else "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" end),submitted_at:"2026-01-01T00:03:00Z"}]' ;;
  repos/example/repo/actions/runs\?*)
    printf '{"total_count":1,"workflow_runs":[{"id":11,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","created_at":"2026-01-01T00:01:00Z","workflow_id":9,"event":"pull_request","head_branch":"fork-feature","pull_requests":[{"number":1}]}]}\n'
    printf '{"total_count":2,"workflow_runs":[{"id":12,"head_repository":{"id":99},"head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","created_at":"2026-01-01T00:04:00Z","workflow_id":9,"event":"pull_request","head_branch":"fork-feature","pull_requests":[]},{"id":13,"head_repository":{"id":100},"head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","created_at":"2026-01-01T00:04:00Z","workflow_id":9,"head_branch":"fork-feature","pull_requests":[]}]}\n' ;;
  repos/example/repo/commits/*/check-runs*)
    if [ "$SCENARIO" = api_failure ]; then exit 42; fi
    if [[ "$endpoint" = */aaaaaaaa*/check-runs* ]]; then
      case "$SCENARIO" in
        missing_history|missing_access|missing_server|missing_malformed|existing_revision)
          printf 'gh: Not Found (HTTP 404)\n' >&2; exit 1 ;;
        missing_history_422)
          printf 'gh: No commit found for SHA: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (HTTP 422)\n' >&2; exit 1 ;;
        validation_error) printf 'gh: Validation Failed (HTTP 422)\n' >&2; exit 1 ;;
        unauthorized) printf 'gh: Bad credentials (HTTP 401)\n' >&2; exit 1 ;;
        forbidden) printf 'gh: Resource not accessible by integration (HTTP 403)\n' >&2; exit 1 ;;
        server_error) printf 'gh: Server Error (HTTP 500)\n' >&2; exit 1 ;;
      esac
    elif [ "$SCENARIO" = missing_head ]; then
      printf 'gh: No commit found for SHA: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb (HTTP 422)\n' >&2
      exit 1
    fi
    if [[ "$endpoint" = */aaaaaaaa*/check-runs* ]]; then
      printf '{"check_runs":[{"id":101,"name":"Unit | <script> @someone","app":{"id":1,"slug":"github-actions"},"started_at":"2026-01-01T00:01:10Z","completed_at":"2026-01-01T00:02:00Z","conclusion":"failure","details_url":"https://github.com/example/repo/actions/runs/11/job/101"}]}\n' | jq --arg scenario "$SCENARIO" 'if ($scenario | startswith("truncated")) then .check_runs[0].name = ("x" * 70000) else . end'
      printf '{"check_runs":[{"id":90,"name":"Prior branch","app":{"id":1,"slug":"github-actions"},"started_at":"2025-12-31T23:01:10Z","completed_at":"2025-12-31T23:02:00Z","conclusion":"failure","details_url":"https://github.com/example/repo/actions/runs/9/job/90"}]}\n'
      printf '{"check_runs":[{"id":91,"name":"Unrelated branch","app":{"id":1,"slug":"github-actions"},"started_at":"2026-01-01T00:01:20Z","completed_at":"2026-01-01T00:02:10Z","conclusion":"failure","details_url":"https://github.com/example/repo/actions/runs/8/job/91"}]}\n'
    else
      printf '{"check_runs":[{"id":102,"name":"Unit | <script> @someone","app":{"id":1,"slug":"github-actions"},"started_at":"2026-01-01T00:04:10Z","completed_at":"2026-01-01T00:05:00Z","conclusion":"success","details_url":"https://github.com/example/repo/actions/runs/12/job/102"}]}\n'
      printf '{"check_runs":[{"id":113,"name":"Other fork listed","app":{"id":1,"slug":"github-actions"},"started_at":"2026-01-01T00:04:10Z","completed_at":"2026-01-01T00:05:00Z","conclusion":"failure","details_url":"https://github.com/example/repo/actions/runs/13/job/113"},{"id":114,"name":"Other fork lookup","app":{"id":1,"slug":"github-actions"},"started_at":"2026-01-01T00:04:10Z","completed_at":"2026-01-01T00:05:00Z","conclusion":"failure","details_url":"https://github.com/example/repo/actions/runs/14/job/114"}]}\n'
    fi ;;
  repos/example/repo/actions/runs/9)
    printf '{"id":9,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","created_at":"2025-12-31T23:01:00Z","workflow_id":9,"event":"push","head_branch":"main","pull_requests":[]}\n' ;;
  repos/example/repo/actions/runs/8)
    printf '{"id":8,"head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","created_at":"2026-01-01T00:01:15Z","workflow_id":9,"head_branch":"other-feature","pull_requests":[{"number":2}]}\n' ;;
  repos/example/repo/actions/runs/13|repos/example/repo/actions/runs/14)
    jq -n --argjson id "${endpoint##*/}" '{id:$id,head_repository:{id:100},head_sha:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",created_at:"2026-01-01T00:04:00Z",workflow_id:9,head_branch:"fork-feature",pull_requests:[]}' ;;
  repos/example/repo/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
    case "$SCENARIO" in
      missing_history|missing_history_422|missing_status)
        printf 'gh: No commit found for SHA: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (HTTP 422)\n' >&2; exit 1 ;;
      missing_access) printf 'gh: Not Found (HTTP 404)\n' >&2; exit 1 ;;
      missing_server) printf 'gh: Server Error (HTTP 500)\n' >&2; exit 1 ;;
      missing_malformed) printf '{invalid json'; exit 0 ;;
      existing_revision) printf '{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n' ;;
      *) exit 43 ;;
    esac ;;
  repos/example/repo/commits/*/statuses*)
    if [[ "$endpoint" = */aaaaaaaa*/statuses* ]] && [ "$SCENARIO" = missing_status ]; then
      printf 'gh: No commit found for SHA: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (HTTP 422)\n' >&2
      exit 1
    fi
    printf '[{"id":103,"context":"Legacy gate","state":"success","created_at":"2026-01-01T00:06:00Z","updated_at":"2026-01-01T00:06:00Z"}]\n' ;;
  repos/example/repo/issues/1/comments*)
    printf '[{"user":{"login":"outsider"},"body":"<!-- nemoclaw-merge-report:v1 -->"}]\n'
    case "$SCENARIO" in
      existing|truncated_existing)
        jq -n --rawfile body "$FIXTURE/existing-body" '[{user:{login:"github-actions[bot]"},body:$body}]' ;;
      existing_wrong|truncated_mismatch)
        jq -n --rawfile body "$FIXTURE/existing-body" '[{user:{login:"github-actions[bot]"},body:($body | split("+209 / -10") | join("+999 / -10"))}]' ;;
      existing_marker_only)
        printf '[{"user":{"login":"github-actions[bot]"},"body":"<!-- nemoclaw-merge-report:v1 -->"}]\n' ;;
      existing_duplicate)
        jq -n --rawfile body "$FIXTURE/existing-body" '[{user:{login:"github-actions[bot]"},body:$body}] | . + .' ;;
      *) printf '[]\n' ;;
    esac ;;
  repos/example/repo/issues/comments/123)
    if [ "$SCENARIO" = readback_failure ]; then exit 44; fi
    if [ "$SCENARIO" = readback_mismatch ]; then
      printf '{"body":"different content"}\n'
      exit 0
    fi
    jq -n --rawfile body "$FIXTURE/posted-body" '{body:$body}' ;;
  *) printf 'Unexpected endpoint: %s\n' "$endpoint" >&2; exit 43 ;;
esac | jq -r "$query"
MOCK
chmod +x "$FIXTURE/gh"
export PATH="$FIXTURE:$PATH"
for SCENARIO in valid null_review; do
  export SCENARIO
  : > "$FIXTURE/requests"
  "$FIXTURE/reporter" example/repo 1 > "$FIXTURE/preview"
  grep -Fq '+209 / -10 lines across 5 files' "$FIXTURE/preview"
  grep -Fq '| Repair rounds | 1 (observed revisions after failed checks) |' "$FIXTURE/preview"
  followups=1
  if [ "$SCENARIO" = null_review ]; then followups=0; fi
  grep -Fq "| Review rounds | 1 changes-requested reviews; $followups observed follow-up revisions |" "$FIXTURE/preview"
  grep -Fq 'Unit &#124; &#60;script&#62; &#64;someone' "$FIXTURE/preview"
  grep -Fq '| success | 50 |' "$FIXTURE/preview"
  grep -Fq 'Legacy gate' "$FIXTURE/preview"
  if grep -Fq 'Prior branch' "$FIXTURE/preview"; then exit 1; fi
  if grep -Fq 'Unrelated branch' "$FIXTURE/preview"; then exit 1; fi
  if grep -F 'Other fork' "$FIXTURE/preview" >&2; then exit 1; fi
  test ! -e "$FIXTURE/writes"
  grep -Fq 'https://github.com/example/repo/pull/1#pullrequestreview-7' "$FIXTURE/preview"
  "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/posted"
  test "$(wc -l < "$FIXTURE/writes" | tr -d ' ')" = 1
  grep -Fq 'repos/example/repo/issues/comments/123' "$FIXTURE/requests"
  cmp "$FIXTURE/preview" "$FIXTURE/posted-body"
  if grep -Fq 'repos/example/repo/commits//' "$FIXTURE/requests"; then exit 1; fi
  rm "$FIXTURE/writes"
done
SCENARIO=valid "$FIXTURE/reporter" example/repo 1 > "$FIXTURE/existing-body"
SCENARIO=existing "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/existing-report"
test ! -e "$FIXTURE/writes"
cmp "$FIXTURE/existing-body" "$FIXTURE/existing-report"
for SCENARIO in existing_marker_only existing_wrong existing_duplicate; do
  if SCENARIO="$SCENARIO" "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/retained-report" 2> "$FIXTURE/existing-error"; then exit 1; fi
  test ! -e "$FIXTURE/writes"
  grep -Fq 'Existing merge report did not match the expected single report; stop and investigate, do not retry' "$FIXTURE/existing-error"
done
SCENARIO=truncated "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/full-report"
test "$(wc -l < "$FIXTURE/writes" | tr -d ' ')" = 1
test "$(wc -c < "$FIXTURE/full-report" | tr -d ' ')" -gt 60000
test "$(wc -c < "$FIXTURE/posted-body" | tr -d ' ')" -lt 60000
grep -Fq 'Timing rows truncated' "$FIXTURE/posted-body"
cp "$FIXTURE/posted-body" "$FIXTURE/existing-body"
rm "$FIXTURE/writes"
SCENARIO=truncated_existing "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/long-existing-report"
test ! -e "$FIXTURE/writes"
cmp "$FIXTURE/full-report" "$FIXTURE/long-existing-report"
if SCENARIO=truncated_mismatch "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/retained-report" 2> "$FIXTURE/existing-error"; then exit 1; fi
test ! -e "$FIXTURE/writes"
grep -Fq 'Existing merge report did not match the expected single report; stop and investigate, do not retry' "$FIXTURE/existing-error"
for SCENARIO in missing_history missing_history_422 missing_status; do
  export SCENARIO
  "$FIXTURE/reporter" example/repo 1 > "$FIXTURE/history-preview"
  test ! -e "$FIXTURE/writes"
  grep -Fq 'Historical check or status data unavailable for: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.' "$FIXTURE/history-preview"
  grep -Fq '+209 / -10 lines across 5 files' "$FIXTURE/history-preview"
  grep -Fq '| success | 50 |' "$FIXTURE/history-preview"
  "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/history-posted"
  test "$(wc -l < "$FIXTURE/writes" | tr -d ' ')" = 1
  cmp "$FIXTURE/history-preview" "$FIXTURE/posted-body"
  rm "$FIXTURE/writes"
done
for SCENARIO in api_failure unmerged invalid_review missing_head unauthorized forbidden server_error validation_error missing_access missing_server missing_malformed existing_revision; do
  export SCENARIO
  if "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/output" 2>&1; then
    cat "$FIXTURE/output" >&2
    exit 1
  fi
  test ! -e "$FIXTURE/writes"
  if [ "$SCENARIO" = invalid_review ]; then grep -Fq 'Invalid commit SHA' "$FIXTURE/output"; fi
done
for SCENARIO in readback_failure readback_mismatch; do
  rm -f "$FIXTURE/writes"
  if SCENARIO="$SCENARIO" "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/retained-report" 2> "$FIXTURE/readback-error"; then exit 1; fi
  test "$(wc -l < "$FIXTURE/writes" | tr -d ' ')" = 1
  grep -Fq '+209 / -10 lines across 5 files' "$FIXTURE/retained-report"
  grep -Fq '</details>' "$FIXTURE/retained-report"
  if [ "$SCENARIO" = readback_mismatch ]; then
    cat "$FIXTURE/readback-error" >&2
    grep -Fq 'Posted report did not match readback; stop and investigate, do not retry' "$FIXTURE/readback-error"
  fi
done
test ! -e "$FIXTURE/edits"
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

#[test]
fn workflow_enforces_trusted_checkout_and_retains_failed_publication() {
    use std::{env, fs, process::Command};
    let directory = env::temp_dir().join(format!("merge-workflow-test-{}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    let script = r##"
require 'yaml'
require 'json'
require 'fileutils'
require 'open3'
# Resolve the runner's Bash before isolating each step's command fixtures.
BASH = ENV.fetch('PATH').split(File::PATH_SEPARATOR)
  .map { |directory| File.expand_path('bash', directory) }
  .find { |candidate| File.file?(candidate) && File.executable?(candidate) }
raise 'Bash is unavailable' unless BASH
workflow = YAML.safe_load(File.read('.github/workflows/pr-merge-report.yml'))
parent = 'a' * 40
head = 'b' * 40
reporter_source = File.read('tools/ci/pr-merge-report.rs')

def value(text, context)
  return text[1...-1] if text.start_with?("'") && text.end_with?("'")
  return true if text == 'true'
  return false if text == 'false'
  text.split('.').reduce(context) { |node, key| node.fetch(key, {}) }.then { |v| v == {} ? '' : v }
end

def interpolate(text, context)
  text.to_s.gsub(/\$\{\{\s*(.*?)\s*\}\}/) { value($1, context).to_s }
end

def selected(expression, context, failed)
  expression = (expression || 'success()').sub(/\A\$\{\{/, '').sub(/\}\}\z/, '').strip
  return false if failed && !expression.include?('always()')
  expression.split('&&').all? do |term|
    term = term.strip
    next true if term == 'always()'
    next !failed if term == 'success()'
    left, right = term.split(' == ', 2)
    raise "Unsupported condition: #{term}" unless right
    value(left, context) == value(right, context)
  end
end

def exercise(workflow, root, scenario, parent, head, merged: true, action: 'closed', base: 'main', reporter: nil, retrying: false)
  FileUtils.rm_rf(["#{root}/workspace", "#{root}/temp"]) if retrying
  FileUtils.rm_f(Dir["#{root}/output-*"]) if retrying
  FileUtils.mkdir_p(["#{root}/bin", "#{root}/workspace", "#{root}/temp", "#{root}/artifacts"])
  File.write("#{root}/summary", '')
  File.write("#{root}/comments.json", JSON.generate([
    {id: 10, user: {login: 'author'}, body: '<details><!-- agent-session-report:v1 -->opening</details>'},
    {id: 11, user: {login: 'outsider'}, body: '<!-- nemoclaw-merge-report:v1 -->'}
  ])) unless retrying
  original_comments = File.read("#{root}/comments.json")
  File.write("#{root}/bin/gh", <<~'SH')
    #!/bin/bash
    set -euo pipefail
    endpoint=''; query='.'; slurp=false; filtered=false; post=false; body=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        repos/*) endpoint="$1" ;;
        --jq) query="$2"; filtered=true; shift ;;
        --slurp) slurp=true ;;
        --method) if [ "$2" = POST ]; then post=true; elif [ "$2" != GET ]; then printf "%s\n" "$2" >> "$FIXTURE/edits"; exit 45; fi; shift ;;
        -f) body="${2#body=}"; shift ;;
      esac
      shift
    done
    if $slurp && $filtered; then
      printf '%s\n' 'the `--slurp` option is not supported with `--jq` or `--template`' >&2
      exit 1
    fi
    printf '%s\n' "$endpoint" >> "$FIXTURE/requests"
    if $post; then
      printf 'POST\n' >> "$FIXTURE/posts"
      jq --arg body "$body" '. + [{id:123,user:{login:"github-actions[bot]"},body:$body}]' "$FIXTURE/comments.json" > "$FIXTURE/updated.json"
      mv "$FIXTURE/updated.json" "$FIXTURE/comments.json"
      printf '123\n'
      exit 0
    fi
    case "$endpoint" in
      repos/example/repo)
        case "$SCENARIO" in
          settings_unreadable) printf '{"allow_squash_merge":null,"allow_merge_commit":null,"allow_rebase_merge":null}' ;;
          rebase_enabled) printf '{"allow_squash_merge":true,"allow_merge_commit":false,"allow_rebase_merge":true}' ;;
          merge_enabled) printf '{"allow_squash_merge":true,"allow_merge_commit":true,"allow_rebase_merge":false}' ;;
          *) printf '{"allow_squash_merge":true,"allow_merge_commit":false,"allow_rebase_merge":false}' ;;
        esac ;;
      repos/example/repo/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/pulls*)
        if [ "$SCENARIO" = parent_api_failure ]; then exit 42; fi
        if $slurp; then printf '['; fi
        case "$SCENARIO" in
          rebased_parent) printf '[{"number":1}]' ;;
          paged_parent) printf '[{"number":2}],[{"number":1}]' ;;
          invalid_parent_association) printf '[{}]' ;;
          unassociated_parent) printf '[]' ;;
          *) printf '[{"number":2}]' ;;
        esac
        if $slurp; then printf ']'; fi ;;
      repos/example/repo/commits/dddddddddddddddddddddddddddddddddddddddd)
        case "$SCENARIO" in
          api_failure) exit 42 ;;
          malformed) printf '{"parents":[{"sha":"bad;touch forbidden"}]}' ;;
          multiple) printf '{"parents":[{"sha":"a"},{"sha":"b"}]}' ;;
          *) printf '{"parents":[{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}' ;;
        esac ;;
      repos/example/repo/issues/1/comments*)
        if $slurp; then printf '['; fi
        cat "$FIXTURE/comments.json"
        if $slurp; then printf ']'; fi ;;
      repos/example/repo/pulls/1/files*) printf '[{"filename":"tools/ci/pr-merge-report.rs"}]' ;;
      repos/example/repo/pulls/1)
        jq -n --arg base "$PR_BASE" '{merged:true,base:{ref:$base},head:{sha:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",ref:"fork-feature",repo:{id:99}},created_at:"2026-01-01T00:00:00Z",merged_at:"2026-01-01T00:10:00Z",additions:209,deletions:10,changed_files:5}' ;;
      repos/example/repo/pulls/1/commits*|repos/example/repo/pulls/1/reviews*) printf '[]' ;;
      repos/example/repo/commits/*/statuses*)
        case "$SCENARIO" in
          recovery*)
            jq -n --arg scenario "$SCENARIO" '[{id:202,context:"Pending status",state:(if $scenario == "recovery_failure" then "pending" else "success" end),created_at:"2026-01-01T00:02:00Z",updated_at:(if $scenario == "recovery_failure" then "2026-01-01T00:02:00Z" else "2026-01-01T00:11:00Z" end)}]' ;;
          *) printf '[]' ;;
        esac ;;
      repos/example/repo/actions/runs\?*) printf '{"total_count":0,"workflow_runs":[]}' ;;
      repos/example/repo/actions/runs/11|repos/example/repo/actions/runs/12)
        jq -n --argjson id "${endpoint##*/}" '{id:$id,head_sha:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",created_at:(if $id == 11 then "2026-01-01T00:04:00Z" else "2026-01-01T00:11:00Z" end),workflow_id:9,head_branch:"fork-feature",pull_requests:[{number:1}]}' ;;
      repos/example/repo/check-suites/*)
        test "$SCENARIO" != recovery_suite_failure
        jq -n --argjson id "${endpoint##*/}" '{head_sha:"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",created_at:(if $id == 301 then "2026-01-01T00:01:00Z" elif $id == 303 then "2026-01-01T00:03:00Z" elif $id == 305 then "2026-01-01T00:11:00Z" else "2025-12-31T23:59:00Z" end)}' ;;
      repos/example/repo/commits/*/check-runs*)
        case "$SCENARIO" in
          recovery*)
            jq -n --arg scenario "$SCENARIO" '($scenario == "recovery_failure") as $first |
              {check_runs:([
                {id:201,name:"Unfinished check",check_suite:{id:301},started_at:"2026-01-01T00:01:00Z"},
                {id:203,name:"Queued app check",check_suite:{id:303}},
                {id:204,name:"Queued Actions check",details_url:"https://github.com/example/repo/actions/runs/11/job/204"}
              ] + (if $scenario == "recovery_boundaries" then [
                {id:205,name:"Late app check",check_suite:{id:305}},
                {id:206,name:"Late Actions check",details_url:"https://github.com/example/repo/actions/runs/12/job/206"},
                {id:207,name:"Prior app check",check_suite:{id:307}}
              ] else [] end) | map(. + {app:{id:1,slug:"external"},started_at:(.started_at // (if $first then null else "2026-01-01T00:11:00Z" end)),completed_at:(if $first then null else "2026-01-01T00:12:00Z" end),conclusion:(if $first then null else "success" end)}))}' ;;
          *) printf '{"check_runs":[]}' ;;
        esac ;;
      repos/example/repo/issues/comments/123)
        test "$SCENARIO" != recovery_failure
        jq '.[] | select(.id == 123)' "$FIXTURE/comments.json" ;;
      *) printf 'Unexpected API: %s\n' "$endpoint" >&2; exit 43 ;;
    esac | jq -r "$query"
  SH
  File.write("#{root}/bin/rustc", <<~'SH')
    #!/bin/bash
    set -euo pipefail
    printf 'compile\n' >> "$FIXTURE/compilations"
    test -z "${GH_TOKEN:-}"
    if [ -n "$REAL_REPORTER" ]; then exec "$REAL_RUSTC" "$@"; fi
    cp "$4" "$6"
    chmod +x "$6"
  SH
  File.write("#{root}/bin/git", <<~'SH')
    #!/bin/bash
    set -euo pipefail
    case "$*" in
      'diff --exit-code -- tools/ci/pr-merge-report.rs') cmp -s tools/ci/pr-merge-report.rs "$FIXTURE/checkout-source" ;;
      'rev-parse HEAD') cat "$FIXTURE/checkout" ;;
      'rev-parse HEAD:tools/ci/pr-merge-report.rs') printf 'cccccccccccccccccccccccccccccccccccccccc\n' ;;
      *) exit 44 ;;
    esac
  SH
  FileUtils.chmod(0755, Dir["#{root}/bin/*"])
  trusted = <<~'SH'
    #!/bin/bash
    set -euo pipefail
    test "$GH_TOKEN" = fixture-token
    printf 'trusted\n' >> "$FIXTURE/executions"
    if [ -f "$FIXTURE/posted" ]; then exit 0; fi
    body='<details><!-- nemoclaw-merge-report:v1 -->GitHub data for #1 at merge, head `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`. Full timing rows.</details>'
    printf '%s\n' "$body"
    jq --arg body "$body" '. + [{id:12,user:{login:"github-actions[bot]"},body:$body}]' "$FIXTURE/comments.json" > "$FIXTURE/updated.json"
    mv "$FIXTURE/updated.json" "$FIXTURE/comments.json"
    touch "$FIXTURE/posted"
    test "$SCENARIO" != readback_failure
  SH
  context = {'github' => {'event_name' => 'pull_request_target', 'repository' => 'example/repo', 'token' => 'fixture-token', 'run_attempt' => retrying ? '2' : '1',
    'event' => {'pull_request' => {'merged' => merged, 'number' => 1, 'base' => {'ref' => base}, 'merge_commit_sha' => 'd' * 40,
      'head' => {'sha' => head, 'repo' => {'full_name' => 'example/fork'}}}}},
    'runner' => {'temp' => "#{root}/temp"}, 'steps' => {}}
  settings_job = workflow.fetch('jobs')['merge-settings']
  job = workflow.fetch('jobs').fetch('report')
  trigger = (workflow['on'] || workflow[true]).fetch('pull_request_target')
  eligible = trigger.fetch('types').include?(action) && trigger.fetch('branches').include?(base)
  failed = false
  artifact = nil
  return {failed: false, root: root, original_comments: original_comments} unless eligible && (!settings_job || selected(settings_job['if'], context, failed)) && selected(job['if'], context, failed)
  steps = (settings_job ? settings_job.fetch('steps').map { |step| [:settings, step] } : []) + job.fetch('steps').map { |step| [:report, step] }
  settings_failed = nil
  steps.each_with_index do |(owner, step), index|
    # A failed prerequisite job skips the dependent job, including its always() steps.
    settings_failed = failed if owner == :report && settings_failed.nil?
    break if settings_failed
    next unless selected(step['if'], context, failed)
    env = {'PATH' => "#{root}/bin:/usr/bin:/bin", 'FIXTURE' => root, 'SCENARIO' => scenario, 'PR_BASE' => base,
      'TMPDIR' => "#{root}/temp", 'RUNNER_TEMP' => "#{root}/temp", 'GITHUB_REPOSITORY' => 'example/repo', 'GITHUB_STEP_SUMMARY' => "#{root}/summary",
      'GITHUB_WORKFLOW_SHA' => 'e' * 40, 'GITHUB_RUN_ID' => '1234', 'GITHUB_RUN_ATTEMPT' => context['github']['run_attempt'], 'GITHUB_OUTPUT' => "#{root}/output-#{index}"}
    env['REAL_REPORTER'] = reporter ? 'true' : ''
    env['REAL_RUSTC'] = ENV.fetch('REAL_RUSTC')
    (step['env'] || {}).each { |key, text| env[key] = interpolate(text, context) }
    case step['uses']
    when /\Aactions\/checkout@/
      ref = interpolate(step.fetch('with').fetch('ref'), context)
      repository = interpolate(step.fetch('with').fetch('repository'), context)
      raise 'Wrong checkout repository' unless repository == 'example/repo'
      File.write("#{root}/credentials", 'persisted') unless step.fetch('with')['persist-credentials'] == false
      # An incorrect revision can contain the same reporter bytes.
      File.write("#{root}/checkout", scenario == 'wrong_checkout' ? head : ref)
      FileUtils.mkdir_p("#{root}/workspace/tools/ci")
      content = {parent => reporter || trusted, head => "#!/bin/bash\nprintf 'PR code' >> \"$FIXTURE/executions\"\nexit 90\n"}.fetch(ref)
      File.write("#{root}/checkout-source", content)
      File.write("#{root}/workspace/tools/ci/pr-merge-report.rs", content) unless scenario == 'installation'
      if scenario == 'modified_reporter'
        File.open("#{root}/workspace/tools/ci/pr-merge-report.rs", 'a') { |file| file.puts('# changed after checkout') }
      end
    when /\Aactions\/upload-artifact@/
      name = interpolate(step.fetch('with').fetch('name'), context)
      artifact = "#{root}/artifacts/#{name}"
      if File.exist?(artifact)
        failed = true
        File.open("#{root}/errors", 'a') { |file| file.puts("Artifact already exists in this run: #{name}") }
      else
        FileUtils.mkdir_p(artifact)
        interpolate(step.fetch('with').fetch('path'), context).lines.map(&:strip).each do |path|
          FileUtils.cp(path, artifact) if File.file?(path)
        end
      end
    when nil
      _, stderr, status = Open3.capture3(env, BASH, '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.fetch('run'),
        chdir: "#{root}/workspace", unsetenv_others: true)
      File.open("#{root}/errors", 'a') { |file| file.puts(stderr) }
      failed ||= !status.success?
    else
      raise "Uncontrolled action: #{step['uses']}"
    end
    outputs = File.exist?(env['GITHUB_OUTPUT']) ? File.readlines(env['GITHUB_OUTPUT']).map(&:strip).map { |line| line.split('=', 2) }.to_h : {}
    context['steps'][step['id']] = {'outputs' => outputs} if step['id']
  end
  {failed: failed, root: root, original_comments: original_comments, artifact: artifact}
end

def assert_no_code_or_publication(result)
  %w[compilations executions posts edits].each do |effect|
    raise "Rejected scenario reached #{effect}: #{result[:root]}" if File.exist?("#{result[:root]}/#{effect}")
  end
  raise 'Rejected scenario changed comments' unless File.read("#{result[:root]}/comments.json") == result[:original_comments]
end

failure = exercise(workflow, "#{ARGV[0]}/readback", 'readback_failure', parent, head)
raise 'Readback failure suppressed' unless failure[:failed]
report = File.read("#{failure[:root]}/temp/merge-outcomes.md")
raise 'Report lost after POST' unless report.include?('Full timing rows')
raise 'Summary lost after POST' unless File.read("#{failure[:root]}/summary").include?(report)
raise 'Artifact lost after POST' unless File.read("#{failure[:artifact]}/merge-outcomes.md") == report
first = exercise(workflow, "#{ARGV[0]}/recovery", 'recovery_failure', parent, head, reporter: reporter_source)
raise 'Real readback failure suppressed' unless first[:failed]
first_report = File.read("#{first[:root]}/temp/merge-outcomes.md")
raise 'Failed attempt lost full report' unless first_report.include?('+209 / -10 lines across 5 files')
raise 'Failed attempt omitted unfinished check' unless first_report.include?('[Unfinished check]')
raise 'Failed attempt omitted pending status' unless first_report.include?('[Pending status]')
raise 'Failed attempt omitted queued checks' unless first_report.include?('[Queued app check]') && first_report.include?('[Queued Actions check]')
raise 'Failed attempt lost unfinished results or durations' unless first_report.scan(/\| (?:unfinished|unfinished at merge|pending) \| unavailable \|/).length == 4
raise 'Failed attempt lost artifact' unless File.read("#{first[:artifact]}/merge-outcomes.md") == first_report
raise 'Failed attempt claimed qualification' if File.exist?("#{first[:artifact]}/merge-outcomes-receipt.json")
first_artifact = Dir["#{first[:artifact]}/*"].to_h { |path| [File.basename(path), File.binread(path)] }
published = JSON.parse(File.read("#{first[:root]}/comments.json"))
raise 'Failed readback did not follow POST' unless File.read("#{first[:root]}/posts") == "POST\n"
mismatch_root = "#{ARGV[0]}/recovery-mismatch"
FileUtils.cp_r(first[:root], mismatch_root)
wrong = JSON.parse(File.read("#{mismatch_root}/comments.json"))
wrong.find { |comment| comment['id'] == 123 }['body'].sub!('+209 / -10', '+999 / -10')
File.write("#{mismatch_root}/comments.json", JSON.generate(wrong))
mismatch = exercise(workflow, mismatch_root, 'recovery_failure', parent, head, reporter: reporter_source, retrying: true)
raise 'Recovery accepted incorrect existing report' unless mismatch[:failed]
raise 'Integrity failure was not diagnosed' unless File.read("#{mismatch[:root]}/errors").include?('Existing merge report did not match the expected single report; stop and investigate, do not retry')
raise 'Integrity failure published another comment' unless File.read("#{mismatch[:root]}/posts") == "POST\n"
raise 'Integrity failure edited existing comments' unless JSON.parse(File.read("#{mismatch[:root]}/comments.json")) == wrong
raise 'Integrity failure attempted to edit a comment' if File.exist?("#{mismatch[:root]}/edits")
raise 'Integrity failure claimed qualification' if File.exist?("#{mismatch[:root]}/temp/merge-outcomes-receipt.json") || File.exist?("#{mismatch[:artifact]}/merge-outcomes-receipt.json")
raise 'Integrity failure lost generated report' unless File.read("#{mismatch[:artifact]}/merge-outcomes.md") == first_report
raise 'Integrity failure lost summary' unless File.read("#{mismatch[:root]}/summary").include?(first_report)
raise 'Integrity failure changed the first artifact' unless Dir["#{mismatch[:root]}/artifacts/merge-outcomes-1/*"].to_h { |path| [File.basename(path), File.binread(path)] } == first_artifact
recovered = exercise(workflow, first[:root], 'recovery', parent, head, reporter: reporter_source, retrying: true)
raise File.read("#{recovered[:root]}/errors") if recovered[:failed]
raise 'Recovery published another comment' unless File.read("#{recovered[:root]}/posts") == "POST\n"
raise 'Recovery changed published comments' unless JSON.parse(File.read("#{recovered[:root]}/comments.json")) == published
recovered_report = File.read("#{recovered[:root]}/temp/merge-outcomes.md")
raise 'Post-merge start or completion changed merge-time results' unless recovered_report == first_report
raise 'Recovery did not freeze unfinished merge-time outcomes' unless recovered_report.scan('| unfinished at merge | unavailable |').length == 4
raise 'Recovered attempt lost full report' unless recovered_report.include?('+209 / -10 lines across 5 files')
raise 'Recovered summary lost report' unless File.read("#{recovered[:root]}/summary").include?(recovered_report)
raise 'Recovered artifact lost report' unless File.read("#{recovered[:artifact]}/merge-outcomes.md") == recovered_report
recovered_receipt = JSON.parse(File.read("#{recovered[:artifact]}/merge-outcomes-receipt.json"))
raise 'Recovered receipt lost run, revision, attempt or opening report' unless recovered_receipt.values_at('run_id', 'reporter_revision', 'run_attempt', 'opening_report_count') == ['1234', parent, '2', 1]
raise 'Attempts did not retain distinct artifact identities' unless Dir.children("#{first[:root]}/artifacts").sort == ['merge-outcomes-1', 'merge-outcomes-2']
raise 'First attempt artifact identity changed' unless File.basename(first[:artifact]) == 'merge-outcomes-1'
raise 'Recovered artifact identity lost its attempt' unless File.basename(recovered[:artifact]) == 'merge-outcomes-2'
raise 'Recovery changed the first artifact' unless Dir["#{first[:artifact]}/*"].to_h { |path| [File.basename(path), File.binread(path)] } == first_artifact
boundaries = exercise(workflow, "#{ARGV[0]}/boundaries", 'recovery_boundaries', parent, head, reporter: reporter_source)
raise File.read("#{boundaries[:root]}/errors") if boundaries[:failed]
boundary_report = File.read("#{boundaries[:root]}/temp/merge-outcomes.md")
raise 'Queued checks lost merge-time membership' unless boundary_report.include?('[Queued app check]') && boundary_report.include?('[Queued Actions check]')
raise 'Included checks outside the PR window' if boundary_report.include?('[Late app check]') || boundary_report.include?('[Late Actions check]') || boundary_report.include?('[Prior app check]')
suite_failure = exercise(workflow, "#{ARGV[0]}/suite-failure", 'recovery_suite_failure', parent, head, reporter: reporter_source)
raise 'Suite API failure suppressed' unless suite_failure[:failed]
raise 'Suite API failure was not diagnosed' unless File.read("#{suite_failure[:root]}/errors").include?('GitHub read failed for check-suites/301')
raise 'Suite API failure published a comment' if File.exist?("#{suite_failure[:root]}/posts")
valid = exercise(workflow, "#{ARGV[0]}/valid", 'valid', parent, head)
raise File.read("#{valid[:root]}/errors") if valid[:failed]
raise 'Successful report did not execute the trusted reporter exactly once' unless File.read("#{valid[:root]}/executions") == "trusted\n"
raise 'Recovered receipt did not verify one report' unless recovered_receipt['report_unique']
valid_comments = JSON.parse(File.read("#{valid[:root]}/comments.json"))
valid_reports = valid_comments.select { |comment| comment.dig('user', 'login') == 'github-actions[bot]' && comment['body'].include?('<!-- nemoclaw-merge-report:v1 -->') }
raise 'Successful report was missing or duplicated' unless valid_reports.length == 1
raise 'Successful report lost merged identity' unless valid_reports.first.fetch('body').start_with?('<details>') && valid_reports.first.fetch('body').include?(head)
raise 'Successful report changed existing comments' unless valid_comments.reject { |comment| comment == valid_reports.first } == JSON.parse(valid[:original_comments])
raise 'Checkout persisted credentials' if File.exist?("#{valid[:root]}/credentials")
receipt = JSON.parse(File.read("#{valid[:artifact]}/merge-outcomes-receipt.json"))
raise 'Receipt is not revision-bound' unless receipt.values_at('workflow_revision', 'reporter_revision') == ['e' * 40, parent]
raise 'Fork-modified reporter scenario was not covered' unless receipt['fork_modified_reporter']
raise 'Opening report was absent' unless receipt['opening_report_count'] == 1
raise 'Receipt did not verify one report' unless receipt['report_unique']
extended_workflow = Marshal.load(Marshal.dump(workflow))
(extended_workflow['on'] || extended_workflow[true]).fetch('pull_request_target').fetch('branches') << 'release'
[[workflow, 'v1'], [extended_workflow, 'release']].each do |selected_workflow, base|
  result = exercise(selected_workflow, "#{ARGV[0]}/#{base}", 'valid', parent, head, base: base, reporter: reporter_source)
  raise File.read("#{result[:root]}/errors") if result[:failed]
  raise "#{base} merge did not compile the trusted reporter" unless File.exist?("#{result[:root]}/compilations") && File.read("#{result[:root]}/compilations") == "compile\n"
  raise "#{base} merge did not publish exactly once" unless File.read("#{result[:root]}/posts") == "POST\n"
  comments = JSON.parse(File.read("#{result[:root]}/comments.json"))
  reports = comments.select { |comment| comment.dig('user', 'login') == 'github-actions[bot]' && comment['body'].include?('<!-- nemoclaw-merge-report:v1 -->') }
  raise "#{base} merge lost or duplicated its report" unless reports.length == 1
  report = reports.first.fetch('body')
  raise "#{base} report lost merged metadata" unless report.start_with?('<details>') && report.include?(head) && report.include?('+209 / -10 lines across 5 files')
  raise "#{base} merge changed existing comments" unless comments.reject { |comment| comment['id'] == 123 } == JSON.parse(result[:original_comments])
  raise "#{base} artifact lost the report" unless File.read("#{result[:artifact]}/merge-outcomes.md").strip == report.strip
  raise "#{base} summary lost the report" unless File.read("#{result[:root]}/summary").include?(report)
  receipt = JSON.parse(File.read("#{result[:artifact]}/merge-outcomes-receipt.json"))
  raise "#{base} receipt lost trusted provenance" unless receipt.values_at('reporter_revision', 'publication_readback', 'opening_preserved', 'report_unique') == [parent, true, true, true]
end
raise 'Report job must stay read-only for contents' unless workflow.dig('jobs', 'report', 'permissions', 'contents') == 'read'
%w[rebase_enabled merge_enabled settings_unreadable unassociated_parent].each do |scenario|
  result = exercise(workflow, "#{ARGV[0]}/#{scenario}", scenario, parent, head, reporter: reporter_source)
  raise "Valid squash merge blocked by later repository settings: #{scenario}" if result[:failed]
  raise "Valid squash merge did not publish once: #{scenario}" unless File.read("#{result[:root]}/posts") == "POST\n"
  comments = JSON.parse(File.read("#{result[:root]}/comments.json"))
  reports = comments.select { |comment| comment.dig('user', 'login') == 'github-actions[bot]' && comment['body'].include?('<!-- nemoclaw-merge-report:v1 -->') }
  raise "Valid squash merge lost or duplicated its report: #{scenario}" unless reports.length == 1
  raise "Report still reads mutable settings: #{scenario}" if File.readlines("#{result[:root]}/requests").any? { |line| line.strip == 'repos/example/repo' }
end
%w[malformed multiple api_failure wrong_checkout modified_reporter rebased_parent paged_parent invalid_parent_association parent_api_failure].each do |scenario|
  result = exercise(workflow, "#{ARGV[0]}/#{scenario}", scenario, parent, head)
  raise "Invalid parent or checkout accepted: #{scenario}" unless result[:failed]
  unless %w[wrong_checkout modified_reporter].include?(scenario)
    raise "Rejected parent reached checkout: #{scenario}" if File.exist?("#{result[:root]}/checkout")
  end
  assert_no_code_or_publication(result)
end
raise 'Report must not depend on a mutable-settings job' if workflow.dig('jobs', 'report', 'needs')
raise 'Workflow must not grant contents write' if workflow.fetch('jobs').values.any? { |job| job.dig('permissions', 'contents') == 'write' }
installation = exercise(workflow, "#{ARGV[0]}/installation", 'installation', parent, head)
raise 'Installation failed' if installation[:failed]
assert_no_code_or_publication(installation)
raise 'Installation behavior missing' unless File.read("#{installation[:root]}/summary").include?('reports start with the next merged PR')
[[false, 'closed', 'main'], [true, 'opened', 'main'], [true, 'closed', 'release']].each_with_index do |(merged, action, base), index|
  result = exercise(workflow, "#{ARGV[0]}/ineligible-#{index}", 'valid', parent, head, merged: merged, action: action, base: base)
  raise 'Ineligible event failed' if result[:failed]
  assert_no_code_or_publication(result)
end
puts 'Trusted checkout, denied parents/events, installation, fixture receipt and publication recovery passed'
"##;
    let sysroot = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(sysroot.status.success());
    let compiler = std::path::Path::new(std::str::from_utf8(&sysroot.stdout).unwrap().trim())
        .join("bin/rustc");
    let output = Command::new("ruby")
        .args(["-", directory.to_str().unwrap()])
        .env_clear()
        .env("PATH", env::var_os("PATH").unwrap())
        .env("REAL_RUSTC", compiler)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(script.as_bytes())?;
            child.wait_with_output()
        })
        .unwrap();
    fs::remove_dir_all(directory).unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
