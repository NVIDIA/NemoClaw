#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

OWNER_FILE="${WORK_DIR}.workspace-owner"
SSH_OPTIONS=(-T -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o LogLevel=ERROR)
log() { printf '%s\n' "$*" | tee -a "$WORK_DIR/lane.log"; }
fail() {
  log "FAILED: $*" >&2
  exit 1
}
require() {
  local name="$1"
  [ -n "${!name:-}" ] || fail "$name is required"
}

workspace_rows() {
  timeout 30s brev ls --json | jq -c '
    if type == "array" then .
    elif type == "object" and has("workspaces") and .workspaces == null then []
    elif type == "object" and (.workspaces | type) == "array" then .workspaces
    else error("unexpected brev ls --json shape") end'
}
workspace() {
  workspace_rows | jq -c --arg name "$INSTANCE_NAME" '
    map(select(((.name // .workspaceName // .instanceName // "") | tostring) == $name))
    | if length == 0 then empty elif length == 1 then .[0]
      else error("workspace name is ambiguous") end'
}
write_cleanup_evidence() {
  local status="$1" workspace_id="${2:-}"
  jq -n --arg workspaceName "$INSTANCE_NAME" --arg workspaceId "$workspace_id" \
    --arg status "$status" --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion:1,workspaceName:$workspaceName,workspaceId:$workspaceId,status:$status,checkedAt:$checkedAt}' \
    >"$WORK_DIR/cleanup.json"
}
cleanup_owned_workspace() {
  local existing="" workspace_id="" absent=0
  if [ ! -e "$OWNER_FILE" ]; then
    if ! existing="$(workspace)"; then
      write_cleanup_evidence UNKNOWN
      fail "cleanup could not inspect workspace inventory without an ownership receipt"
    fi
    if [ -z "$existing" ]; then
      write_cleanup_evidence ABSENT
      return
    fi
    write_cleanup_evidence NOT_OWNED "$(jq -r '.id // ""' <<<"$existing")"
    fail "cleanup refused because a matching workspace exists without an ownership receipt"
  fi
  if ! jq -e --arg name "$INSTANCE_NAME" '.workspaceName == $name and .owned == true' \
    "$OWNER_FILE" >/dev/null 2>&1; then
    write_cleanup_evidence NOT_OWNED
    fail "cleanup refused because the ownership receipt is invalid"
  fi
  existing="$(workspace || true)"
  workspace_id="$(jq -r '.id // ""' <<<"${existing:-{}}")"
  if [ -n "$existing" ]; then
    log "Deleting workflow-owned workspace $INSTANCE_NAME"
    timeout 60s brev delete "$INSTANCE_NAME" || true
  fi
  local deadline=$((SECONDS + ${BREV_DELETE_TIMEOUT_SECONDS:-600}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if existing="$(workspace)"; then
      if [ -z "$existing" ]; then
        absent=$((absent + 1))
        if [ "$absent" -ge 2 ]; then
          write_cleanup_evidence ABSENT "$workspace_id"
          rm -f -- "$OWNER_FILE"
          return
        fi
      else
        absent=0
      fi
    else
      absent=0
    fi
    timeout 30s brev refresh >/dev/null 2>&1 || true
    sleep "${POLL_SECONDS:-15}"
  done
  write_cleanup_evidence UNKNOWN "$workspace_id"
  fail "cleanup could not confirm workspace absence"
}
redact_file() {
  local source="$1" target="$2"
  NEMOCLAW_REDACTION_SECRET="$NVIDIA_API_KEY" python3 - "$source" "$target" <<'PY'
import os
import re
import sys
from pathlib import Path
source, target = sys.argv[1:]
text = Path(source).read_text(encoding="utf-8", errors="replace")
secret = os.environ["NEMOCLAW_REDACTION_SECRET"]
if secret:
    text = text.replace(secret, "[REDACTED]")
text = re.sub(r"(?i)(?:nvapi-|sk-)[A-Za-z0-9_./+=-]{8,}", "[REDACTED]", text)
Path(target).write_text(text[-65536:], encoding="utf-8")
Path(source).unlink(missing_ok=True)
PY
}

for name in WORK_DIR INSTANCE_NAME; do require "$name"; done
for tool in brev jq python3 timeout; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"; done
[[ "$INSTANCE_NAME" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || fail "INSTANCE_NAME is invalid"
mkdir -p "$WORK_DIR"
chmod 700 "$WORK_DIR"
touch "$WORK_DIR/lane.log"
if [ "${1:-}" = cleanup-owned-workspace ] && [ "$#" -eq 1 ]; then
  cleanup_owned_workspace
  exit 0
elif [ "$#" -ne 0 ]; then
  fail "only cleanup-owned-workspace is accepted as an argument"
fi

require BREV_LAUNCHABLE_ID
require GH_TOKEN
require NVIDIA_API_KEY
command -v gh >/dev/null 2>&1 || fail "gh is required"
command -v ssh >/dev/null 2>&1 || fail "ssh is required"
[[ "$BREV_LAUNCHABLE_ID" =~ ^env-[A-Za-z0-9]+$ ]] || fail "BREV_LAUNCHABLE_ID is invalid"
[[ "$NVIDIA_API_KEY" == nvapi-* ]] || fail "NVIDIA_API_KEY must be a public NVIDIA Endpoints key"
write_cleanup_evidence NOT_OWNED
handoff_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/issue-9880-handoff.XXXXXX")"
latest_runs="$(gh api 'repos/brevdev/nemoclaw-image/actions/workflows/build-launchable-e2e-image.yml/runs?branch=main&event=workflow_dispatch&status=success&per_page=20')"
producer_run="$(jq -er '[.workflow_runs[] | select(.display_title | startswith("Build Launchable E2E image for NemoClaw "))] | sort_by(.created_at) | last | .id' <<<"$latest_runs")"
gh run download "$producer_run" --repo brevdev/nemoclaw-image \
  --name "nemoclaw-image-handoff-v1-${producer_run}-1" --dir "$handoff_dir"
manifest="$handoff_dir/nemoclaw-image-manifest.v1.json"
jq -e --arg run "$producer_run" '
  .schemaVersion == 1 and .kind == "nemoclaw-exact-image-manifest" and
  .imageRepository == "brevdev/nemoclaw-image" and
  .producerWorkflow == ".github/workflows/build-launchable-e2e-image.yml" and
  .workflowRunId == $run and .workflowRunAttempt == 1 and .status == "READY" and
  .channel == "staging" and .variant == "cpu" and
  .observedFamily == "nemoclaw-brev-staging-cpu" and
  (.project | type == "string" and length > 0) and
  (.imageName | type == "string" and length > 0) and
  (.nemoclawSha | test("^[0-9a-f]{40}$")) and
  (.imageRepositorySha | test("^[0-9a-f]{40}$"))' "$manifest" >/dev/null \
  || fail "latest staging image handoff is invalid"
expected_boot_image="projects/$(jq -er .project "$manifest")/global/images/$(jq -er .imageName "$manifest")"
expected_nemoclaw_sha="$(jq -er .nemoclawSha "$manifest")"
expected_image_repository_sha="$(jq -er .imageRepositorySha "$manifest")"
rm -rf -- "$handoff_dir"
log "Bound latest successful staging image producer run $producer_run"
[ -z "$(workspace || true)" ] || fail "workspace name already exists"
jq -n --arg workspaceName "$INSTANCE_NAME" '{workspaceName:$workspaceName,owned:true}' >"$OWNER_FILE"
chmod 600 "$OWNER_FILE"
log "Deploying the current standing staging Launchable"
timeout 900s brev create "$INSTANCE_NAME" --launchable "$BREV_LAUNCHABLE_ID" --detached --timeout 900

deadline=$((SECONDS + ${BREV_READY_TIMEOUT_SECONDS:-1200}))
ready=""
while [ "$SECONDS" -lt "$deadline" ]; do
  ready="$(workspace || true)"
  if jq -e '.status == "RUNNING" and (.shell_status // .shellStatus) == "READY" and
    (.build_status // .buildStatus) == "COMPLETED"' <<<"${ready:-null}" >/dev/null; then break; fi
  state="$(jq -r '(.status // "") + ":" + (.build_status // .buildStatus // "")' <<<"${ready:-null}")"
  [[ "$state" =~ FAILURE|FAILED|ERROR|CREATE_FAILED ]] && fail "workspace entered $state"
  sleep "${POLL_SECONDS:-15}"
done
jq -e '.status == "RUNNING" and (.shell_status // .shellStatus) == "READY" and
  (.build_status // .buildStatus) == "COMPLETED"' <<<"${ready:-null}" >/dev/null \
  || fail "workspace readiness timed out"
workspace_id="$(jq -r '.id // ""' <<<"$ready")"
log "Workspace $INSTANCE_NAME ($workspace_id) is ready"
timeout 60s brev refresh >/dev/null || fail "Brev SSH configuration refresh failed"

# The remote shell expands the single-quoted command.
# shellcheck disable=SC2016
identity="$(timeout 300s brev exec "$INSTANCE_NAME" 'set -euo pipefail
  source_path=$(sudo -n jq -er .sourcePath /etc/nemoclaw/provision.json)
  source_repository=$(sudo -n jq -er .sourceRepository /etc/nemoclaw/provision.json)
  provision_sha=$(sudo -n jq -er .gitSha /etc/nemoclaw/provision.json)
  image_repository_sha=$(sudo -n jq -er .imageRepositorySha /etc/nemoclaw/provision.json)
  repo_sha=$(git -C "$source_path" rev-parse HEAD)
  test -z "$(git -C "$source_path" status --porcelain --untracked-files=normal)"
  sudo -n test ! -e /etc/nemoclaw/runtime-overrides.json
  boot_image=$(curl -fsS --max-time 10 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/image)
  jq -cn --arg sourceRepository "$source_repository" --arg sourcePath "$source_path" \
    --arg provisionSha "$provision_sha" --arg imageRepositorySha "$image_repository_sha" \
    --arg repoSha "$repo_sha" --arg bootImage "$boot_image" \
    "{sourceRepository:\$sourceRepository,sourcePath:\$sourcePath,provisionSha:\$provisionSha,imageRepositorySha:\$imageRepositorySha,repoSha:\$repoSha,bootImage:\$bootImage,repoClean:true,runtimeOverrides:false}"' | tail -n 1)"
jq -e --arg expectedBootImage "$expected_boot_image" --arg expectedSha "$expected_nemoclaw_sha" \
  --arg expectedImageRepositorySha "$expected_image_repository_sha" '
  .sourceRepository == "NVIDIA/NemoClaw" and
  .sourcePath == "/opt/nemoclaw-image/NemoClaw" and
  .provisionSha == $expectedSha and .repoSha == $expectedSha and
  .imageRepositorySha == $expectedImageRepositorySha and .bootImage == $expectedBootImage and
  .repoClean == true and .runtimeOverrides == false' <<<"$identity" >/dev/null \
  || fail "standing Launchable runtime identity does not match the latest staging handoff"
log "Verified standing Launchable runtime identity before credential exposure"

raw_log="$(mktemp "${RUNNER_TEMP:-/tmp}/issue-9880.XXXXXX")"
chmod 600 "$raw_log"
set +e
{
  printf 'export NVIDIA_INFERENCE_API_KEY=%q\n' "$NVIDIA_API_KEY"
  cat <<'REMOTE'
set -euo pipefail
export NEMOCLAW_MODEL=meta/llama-3.3-70b-instruct
export NEMOCLAW_PROVIDER=build
export NEMOCLAW_AGENT=openclaw
brev-quickstart issue-9880
nemoclaw issue-9880 exec -- node -e '
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const model = cfg?.agents?.defaults?.model?.primary;
if (model !== "inference/meta/llama-3.3-70b-instruct") {
  console.error(`unexpected managed model: ${String(model)}`);
  process.exit(1);
}
'
prompt='List 10 REST API endpoints for a blog service, one per line'
reproduced=0
for attempt in 1 2 3 4 5; do
  session_id="e2e-issue-9880-$(date +%s)-$$-$attempt"
  output="$(mktemp)"
  set +e
  timeout --signal=TERM --kill-after=10s 90s nemoclaw issue-9880 exec -- \
    openclaw agent --agent main --json --thinking off --session-id "$session_id" -m "$prompt" \
    >"$output" 2>&1
  status=$?
  set -e
  classification="$(python3 - "$output" "$status" <<'PY'
import json
import re
import sys
from pathlib import Path
path, status_text = sys.argv[1:]
status = int(status_text)
text = Path(path).read_text(encoding="utf-8", errors="replace")
if status == 124:
    print("inconclusive-timeout")
    raise SystemExit
tool_invocations = len(re.findall(r"(?i)(invoking tool|tool[_ -]?call|tool_use)", text))
tool_refusals = len(re.findall(r"(?i)(tool call refused|does not exist|unknown tool|tool not found)", text))
if tool_invocations >= 2 and tool_refusals >= 2:
    print("reproduced-tool-loop")
    raise SystemExit
strings = []
try:
    root = json.loads(text)
except json.JSONDecodeError:
    strings.append(text)
else:
    def visit(value):
        if isinstance(value, str): strings.append(value)
        elif isinstance(value, list):
            for item in value: visit(item)
        elif isinstance(value, dict):
            for item in value.values(): visit(item)
    visit(root)
lines = "\n".join(strings).splitlines()
endpoints = {line.strip() for line in lines if re.match(r"^\s*(?:\d+[.)]\s*)?(?:GET|POST|PUT|PATCH|DELETE)\s+/\S+", line)}
print(
    "completed"
    if status == 0 and len(endpoints) >= 10 and tool_invocations == 0 and tool_refusals == 0
    else "unexpected"
)
PY
)"
  printf 'NEMOCLAW_ISSUE_9880_ATTEMPT=%s STATUS=%s CLASSIFICATION=%s\n' "$attempt" "$status" "$classification"
  tail -c 4096 "$output"
  rm -f "$output"
  if [[ "$classification" == reproduced-* ]]; then reproduced=1; break; fi
  [ "$classification" != inconclusive-timeout ] || exit 87
  [ "$classification" = completed ] || exit 2
done
if [ "$reproduced" -eq 1 ]; then exit 86; fi
REMOTE
} | ssh "${SSH_OPTIONS[@]}" "$INSTANCE_NAME" 'bash -s' >"$raw_log" 2>&1
scenario_status=$?
set -e
redact_file "$raw_log" "$WORK_DIR/issue-9880.log"

classification="completed"
if [ "$scenario_status" -eq 86 ]; then
  classification="reproduced"
elif [ "$scenario_status" -eq 87 ]; then
  classification="timeout"
elif [ "$scenario_status" -ne 0 ]; then classification="setup-or-unexpected-failure"; fi
jq -n --arg launchableId "$BREV_LAUNCHABLE_ID" --arg workspaceName "$INSTANCE_NAME" \
  --arg workspaceId "$workspace_id" --arg classification "$classification" \
  --arg producerRun "$producer_run" --argjson scenarioStatus "$scenario_status" \
  --argjson identity "$identity" \
  '{schemaVersion:1,kind:"nemoclaw-issue-9880-staging-reproduction-v1",launchableId:$launchableId,producerRunId:$producerRun,workspace:{name:$workspaceName,id:$workspaceId},runtimeIdentity:$identity,prompt:"List 10 REST API endpoints for a blog service, one per line",model:"meta/llama-3.3-70b-instruct",attemptLimit:5,turnTimeoutSeconds:90,classification:$classification,scenarioStatus:$scenarioStatus}' \
  >"$WORK_DIR/issue-9880.json"
case "$classification" in
  reproduced) fail "issue #9880 reproduced on the standing staging Launchable" ;;
  completed) log "Five fresh CLI sessions completed without reproducing issue #9880" ;;
  timeout) fail "issue #9880 trial timed out without issue-specific loop evidence" ;;
  *) fail "issue #9880 scenario failed before a conclusive result" ;;
esac
