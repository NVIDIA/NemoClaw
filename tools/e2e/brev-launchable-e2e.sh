#!/usr/bin/env bash

# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

IMAGE_REPOSITORY=brevdev/nemoclaw-image
IMAGE_WORKFLOW=build-launchable-e2e-image.yml
cleanup_required=0
diagnostic_capture=""
SSH_PROBE_OPTIONS=(-T -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1
  -o NumberOfPasswordPrompts=0 -o RequestTTY=no -o LogLevel=ERROR)

log() {
  printf '%s\n' "$*" | tee -a "$WORK_DIR/lane.log"
}

die() {
  log "FAILED: $*" >&2
  exit 1
}

require() {
  local name="$1"
  [ -n "${!name:-}" ] || die "$name is required"
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

sanitize_probe_error() {
  python3 -c '
import os
import re
import sys

retained = bytearray()
while chunk := sys.stdin.buffer.read(8192):
    if len(retained) < 4096:
        retained.extend(chunk[: 4096 - len(retained)])
data = bytes(retained).decode("utf-8", errors="replace")
for name in ("BREV_API_KEY", "GH_TOKEN", "NVIDIA_INFERENCE_API_KEY"):
    value = os.environ.get(name, "")
    if value:
        data = data.replace(value, "[REDACTED]")
instance = os.environ.get("INSTANCE_NAME", "")
if instance:
    data = data.replace(f"{instance}-host", "[REDACTED HOST]")
    data = data.replace(instance, "[REDACTED HOST]")
data = re.sub(
    r"-----BEGIN [^-\n]*PRIVATE KEY-----.*?-----END [^-\n]*PRIVATE KEY-----",
    "[REDACTED PRIVATE KEY]",
    data,
    flags=re.DOTALL,
)
data = re.sub(
    r"(?i)\b(authorization)\b(\s*[:=]\s*)[^\r\n]+",
    r"\1\2[REDACTED]",
    data,
)
data = re.sub(
    r"(?i)\b(api[_ -]?key|token|password|secret|credential|authorization)\b"
    r"(\s*[:=]\s*)(\"[^\"]*\"|\x27[^\x27]*\x27|\S+)",
    r"\1\2[REDACTED]",
    data,
)
data = re.sub(
    r"(?i)\b(identityfile|certificatefile|proxycommand|proxyjump)\s*[:=]\s*\S+",
    r"\1=[REDACTED SSH CONFIGURATION]",
    data,
)
data = re.sub(
    r"(?i)\b(host|hostname|address|endpoint)\s*[:=]\s*\S+",
    r"\1=[REDACTED ADDRESS]",
    data,
)
data = re.sub(r"(?i)(connect to host|resolve hostname)\s+\S+", r"\1 [REDACTED HOST]", data)
data = re.sub(r"(?i)\b(?:nvapi-|gh[pousr]_)[A-Za-z0-9_-]+", "[REDACTED]", data)
def redact_generic_token(match):
    value = match.group(0)
    if value in {
        "client_loop_send_disconnect",
        "kex_exchange_identification",
        "ssh_exchange_identification",
    }:
        return value
    return "[REDACTED]"

data = re.sub(
    r"(?<![A-Za-z0-9])[A-Za-z0-9_./+=-]{20,}(?![A-Za-z0-9])",
    redact_generic_token,
    data,
)
data = re.sub(r"https?://[^/\s]+", "[REDACTED ADDRESS]", data)
data = re.sub(r"(?<![\w])(?:\d{1,3}\.){3}\d{1,3}(?![\w])", "[REDACTED ADDRESS]", data)
data = re.sub(
    r"(?<![\w])(?:[0-9a-fA-F]{1,4}:){2,}[0-9a-fA-F:]{1,4}(?![\w])",
    "[REDACTED ADDRESS]",
    data,
)
data = re.sub(r"(?i)(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}", "[REDACTED ADDRESS]", data)

lines = []
debug_omitted = False
for raw_line in data.splitlines():
    line = " ".join(raw_line.split())
    if not line:
        continue
    if re.match(r"(?i)^debug[123]:", line):
        if not debug_omitted:
            lines.append("SSH debug output omitted")
            debug_omitted = True
        continue
    if re.match(
        r"(?i)^(hostname|user|port|identityfile|certificatefile|proxycommand|proxyjump)\s+",
        line,
    ):
        lines.append("[REDACTED SSH CONFIGURATION]")
        continue
    lines.append(re.sub(r"(?i)load key \S+", "SSH private key load failed", line))

result = " | ".join(dict.fromkeys(lines))
sys.stdout.write(result.encode("utf-8")[:512].decode("utf-8", errors="ignore"))
'
}

run_bounded_probe() {
  local timeout_seconds="$1"
  local output_name="$2"
  local status_name="$3"
  local output status
  local -a pipeline_status
  shift 3
  if [ -z "$diagnostic_capture" ]; then
    diagnostic_capture="$(mktemp "${RUNNER_TEMP:-/tmp}/brev-launchable-diagnostic.XXXXXX")"
  fi
  : >"$diagnostic_capture"
  set +e
  timeout "${timeout_seconds}s" "$@" 2>&1 \
    | sanitize_probe_error >"$diagnostic_capture"
  pipeline_status=("${PIPESTATUS[@]}")
  set -e
  status="${pipeline_status[0]}"
  output="$(<"$diagnostic_capture")"
  if [ -z "$output" ]; then
    if [ "$status" -eq 0 ]; then
      output="none"
    elif [ "$status" -eq 124 ]; then
      output="probe timed out"
    else
      output="no diagnostic output"
    fi
  fi
  [ -z "$output_name" ] || printf -v "$output_name" '%s' "$output"
  printf -v "$status_name" '%s' "$status"
}

wait_for_host_ssh() {
  local timeout_seconds="${BREV_HOST_SSH_TIMEOUT_SECONDS:-900}"
  local poll_seconds="${POLL_SECONDS:-5}"
  local deadline=$((SECONDS + timeout_seconds))
  local remaining refresh_timeout sleep_seconds ssh_timeout refresh_error ssh_error container_error
  local container_probed=0 container_status=1 attempts=0
  local refresh_status=1 ssh_status=1
  local last_refresh_error="" last_refresh_failure_status=""
  local last_ssh_error="" last_ssh_failure_status=""
  log "Waiting up to $timeout_seconds seconds for host SSH access"

  remaining=$((deadline - SECONDS))
  [ "$remaining" -gt 0 ] || die "host SSH readiness timed out"
  refresh_timeout=$((remaining < 60 ? remaining : 60))
  run_bounded_probe "$refresh_timeout" refresh_error refresh_status brev refresh
  if [ "$refresh_status" -ne 0 ]; then
    last_refresh_error="$refresh_error"
    last_refresh_failure_status="$refresh_status"
  fi

  remaining=$((deadline - SECONDS))
  if [ "$remaining" -gt 0 ]; then
    ssh_timeout=$((remaining < 15 ? remaining : 15))
    run_bounded_probe "$ssh_timeout" container_error container_status \
      ssh "${SSH_PROBE_OPTIONS[@]}" "$INSTANCE_NAME" true
    container_probed=1
  fi

  while [ "$SECONDS" -lt "$deadline" ]; do
    remaining=$((deadline - SECONDS))
    [ "$remaining" -gt 0 ] || break
    ssh_timeout=$((remaining < 15 ? remaining : 15))
    run_bounded_probe "$ssh_timeout" ssh_error ssh_status \
      ssh "${SSH_PROBE_OPTIONS[@]}" "${INSTANCE_NAME}-host" true
    if [ "$ssh_status" -eq 0 ]; then
      log "SSH access to ${INSTANCE_NAME}-host succeeded"
      return 0
    fi
    attempts=$((attempts + 1))
    last_ssh_error="$ssh_error"
    last_ssh_failure_status="$ssh_status"

    if [ $((attempts % 5)) -eq 0 ]; then
      remaining=$((deadline - SECONDS))
      [ "$remaining" -gt 0 ] || break
      refresh_timeout=$((remaining < 60 ? remaining : 60))
      run_bounded_probe "$refresh_timeout" refresh_error refresh_status brev refresh
      if [ "$refresh_status" -ne 0 ]; then
        last_refresh_error="$refresh_error"
        last_refresh_failure_status="$refresh_status"
      fi
    fi

    remaining=$((deadline - SECONDS))
    [ "$remaining" -gt 0 ] || break
    sleep_seconds="$poll_seconds"
    sleep "$((sleep_seconds < remaining ? sleep_seconds : remaining))"
  done

  if [ -n "$last_refresh_failure_status" ]; then
    log "Readiness Brev refresh last failure: status $last_refresh_failure_status; error: $last_refresh_error"
  else
    log "Readiness Brev refresh last failure: none"
  fi
  if [ -n "$last_ssh_failure_status" ]; then
    log "Readiness direct host SSH last failure: status $last_ssh_failure_status; error: $last_ssh_error"
  else
    log "Readiness direct host SSH last failure: none"
  fi
  if [ "$container_probed" -eq 0 ]; then
    log "Readiness initial default Brev container probe: not probed"
  else
    log "Readiness initial default Brev container probe: status $container_status; error: $container_error"
  fi
  if [ "$container_probed" -eq 0 ]; then
    log "Readiness classification: default Brev container and direct host SSH were not probed before deadline"
  elif [ -n "$last_ssh_failure_status" ]; then
    if [ "$container_status" -eq 0 ]; then
      log "Readiness classification: initial default Brev container probe succeeded; direct host SSH did not succeed before deadline"
    else
      log "Readiness classification: initial default Brev container probe failed; direct host SSH did not succeed before deadline"
    fi
  elif [ "$container_status" -eq 0 ]; then
    log "Readiness classification: initial default Brev container probe succeeded; direct host SSH was not probed before deadline"
  else
    log "Readiness classification: initial default Brev container probe failed; direct host SSH was not probed before deadline"
  fi
  die "host SSH readiness timed out"
}

cleanup() {
  local record deadline absent=0 workspace_id=""
  record="$(workspace || true)"
  workspace_id="$(jq -r '.id // ""' <<<"${record:-null}")"
  [ -z "$record" ] || timeout 60s brev delete "$INSTANCE_NAME" || true
  deadline=$((SECONDS + ${BREV_DELETE_TIMEOUT_SECONDS:-600}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if record="$(workspace)" && [ -z "$record" ]; then
      absent=$((absent + 1))
      if [ "$absent" -ge 2 ]; then
        jq -n --arg workspaceName "$INSTANCE_NAME" --arg workspaceId "$workspace_id" \
          --arg verifiedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          '{workspaceName:$workspaceName,workspaceId:$workspaceId,status:"ABSENT",verifiedAt:$verifiedAt}' \
          >"$WORK_DIR/cleanup.json"
        log "Workspace $INSTANCE_NAME is absent"
        return 0
      fi
    else
      absent=0
    fi
    timeout 30s brev refresh >/dev/null 2>&1 || true
    sleep "${POLL_SECONDS:-15}"
  done
  log "FAILED: workspace $INSTANCE_NAME still exists after deletion" >&2
  return 1
}

finish() {
  local status=$?
  trap - EXIT INT TERM
  if [ "$cleanup_required" -eq 1 ] && ! cleanup; then status=1; fi
  rm -f "${diagnostic_capture:-}"
  exit "$status"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

CORRELATION_ID="${CORRELATION_ID:-$(tr '[:upper:]' '[:lower:]' </proc/sys/kernel/random/uuid)}"
for name in WORK_DIR CANDIDATE_SHA CORRELATION_ID GH_TOKEN GITHUB_RUN_ID \
  GITHUB_RUN_ATTEMPT BREV_LAUNCHABLE_ID INSTANCE_NAME NVIDIA_INFERENCE_API_KEY; do
  require "$name"
done
for tool in brev gh jq mktemp python3 sed ssh timeout; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
[[ "$CANDIDATE_SHA" =~ ^[0-9a-f]{40}$ ]] || die "candidate SHA is not canonical"
[[ "$CORRELATION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]] \
  || die "correlation ID is not a UUIDv4"
[[ "$INSTANCE_NAME" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || die "workspace name is unsafe"
[[ "$BREV_LAUNCHABLE_ID" =~ ^env-[A-Za-z0-9]+$ ]] || die "Launchable ID is unsafe"
if [ "${BREV_HOST_SSH_TIMEOUT_SECONDS+x}" = x ] \
  && ! [[ "$BREV_HOST_SSH_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  die "BREV_HOST_SSH_TIMEOUT_SECONDS must be a positive integer"
fi
if [ "${POLL_SECONDS+x}" = x ] && ! [[ "$POLL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  die "POLL_SECONDS must be a positive integer"
fi
: >"$WORK_DIR/lane.log"
log "Candidate $CANDIDATE_SHA"

# Dispatch #80 once, then bind the uniquely correlated producer run.
requested_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
title="Build Launchable E2E image for NemoClaw $CANDIDATE_SHA ($CORRELATION_ID)"
gh api --method POST "repos/$IMAGE_REPOSITORY/actions/workflows/$IMAGE_WORKFLOW/dispatches" \
  -f ref=main -f "inputs[nemoclaw_sha]=$CANDIDATE_SHA" \
  -f "inputs[correlation_id]=$CORRELATION_ID" \
  -f "inputs[requester_workflow_run_id]=$GITHUB_RUN_ID" \
  -f "inputs[requester_workflow_run_attempt]=$GITHUB_RUN_ATTEMPT"
deadline=$((SECONDS + 300))
producer_run=""
while [ "$SECONDS" -lt "$deadline" ]; do
  runs="$(gh api --method GET "repos/$IMAGE_REPOSITORY/actions/workflows/$IMAGE_WORKFLOW/runs" \
    -f branch=main -f event=workflow_dispatch -f per_page=50)"
  matches="$(jq -c --arg title "$title" --arg since "$requested_at" \
    '[.workflow_runs[] | select(.display_title == $title and .head_branch == "main" and .created_at >= $since)]' \
    <<<"$runs")" || die "producer run inventory is malformed"
  [ "$(jq 'length' <<<"$matches")" -le 1 ] || die "correlation matched multiple producer runs"
  producer_run="$(jq -r '.[0].id // empty | tostring' <<<"$matches")"
  [ -z "$producer_run" ] || break
  sleep "${POLL_SECONDS:-15}"
done
[ -n "$producer_run" ] || die "producer run was not found"
log "Producer run $producer_run"

deadline=$((SECONDS + ${IMAGE_BUILD_TIMEOUT_SECONDS:-3600}))
while [ "$SECONDS" -lt "$deadline" ]; do
  run="$(gh api "repos/$IMAGE_REPOSITORY/actions/runs/$producer_run")"
  status="$(jq -r '.status // ""' <<<"$run")"
  if [ "$status" = completed ]; then
    [ "$(jq -r '.conclusion // ""' <<<"$run")" = success ] \
      || die "producer run $producer_run failed"
    break
  fi
  sleep "${POLL_SECONDS:-15}"
done
[ "${status:-}" = completed ] || die "producer run $producer_run timed out"
artifact="nemoclaw-image-handoff-v1-${producer_run}-1"
mkdir -m 700 "$WORK_DIR/handoff"
gh run download "$producer_run" --repo "$IMAGE_REPOSITORY" --name "$artifact" \
  --dir "$WORK_DIR/handoff"
manifest="$WORK_DIR/handoff/nemoclaw-image-manifest.v1.json"
[ -f "$manifest" ] || die "producer receipt is missing"
jq -e --arg sha "$CANDIDATE_SHA" --arg correlation "$CORRELATION_ID" \
  --arg requester "$GITHUB_RUN_ID" --argjson attempt "$GITHUB_RUN_ATTEMPT" --arg run "$producer_run" '
  .kind == "nemoclaw-exact-image-manifest" and .nemoclawSha == $sha and
  .correlationId == $correlation and .requesterWorkflowRunId == $requester and
  .requesterWorkflowRunAttempt == $attempt and .imageRepository == "brevdev/nemoclaw-image" and
  .producerWorkflow == ".github/workflows/build-launchable-e2e-image.yml" and
  .workflowRunId == $run and .workflowRunAttempt == 1 and .status == "READY" and
  .channel == "staging" and .variant == "cpu" and
  .observedFamily == "nemoclaw-brev-staging-cpu" and
  (.project | type) == "string" and (.project | length) > 0 and
  (.imageName | type) == "string" and (.imageName | length) > 0 and
  (.imageRepositorySha | test("^[0-9a-f]{40}$"))' \
  "$manifest" >/dev/null || die "producer receipt does not match the candidate"
expected_boot_image="projects/$(jq -er .project "$manifest")/global/images/$(jq -er .imageName "$manifest")"
image_repository_sha="$(jq -er .imageRepositorySha "$manifest")"
rm -rf "$WORK_DIR/handoff"

# The standing Launchable resolves the staging family. Give that reference time to
# observe the family update before deploying it.
log "Waiting 300s for the Launchable image family to settle"
sleep 300

# The guest must boot the exact image and contain the exact clean candidate.
existing="$(workspace)" || die "Brev workspace inventory failed"
[ -z "$existing" ] || die "workspace name already exists"
cleanup_required=1
timeout 900s brev create "$INSTANCE_NAME" --launchable "$BREV_LAUNCHABLE_ID" --detached --timeout 900
deadline=$((SECONDS + ${BREV_READY_TIMEOUT_SECONDS:-1200}))
ready=""
while [ "$SECONDS" -lt "$deadline" ]; do
  ready="$(workspace || true)"
  if jq -e '.status == "RUNNING" and (.shell_status // .shellStatus) == "READY" and
    (.build_status // .buildStatus) == "COMPLETED"' <<<"${ready:-null}" >/dev/null; then break; fi
  state="$(jq -r '(.status // "") + ":" + (.build_status // .buildStatus // "")' <<<"${ready:-null}")"
  [[ "$state" =~ FAILURE|FAILED|ERROR|CREATE_FAILED ]] && die "workspace entered $state"
  sleep "${POLL_SECONDS:-15}"
done
jq -e '.status == "RUNNING" and (.shell_status // .shellStatus) == "READY" and
  (.build_status // .buildStatus) == "COMPLETED"' \
  <<<"${ready:-null}" >/dev/null || die "workspace readiness timed out"
workspace_id="$(jq -r '.id // ""' <<<"$ready")"
log "Workspace $INSTANCE_NAME ($workspace_id) is ready"
wait_for_host_ssh

# Record the booted image before reading the baked runtime receipt so a stale
# Launchable image remains visible when the receipt is absent.
# The remote shell expands the single-quoted command.
# shellcheck disable=SC2016
boot_image="$(timeout 300s brev exec "$INSTANCE_NAME" 'set -euo pipefail
  boot_image=$(curl -fsS --max-time 10 -H "Metadata-Flavor: Google" \
    http://metadata.google.internal/computeMetadata/v1/instance/image)
  printf "NEMOCLAW_BOOT_IMAGE=%s\n" "$boot_image"' --host \
  | sed -n 's/^NEMOCLAW_BOOT_IMAGE=//p' | tail -n 1)"
[ -n "$boot_image" ] || die "booted image identity is missing"

jq -n --arg candidateSha "$CANDIDATE_SHA" --arg producerRun "$producer_run" \
  --arg bootImage "$boot_image" --arg workspaceName "$INSTANCE_NAME" --arg workspaceId "$workspace_id" \
  '{candidateSha:$candidateSha,producer:{runId:$producerRun,status:"success"},boot:{bootImage:$bootImage},workspace:{name:$workspaceName,id:$workspaceId},fullE2e:"pending"}' \
  >"$WORK_DIR/launchable-e2e.json"

[ "$boot_image" = "$expected_boot_image" ] \
  || die "booted image does not match the producer handoff"

# Return the baked runtime receipt.
# shellcheck disable=SC2016
identity="$(timeout 300s brev exec "$INSTANCE_NAME" 'set -euo pipefail
  schema_version=$(sudo -n jq -er .schemaVersion /etc/nemoclaw/provision.json)
  source_repository=$(sudo -n jq -er .sourceRepository /etc/nemoclaw/provision.json)
  source_path=$(sudo -n jq -er .sourcePath /etc/nemoclaw/provision.json)
  provision_sha=$(sudo -n jq -er .gitSha /etc/nemoclaw/provision.json)
  image_repository_sha=$(sudo -n jq -er .imageRepositorySha /etc/nemoclaw/provision.json)
  repo_sha=$(git -C "$source_path" rev-parse HEAD)
  if [ -z "$(git -C "$source_path" status --porcelain --untracked-files=normal)" ]; then
    repo_clean=true
  else
    repo_clean=false
  fi
  if sudo -n test -e /etc/nemoclaw/runtime-overrides.json; then
    runtime_overrides=true
  else
    runtime_overrides=false
  fi
  printf "NEMOCLAW_IDENTITY="
  jq -cn --argjson schemaVersion "$schema_version" --arg sourceRepository "$source_repository" \
    --arg sourcePath "$source_path" \
    --arg repoSha "$repo_sha" --arg provisionSha "$provision_sha" \
    --arg imageRepositorySha "$image_repository_sha" --argjson repoClean "$repo_clean" \
    --argjson runtimeOverrides "$runtime_overrides" \
    "{schemaVersion:\$schemaVersion,sourceRepository:\$sourceRepository,sourcePath:\$sourcePath,repoSha:\$repoSha,provisionSha:\$provisionSha,imageRepositorySha:\$imageRepositorySha,repoClean:\$repoClean,runtimeOverrides:\$runtimeOverrides}"' --host \
  | sed -n 's/^NEMOCLAW_IDENTITY=//p' | tail -n 1)"
jq -e --arg sha "$CANDIDATE_SHA" --arg imageRepositorySha "$image_repository_sha" '
  .schemaVersion == 1 and .sourceRepository == "NVIDIA/NemoClaw" and
  .sourcePath == "/opt/nemoclaw-image/NemoClaw" and
  .repoSha == $sha and .provisionSha == $sha and
  .imageRepositorySha == $imageRepositorySha and
  .repoClean == true and .runtimeOverrides == false' \
  <<<"$identity" >/dev/null || die "booted image runtime does not match the producer handoff"
source_path="$(jq -er .sourcePath <<<"$identity")"

jq --argjson identity "$identity" '.boot += $identity' \
  "$WORK_DIR/launchable-e2e.json" >"$WORK_DIR/launchable-e2e.tmp"
mv "$WORK_DIR/launchable-e2e.tmp" "$WORK_DIR/launchable-e2e.json"

# Run the existing suite from the baked checkout; no source copy, install, or rebuild.
raw_log="${RUNNER_TEMP:-/tmp}/brev-launchable-e2e-${GITHUB_RUN_ID}.raw"
set +e
{
  printf 'export NVIDIA_INFERENCE_API_KEY=%q\n' "$NVIDIA_INFERENCE_API_KEY"
  printf 'export NEMOCLAW_SOURCE_PATH=%q\n' "$source_path"
  cat <<'REMOTE'
set -euo pipefail
sudo -n test ! -e /etc/nemoclaw/runtime-overrides.json
cd "$NEMOCLAW_SOURCE_PATH"
test -x ./node_modules/.bin/vitest
export CI=true GITHUB_ACTIONS=true E2E_TARGET_ID=staging-brev-launchable
export NEMOCLAW_E2E_SETUP_MODE=preinstalled-launchable NEMOCLAW_RUN_LIVE_E2E=1
export NEMOCLAW_MODEL="$(node /usr/local/lib/nemoclaw/launchable-config.mjs /usr/local/share/nemoclaw/launchable-agents.json openclaw cloudModel)"
export NEMOCLAW_SANDBOX_NAME=e2e-staging
./node_modules/.bin/vitest run --project e2e-live test/e2e/live/full-e2e.test.ts --silent=false --reporter=default
printf 'NEMOCLAW_FULL_E2E_PASSED\n'
REMOTE
} | timeout "${FULL_E2E_TIMEOUT_SECONDS:-3000}" ssh -T -o ConnectTimeout=10 -o LogLevel=ERROR \
  "${INSTANCE_NAME}-host" 'bash -s' >"$raw_log" 2>&1
e2e_status=$?
set -e
python3 - "$raw_log" "$WORK_DIR/full-e2e.log" "$NVIDIA_INFERENCE_API_KEY" <<'PY'
import sys
from pathlib import Path
source, target, secret = sys.argv[1:]
Path(target).write_bytes(Path(source).read_bytes().replace(secret.encode(), b"[REDACTED]"))
Path(source).unlink(missing_ok=True)
PY
if [ "$e2e_status" -ne 0 ] || ! grep -q '^NEMOCLAW_FULL_E2E_PASSED$' "$WORK_DIR/full-e2e.log"; then
  die "full E2E failed"
fi
jq '.fullE2e = "passed"' "$WORK_DIR/launchable-e2e.json" >"$WORK_DIR/launchable-e2e.tmp"
mv "$WORK_DIR/launchable-e2e.tmp" "$WORK_DIR/launchable-e2e.json"
log "Full E2E passed"
