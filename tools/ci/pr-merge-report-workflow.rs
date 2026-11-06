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
    printf '{"total_count":2,"workflow_runs":[{"id":12,"head_repository":{"id":99},"head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","created_at":"2026-01-01T00:04:00Z","workflow_id":9,"event":"pull_request","head_branch":"fork-feature","pull_requests":[]},{"id":13,"head_repository":{"id":100},"head_sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","created_at":"2026-01-01T00:04:00Z","workflow_id":9,"head_branch":"fork-feature","pull_requests":[]}]}\n' ;;
  repos/example/repo/commits/*/check-runs*)
    if [ "$SCENARIO" = api_failure ]; then exit 42; fi
    if [[ "$endpoint" = */aaaaaaaa*/check-runs* ]]; then
      printf '{"check_runs":[{"id":101,"name":"Unit | <script> @someone","app":{"id":1,"slug":"github-actions"},"started_at":"2026-01-01T00:01:10Z","completed_at":"2026-01-01T00:02:00Z","conclusion":"failure","details_url":"https://github.com/example/repo/actions/runs/11/job/101"}]}\n'
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
  repos/example/repo/commits/*/statuses*)
    printf '[{"id":103,"context":"Legacy gate","state":"success","created_at":"2026-01-01T00:06:00Z","updated_at":"2026-01-01T00:06:00Z"}]\n' ;;
  repos/example/repo/issues/1/comments*)
    printf '[{"user":{"login":"outsider"},"body":"<!-- nemoclaw-merge-report:v1 -->"}]\n'
    if [ "$SCENARIO" = existing ]; then
      printf '[{"user":{"login":"github-actions[bot]"},"body":"<!-- nemoclaw-merge-report:v1 -->"}]\n'
    else printf '[]\n'; fi ;;
  repos/example/repo/issues/comments/123)
    if [ "$SCENARIO" = readback_failure ]; then exit 44; fi
    jq -n --rawfile body "$FIXTURE/posted-body" '{body:$body}' ;;
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
if grep -F 'Other fork' "$FIXTURE/preview" >&2; then exit 1; fi
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
if SCENARIO=readback_failure "$FIXTURE/reporter" example/repo 1 --post > "$FIXTURE/retained-report"; then exit 1; fi
test "$(wc -l < "$FIXTURE/writes" | tr -d ' ')" = 1
grep -Fq '+209 / -10 lines across 5 files' "$FIXTURE/retained-report"
grep -Fq '</details>' "$FIXTURE/retained-report"
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
workflow = YAML.safe_load(File.read('.github/workflows/pr-merge-report.yml'))
parent = 'a' * 40
head = 'b' * 40

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

def exercise(workflow, root, scenario, parent, head, merged: true, action: 'closed')
  FileUtils.mkdir_p(["#{root}/bin", "#{root}/workspace", "#{root}/temp", "#{root}/artifacts"])
  File.write("#{root}/summary", '')
  File.write("#{root}/comments.json", JSON.generate([
    {id: 10, user: {login: 'author'}, body: '<details><!-- agent-session-report:v1 -->opening</details>'},
    {id: 11, user: {login: 'outsider'}, body: '<!-- nemoclaw-merge-report:v1 -->'}
  ]))
  File.write("#{root}/bin/gh", <<~'SH')
    #!/bin/bash
    set -euo pipefail
    endpoint=''; query='.'; slurp=false
    while [ "$#" -gt 0 ]; do
      case "$1" in
        repos/*) endpoint="$1" ;;
        --jq) query="$2"; shift ;;
        --slurp) slurp=true ;;
      esac
      shift
    done
    case "$endpoint" in
      repos/example/repo) printf '{"allow_squash_merge":true,"allow_merge_commit":false,"allow_rebase_merge":false}' ;;
      repos/example/repo/commits/*)
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
      *) printf 'Unexpected API: %s\n' "$endpoint" >&2; exit 43 ;;
    esac | jq -r "$query"
  SH
  File.write("#{root}/bin/rustc", <<~'SH')
    #!/bin/bash
    set -euo pipefail
    test -z "${GH_TOKEN:-}"
    cp "$4" "$6"
    chmod +x "$6"
  SH
  File.write("#{root}/bin/git", <<~'SH')
    #!/bin/bash
    set -euo pipefail
    case "$*" in
      'diff --exit-code -- tools/ci/pr-merge-report.rs') exit 0 ;;
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
  context = {'github' => {'event_name' => 'pull_request_target', 'repository' => 'example/repo', 'token' => 'fixture-token',
    'event' => {'pull_request' => {'merged' => merged, 'number' => 1, 'merge_commit_sha' => 'd' * 40,
      'head' => {'sha' => head, 'repo' => {'full_name' => 'example/fork'}}}}},
    'runner' => {'temp' => "#{root}/temp"}, 'steps' => {}}
  job = workflow.fetch('jobs').fetch('report')
  trigger = (workflow['on'] || workflow[true]).fetch('pull_request_target')
  eligible = trigger.fetch('types').include?(action) && trigger.fetch('branches').include?('main')
  failed = false
  return {failed: false, root: root} unless eligible && selected(job['if'], context, failed)
  job.fetch('steps').each_with_index do |step, index|
    next unless selected(step['if'], context, failed)
    env = {'PATH' => "#{root}/bin:/usr/bin:/bin", 'FIXTURE' => root, 'SCENARIO' => scenario,
      'RUNNER_TEMP' => "#{root}/temp", 'GITHUB_REPOSITORY' => 'example/repo', 'GITHUB_STEP_SUMMARY' => "#{root}/summary",
      'GITHUB_WORKFLOW_SHA' => 'e' * 40, 'GITHUB_RUN_ID' => '1234', 'GITHUB_RUN_ATTEMPT' => '1', 'GITHUB_OUTPUT' => "#{root}/output-#{index}"}
    (step['env'] || {}).each { |key, text| env[key] = interpolate(text, context) }
    case step['uses']
    when /\Aactions\/checkout@/
      ref = interpolate(step.fetch('with').fetch('ref'), context)
      repository = interpolate(step.fetch('with').fetch('repository'), context)
      raise 'Wrong checkout repository' unless repository == 'example/repo'
      File.write("#{root}/credentials", 'persisted') unless step.fetch('with')['persist-credentials'] == false
      File.write("#{root}/checkout", ref)
      FileUtils.mkdir_p("#{root}/workspace/tools/ci")
      content = {parent => trusted, head => "#!/bin/bash\nprintf 'PR code' >> \"$FIXTURE/executions\"\nexit 90\n"}.fetch(ref)
      File.write("#{root}/workspace/tools/ci/pr-merge-report.rs", content) unless scenario == 'installation'
    when /\Aactions\/upload-artifact@/
      interpolate(step.fetch('with').fetch('path'), context).lines.map(&:strip).each do |path|
        FileUtils.cp(path, "#{root}/artifacts") if File.file?(path)
      end
    when nil
      _, stderr, status = Open3.capture3(env, 'bash', '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.fetch('run'),
        chdir: "#{root}/workspace", unsetenv_others: true)
      File.open("#{root}/errors", 'a') { |file| file.puts(stderr) }
      failed ||= !status.success?
    else
      raise "Uncontrolled action: #{step['uses']}"
    end
    outputs = File.exist?(env['GITHUB_OUTPUT']) ? File.readlines(env['GITHUB_OUTPUT']).map(&:strip).map { |line| line.split('=', 2) }.to_h : {}
    context['steps'][step['id']] = {'outputs' => outputs} if step['id']
  end
  {failed: failed, root: root}
end

failure = exercise(workflow, "#{ARGV[0]}/readback", 'readback_failure', parent, head)
raise 'Readback failure suppressed' unless failure[:failed]
report = File.read("#{failure[:root]}/temp/merge-outcomes.md")
raise 'Report lost after POST' unless report.include?('Full timing rows')
raise 'Summary lost after POST' unless File.read("#{failure[:root]}/summary").include?(report)
raise 'Artifact lost after POST' unless File.read("#{failure[:root]}/artifacts/merge-outcomes.md") == report
valid = exercise(workflow, "#{ARGV[0]}/valid", 'valid', parent, head)
raise File.read("#{valid[:root]}/errors") if valid[:failed]
raise 'PR source executed' unless File.read("#{valid[:root]}/executions") == "trusted\ntrusted\n"
raise 'Checkout persisted credentials' if File.exist?("#{valid[:root]}/credentials")
receipt = JSON.parse(File.read("#{valid[:root]}/artifacts/merge-outcomes-receipt.json"))
raise 'Receipt is not revision-bound' unless receipt.values_at('workflow_revision', 'reporter_revision') == ['e' * 40, parent]
raise 'Fork-modified reporter scenario was not covered' unless receipt['fork_modified_reporter']
raise 'Opening report was absent' unless receipt['opening_report_count'] == 1
%w[malformed multiple api_failure].each do |scenario|
  result = exercise(workflow, "#{ARGV[0]}/#{scenario}", scenario, parent, head)
  raise 'Invalid parent accepted' unless result[:failed] && !File.exist?("#{result[:root]}/executions")
end
installation = exercise(workflow, "#{ARGV[0]}/installation", 'installation', parent, head)
raise 'Installation attempted publication' if installation[:failed] || File.exist?("#{installation[:root]}/executions")
raise 'Installation behavior missing' unless File.read("#{installation[:root]}/summary").include?('reports start with the next merged PR')
[[false, 'closed'], [true, 'opened']].each_with_index do |(merged, action), index|
  result = exercise(workflow, "#{ARGV[0]}/ineligible-#{index}", 'valid', parent, head, merged: merged, action: action)
  raise 'Ineligible event published' if result[:failed] || File.exist?("#{result[:root]}/executions")
end
puts 'Trusted checkout, denied parents/events, installation, hosted receipt and failed-publication retention passed'
"##;
    let output = Command::new("ruby")
        .args(["-", directory.to_str().unwrap()])
        .env_clear()
        .env("PATH", env::var_os("PATH").unwrap())
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
