// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "tools", "e2e", "brev-launchable-e2e.sh");
const REAL_CUT = spawnSync("which", ["cut"], { encoding: "utf8" }).stdout.trim();
const REAL_PYTHON3 = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
const REAL_STAT = spawnSync("which", ["stat"], { encoding: "utf8" }).stdout.trim();
export const candidateSha = "a".repeat(40);
const roots: string[] = [];

export function gatewayChildJournal(
  messages: string[],
  metadata: { executable?: string; unit?: string } = {},
): string {
  return messages
    .map((message) =>
      JSON.stringify({
        _PID: "77",
        _SYSTEMD_UNIT: metadata.unit ?? "openshell-gateway.service",
        _EXE: metadata.executable ?? "/usr/local/bin/openshell-gateway",
        MESSAGE: message,
      }),
    )
    .join("\n");
}

export function cleanupFixtures(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

function executable(file: string, source: string): void {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

export function fixture(
  options: {
    bootImage?: string;
    brevExecStatus?: number;
    createAppearsAfterRefresh?: number;
    createStatus?: number;
    deleteFails?: boolean;
    e2eDiagnosticTimesOut?: boolean;
    e2eFails?: boolean;
    gatewayChildJournal?: string;
    gatewayExecStart?: string;
    imageRepositorySha?: string;
    listenerOutput?: string;
    missingProvisionReceipt?: boolean;
    omitReceiptField?: "imageName" | "imageRepositorySha" | "project";
    platformDiagnosticFails?: boolean;
    provisionImageRepositorySha?: string;
    provisionSha?: string;
    ready?: boolean;
    receiptSha?: string;
    refreshError?: string;
    refreshStatus?: number;
    repoClean?: boolean;
    repoSha?: string;
    runtimeOverrides?: boolean;
    schemaVersion?: number;
    sshAliasConfigured?: boolean;
    sshError?: string;
    sshProbeStatus?: number;
    sshReadyAfter?: number;
    sshAliasQueryStatus?: number;
    sourceRepository?: string;
    sourcePath?: string;
    timeoutBlockCommand?: "brev refresh" | "ssh";
    timeoutBlockDiagnostics?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launchable-e2e-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  const workDir = path.join(root, "evidence");
  const state = path.join(root, "workspace.json");
  const calls = path.join(root, "calls.log");
  const diagnosticPhase = path.join(root, "diagnostic-phase");
  const gatewayLifecycleCommand = path.join(root, "gateway-lifecycle-command");
  const refreshAttempts = path.join(root, "refresh-attempts");
  const sshAttempts = path.join(root, "ssh-attempts");
  const timeoutBlock = path.join(root, "timeout-block");
  fs.mkdirSync(bin);
  fs.mkdirSync(workDir);
  fs.writeFileSync(timeoutBlock, "block\n");

  executable(
    path.join(bin, "timeout"),
    `#!/usr/bin/env bash
set -euo pipefail
duration="$1"
shift
printf 'timeout %s %s\n' "$duration" "$*" >> "$FAKE_CALLS"
should_block=0
if [ "$FAKE_TIMEOUT_BLOCK_COMMAND" = "brev refresh" ] && [ "\${1:-} \${2:-}" = "brev refresh" ]; then
  should_block=1
elif [ "$FAKE_TIMEOUT_BLOCK_COMMAND" = "ssh" ] && [ "\${1:-}" = ssh ] &&
  [[ " $* " == *" $INSTANCE_NAME true "* ]]; then
  should_block=1
fi
if [ "$FAKE_TIMEOUT_BLOCK_DIAGNOSTICS" = 1 ] && [[ "$duration" =~ ^[1-5]s$ ]]; then
  if [ "\${1:-} \${2:-}" = "ssh -G" ]; then
    touch "$FAKE_DIAGNOSTIC_PHASE"
    /bin/sleep "\${duration%s}"
    exit 124
  elif [ -f "$FAKE_DIAGNOSTIC_PHASE" ]; then
    /bin/sleep "\${duration%s}"
    exit 124
  fi
fi
if [ "$FAKE_E2E_DIAGNOSTIC_TIMES_OUT" = 1 ] &&
  [[ "$*" == *"openshell-gateway.service"* ]] && [[ "$*" == *"ExecMainCode"* ]]; then
  /bin/sleep "\${duration%s}"
  exit 124
fi
if [ -f "$FAKE_TIMEOUT_BLOCK" ] && [ "$should_block" -eq 1 ]; then
  rm -f "$FAKE_TIMEOUT_BLOCK"
  /bin/sleep "\${duration%s}"
  exit 124
fi
exec "$@"
`,
  );
  executable(
    path.join(bin, "sleep"),
    '#!/usr/bin/env bash\nprintf "sleep %s\\n" "$*" >> "$FAKE_CALLS"\n',
  );
  executable(
    path.join(bin, "sudo"),
    `#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" != -n ] || shift
exec "$@"
`,
  );
  executable(
    path.join(bin, "cut"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$*" = "-d. -f1 /proc/uptime" ]; then
  printf '180\n'
  exit 0
fi
exec ${JSON.stringify(REAL_CUT)} "$@"
`,
  );
  executable(
    path.join(bin, "stat"),
    `#!/usr/bin/env bash
set -euo pipefail
expected='--printf=gateway-state-dir type=%F uid=%u gid=%g mode=%a\\n'
if [ "\${*: -1}" = /var/lib/brev/openshell-gateway ]; then
  [ "$#" -eq 2 ]
  [ "$1" = "$expected" ]
  printf 'gateway-state-dir type=directory uid=1000 gid=1000 mode=750\n'
  exit 0
fi
exec ${JSON.stringify(REAL_STAT)} "$@"
`,
  );
  executable(
    path.join(bin, "ss"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$FAKE_LISTENER_OUTPUT"
`,
  );
  executable(
    path.join(bin, "systemctl"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "show --no-pager --property=Id --property=ActiveState --property=SubState --property=Result --property=NRestarts --property=ActiveEnterTimestampMonotonic docker.service docker.socket")
    if [ "$FAKE_PLATFORM_DIAGNOSTIC_FAILS" = 1 ]; then
      printf 'platform api_key=brev-test-secret Authorization: Bearer github-test-token\n' >&2
      printf '%s%s\n' '-----BEGIN PRIVATE ' 'KEY-----' >&2
      printf '%s\n' 'private-key-material' >&2
      printf '%s%s\n' '-----END PRIVATE ' 'KEY-----' >&2
      printf '%05000d\n' 0 >&2
      printf '\\033[31mplatform diagnostic safe detail\\033[0m password=journal-test-secret nvapi-test-value 203.0.113.20 workspace.hidden.internal\n' >&2
      exit 42
    fi
    printf 'Id=docker.service\nActiveState=active\nSubState=running\nResult=success\n'
    printf 'NRestarts=0\nActiveEnterTimestampMonotonic=1000\n\n'
    printf 'Id=docker.socket\nActiveState=active\nSubState=running\nResult=success\n'
    printf 'NRestarts=0\nActiveEnterTimestampMonotonic=1000\n' ;;
  "show --no-pager --property=Requires --value openshell-gateway.service") printf 'docker.service\n' ;;
  "show --no-pager --property=After --value openshell-gateway.service")
    printf 'docker.service network.target\n' ;;
  "show --no-pager --property=Wants --value docker.service") printf 'openshell-gateway.service\n' ;;
  *"--property=Restart --value openshell-gateway.service"*) printf 'always\n' ;;
  *"--property=ExecStart --value openshell-gateway.service"*) printf '%s\n' "$FAKE_GATEWAY_EXEC_START" ;;
  *"--property=FragmentPath --value openshell-gateway.service"*)
    printf '/etc/systemd/system/openshell-gateway.service\n' ;;
  *"--property=DropInPaths --value openshell-gateway.service"*) printf '\n' ;;
  *"--property=ControlGroup --value openshell-gateway.service"*)
    printf '/system.slice/openshell-gateway.service\n' ;;
  "show --no-pager --property=Id --property=LoadState --property=ActiveState --property=SubState --property=Result --property=ExecMainCode --property=ExecMainStatus --property=ActiveEnterTimestampMonotonic --property=InactiveEnterTimestampMonotonic cloud-final.service")
    printf 'Id=cloud-final.service\nLoadState=loaded\nActiveState=active\nSubState=exited\n'
    printf 'Result=success\nExecMainCode=1\nExecMainStatus=0\n'
    printf 'ActiveEnterTimestampMonotonic=1200\nInactiveEnterTimestampMonotonic=0\n' ;;
  *ExecMainCode*openshell-gateway.service*)
    printf 'Id=openshell-gateway.service\nLoadState=loaded\nUnitFileState=enabled\n'
    printf 'ActiveState=inactive\nSubState=dead\nResult=success\n'
    printf 'ExecMainCode=1\nExecMainStatus=0\nNRestarts=0\n'
    printf 'ActiveEnterTimestampMonotonic=1234\nActiveExitTimestampMonotonic=0\n'
    printf 'InactiveEnterTimestampMonotonic=5678\nInactiveExitTimestampMonotonic=0\n' ;;
  *) exit 2 ;;
esac
`,
  );
  executable(
    path.join(bin, "journalctl"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "--boot --unit=openshell-gateway.service --no-pager --lines=120 --output=json")
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1000","_PID":"1","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Starting OpenShell gateway"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1100","_PID":"1","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Started OpenShell gateway"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1200","_PID":"1","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"guest s3cr3t password=journal-test-secret 203.0.113.20"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1300","_PID":"1","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Start request repeated too quickly"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1400","_PID":"1","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Scheduled restart job, restart counter is at 1"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1500","_PID":"1","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Main process exited, code=exited, status=1/FAILURE"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1600","_PID":"1","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Failed with result exit-code"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1700","_PID":"1","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Dependency failed for OpenShell gateway"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"2200","_PID":"1","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Stopping OpenShell gateway"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"2300","_PID":"1","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Deactivated successfully"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"2400","_PID":"1","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Stopped OpenShell gateway"}'
    printf '%s\n' "$FAKE_GATEWAY_CHILD_JOURNAL" ;;
  "--boot _PID=1 --unit=docker.service --unit=docker.socket --no-pager --lines=80 --output=json")
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"900","_SYSTEMD_UNIT":"docker.service","MESSAGE":"Starting Docker Application Container Engine"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"950","_SYSTEMD_UNIT":"docker.service","MESSAGE":"Started Docker Application Container Engine"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"960","UNIT":"docker.socket","_SYSTEMD_UNIT":"systemd.service","MESSAGE":"Started Docker Socket"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"970","_SYSTEMD_UNIT":"containerd.service","MESSAGE":"Container runtime event"}' ;;
  *) exit 2 ;;
esac
`,
  );
  executable(
    path.join(bin, "cat"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == /proc/*/cgroup ]]; then
  pid="\${1#/proc/}"
  pid="\${pid%/cgroup}"
  case "$pid" in
    98) printf '0::/system.slice/openshell-gateway.service\n' ;;
    97) printf '0::/system.slice/openshell-gateway.service/delegated\n' ;;
    96) printf '2:cpu,cpuacct:/system.slice/openshell-gateway.service\n' ;;
    95) printf '2:cpu,cpuacct:/system.slice/openshell-gateway.service/delegated\n' ;;
    94) printf '0::/system.slice/openshell-gateway.service-other\n' ;;
    *) printf '0::/system.slice/unrelated.service\n' ;;
  esac
  exit 0
fi
exec /bin/cat "$@"
`,
  );
  executable(
    path.join(bin, "python3"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-" ] && [[ "\${2:-}" == */brev-launchable-e2e.*/full-e2e.raw ]]; then
  [ "$#" -eq 3 ]
  [ -n "\${NEMOCLAW_REDACTION_SECRET:-}" ]
  raw_mode="$(stat -c '%a' "$2" 2>/dev/null || stat -f '%Lp' "$2")"
  directory_mode="$(stat -c '%a' "$(dirname "$2")" 2>/dev/null || stat -f '%Lp' "$(dirname "$2")")"
  [ "$raw_mode" = "600" ]
  [ "$directory_mode" = "700" ]
  printf 'python redactor arg-count %s with environment secret and modes %s/%s\n' \
    "$#" "$raw_mode" "$directory_mode" >> "$FAKE_CALLS"
fi
exec ${JSON.stringify(REAL_PYTHON3)} "$@"
`,
  );
  executable(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'gh %s\\n' "$*" >> "$FAKE_CALLS"
if [ "$1" = api ]; then
  case "$*" in
    *'/dispatches'*) exit 0 ;;
    *'/workflows/build-launchable-e2e-image.yml/runs'*)
      jq -cn --arg title "Build Launchable E2E image for NemoClaw $CANDIDATE_SHA ($CORRELATION_ID)" \
        '{workflow_runs:[{id:123,display_title:$title,head_branch:"main",created_at:"2099-01-01T00:00:00Z"}]}' ;;
    *'/actions/runs/123'*) jq -cn '{status:"completed",conclusion:"success"}' ;;
    *) exit 2 ;;
  esac
elif [ "$1 $2" = 'run download' ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --dir ]; then directory="$2"; break; fi
    shift
  done
  mkdir -p "$directory"
  jq -n --arg sha "$FAKE_RECEIPT_SHA" --arg correlation "$CORRELATION_ID" \
    --arg imageRepositorySha "$FAKE_IMAGE_REPOSITORY_SHA" \
    --arg omit "$FAKE_OMIT_RECEIPT_FIELD" '{
    kind:"nemoclaw-exact-image-manifest",nemoclawSha:$sha,correlationId:$correlation,
    requesterWorkflowRunId:"789",requesterWorkflowRunAttempt:1,
    imageRepository:"brevdev/nemoclaw-image",producerWorkflow:".github/workflows/build-launchable-e2e-image.yml",
    workflowRunId:"123",workflowRunAttempt:1,
    status:"READY",channel:"staging",variant:"cpu",observedFamily:"nemoclaw-brev-staging-cpu",
    project:"brevdevprod",imageName:"nemoclaw-test-image",imageRepositorySha:$imageRepositorySha
  } | if $omit == "" then . else del(.[$omit]) end' > "$directory/nemoclaw-image-manifest.v1.json"
else
  exit 2
fi
`,
  );
  executable(
    path.join(bin, "brev"),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'brev %s\\n' "$*" >> "$FAKE_CALLS"
case "$1" in
  ls)
    if [ -f "$FAKE_STATE" ]; then cat "$FAKE_STATE"; else printf '{"workspaces":[]}\\n'; fi ;;
  create)
    if [ "$FAKE_READY" = 1 ]; then shell=READY; build=COMPLETED; else shell=STARTING; build=BUILDING; fi
    if [ "$FAKE_CREATE_APPEARS_AFTER_REFRESH" -eq 0 ]; then
      jq -cn --arg name "$INSTANCE_NAME" --arg shell "$shell" --arg build "$build" \
        '{workspaces:[{id:"ws-1",name:$name,status:"RUNNING",shell_status:$shell,build_status:$build}]}' > "$FAKE_STATE"
    fi
    exit "$FAKE_CREATE_STATUS" ;;
  exec)
    if [ "\${3:-}" = true ]; then
      [ "$FAKE_BREV_EXEC_STATUS" -eq 0 ] || printf '%s\n' "$FAKE_BREV_EXEC_ERROR" >&2
      exit "$FAKE_BREV_EXEC_STATUS"
    fi
    case "$3" in
      *NEMOCLAW_BOOT_IMAGE*)
        printf 'NEMOCLAW_BOOT_IMAGE=%s\\n' "$FAKE_BOOT_IMAGE"
        printf '%s\\n' "$INSTANCE_NAME" ;;
      *repo_clean*)
        [ "$FAKE_MISSING_PROVISION_RECEIPT" != 1 ] || exit 2
        printf 'NEMOCLAW_IDENTITY='
        jq -cn --arg sourcePath "$FAKE_SOURCE_PATH" --arg repo "$FAKE_REPO_SHA" \
          --arg provision "$FAKE_PROVISION_SHA" \
          --arg sourceRepository "$FAKE_SOURCE_REPOSITORY" \
          --arg imageRepositorySha "$FAKE_PROVISION_IMAGE_REPOSITORY_SHA" \
          --argjson schemaVersion "$FAKE_SCHEMA_VERSION" --argjson clean "$FAKE_REPO_CLEAN" \
          --argjson overrides "$FAKE_RUNTIME_OVERRIDES" \
          '{schemaVersion:$schemaVersion,sourceRepository:$sourceRepository,sourcePath:$sourcePath,
            repoSha:$repo,provisionSha:$provision,
            imageRepositorySha:$imageRepositorySha,repoClean:$clean,runtimeOverrides:$overrides}'
        printf '%s\\n' "$INSTANCE_NAME" ;;
      *) exit 2 ;;
    esac ;;
  delete) [ "$FAKE_DELETE_FAILS" = 1 ] || rm -f "$FAKE_STATE" ;;
  refresh)
    attempts=0
    [ ! -f "$FAKE_REFRESH_ATTEMPTS" ] || attempts="$(cat "$FAKE_REFRESH_ATTEMPTS")"
    attempts=$((attempts + 1))
    printf '%s\n' "$attempts" > "$FAKE_REFRESH_ATTEMPTS"
    if [ "$FAKE_CREATE_APPEARS_AFTER_REFRESH" -gt 0 ] && \
      [ "$attempts" -eq "$FAKE_CREATE_APPEARS_AFTER_REFRESH" ] && [ ! -f "$FAKE_STATE" ]; then
      jq -cn --arg name "$INSTANCE_NAME" \
        '{workspaces:[{id:"ws-1",name:$name,status:"RUNNING",shell_status:"READY",build_status:"COMPLETED"}]}' > "$FAKE_STATE"
    fi
    if [ "$FAKE_REFRESH_STATUS" -ne 0 ]; then
      if [ "$attempts" -eq 1 ]; then
        printf 'stale refresh detail\n' >&2
      else
        printf '%s\n' "$FAKE_REFRESH_ERROR" >&2
      fi
      exit "$FAKE_REFRESH_STATUS"
    fi ;;
  *) exit 2 ;;
esac
`,
  );
  executable(
    path.join(bin, "ssh"),
    `#!/usr/bin/env bash
set -euo pipefail
probe_options_present() {
  required=(-T "-o BatchMode=yes" "-o ConnectTimeout=10" "-o ConnectionAttempts=1" "-o NumberOfPasswordPrompts=0" "-o RequestTTY=no" "-o LogLevel=ERROR")
  for argument in "\${required[@]}"; do
    [[ " $* " == *" $argument "* ]]
  done
  target="\${*: -2:1}"
  [ "$target" = "$INSTANCE_NAME" ]
  bash -n -c "\${*: -1}"
}
if [ "\${1:-}" = -G ]; then
  touch "$FAKE_DIAGNOSTIC_PHASE"
  [ "$FAKE_SSH_ALIAS_QUERY_STATUS" -eq 0 ] || exit "$FAKE_SSH_ALIAS_QUERY_STATUS"
  alias="\${2:-}"
  [ "$alias" = "$INSTANCE_NAME" ]
  configured="$FAKE_SSH_ALIAS_CONFIGURED"
  if [ "$configured" = 1 ]; then hostname=203.0.113.20; else hostname="$alias"; fi
  printf 'hostname %s\n' "$hostname"
  printf 'user hidden-user\nidentityfile /hidden/private-key\nproxycommand none\n'
  exit 0
fi
if [ "\${*: -1}" = true ]; then
  probe_options_present "$@"
  if [ -f "$FAKE_DIAGNOSTIC_PHASE" ]; then
    if [ "$FAKE_SSH_PROBE_STATUS" -ne 0 ]; then
      printf '%s\n' "$FAKE_SSH_ERROR" >&2
      exit "$FAKE_SSH_PROBE_STATUS"
    fi
    exit 0
  fi
  attempts=0
  [ ! -f "$FAKE_SSH_ATTEMPTS" ] || attempts="$(cat "$FAKE_SSH_ATTEMPTS")"
  attempts=$((attempts + 1))
  printf '%s\n' "$attempts" > "$FAKE_SSH_ATTEMPTS"
  printf 'ssh readiness attempt %s: %s\n' "$attempts" "$*" >> "$FAKE_CALLS"
  if [ "$attempts" -lt "$FAKE_SSH_READY_AFTER" ]; then
    if [ "$attempts" -eq 1 ]; then
      printf 'stale SSH detail\n' >&2
    else
      printf '%s\n' "$FAKE_SSH_ERROR" >&2
    fi
    exit 34
  fi
  exit 0
fi
remote="\${*: -1}"
case "$remote" in
  *ExecMainCode*openshell-gateway.service*)
    probe_options_present "$@"
    printf 'ssh full-e2e diagnostic gateway state\n' >> "$FAKE_CALLS"
    bash -c "$remote"
    exit $? ;;
  *"gateway service requires Docker service"*)
    probe_options_present "$@"
    printf 'ssh full-e2e diagnostic platform state\n' >> "$FAKE_CALLS"
    bash -c "$remote"
    exit $? ;;
  *journalctl*openshell-gateway.service*)
    probe_options_present "$@"
    printf 'ssh full-e2e diagnostic gateway lifecycle\n' >> "$FAKE_CALLS"
    printf '%s' "$remote" > "$FAKE_GATEWAY_LIFECYCLE_COMMAND"
    bash -c "$remote"
    exit $? ;;
  *journalctl*docker.service*)
    probe_options_present "$@"
    printf 'ssh full-e2e diagnostic Docker lifecycle\n' >> "$FAKE_CALLS"
    bash -c "$remote"
    exit $? ;;
  *ActiveEnterTimestampMonotonic*cloud-final.service*)
    probe_options_present "$@"
    printf 'ssh full-e2e diagnostic cloud-final state\n' >> "$FAKE_CALLS"
    bash -c "$remote"
    exit $? ;;
  *"ss -H -ltnp"*)
    probe_options_present "$@"
    printf 'ssh full-e2e diagnostic port 8080 listener\n' >> "$FAKE_CALLS"
    bash -c "$remote"
    exit $? ;;
  "bash -s") ;;
  *)
    printf 'unexpected SSH remote command\n' >&2
    exit 97 ;;
esac
script="$(cat)"
[ "\${*: -2:1}" = "$INSTANCE_NAME" ]
grep -q 'NEMOCLAW_E2E_SETUP_MODE=preinstalled-launchable' <<<"$script"
grep -q 'NEMOCLAW_SOURCE_PATH=/opt/nemoclaw-image/NemoClaw' <<<"$script"
grep -q 'runtime-overrides.json' <<<"$script"
printf 'ssh preinstalled full-e2e.test.ts\\n' >> "$FAKE_CALLS"
printf 'remote output contains %s\\n' "$NVIDIA_INFERENCE_API_KEY"
[ "$FAKE_E2E_FAILS" != 1 ] || exit 7
printf 'NEMOCLAW_FULL_E2E_PASSED\\n'
`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    BREV_DELETE_TIMEOUT_SECONDS: "5",
    BREV_READY_TIMEOUT_SECONDS: "5",
    BREV_LAUNCHABLE_ID: "env-staging123",
    BREV_API_KEY: "brev-test-secret",
    CANDIDATE_SHA: candidateSha,
    CORRELATION_ID: "11111111-1111-4111-8111-111111111111",
    FAKE_BOOT_IMAGE: options.bootImage ?? "projects/brevdevprod/global/images/nemoclaw-test-image",
    FAKE_BREV_EXEC_ERROR:
      "Brev execution safe detail; credential=exec-secret; endpoint=exec.hidden.internal",
    FAKE_BREV_EXEC_STATUS: String(options.brevExecStatus ?? 31),
    FAKE_CALLS: calls,
    FAKE_CREATE_APPEARS_AFTER_REFRESH: String(options.createAppearsAfterRefresh ?? 0),
    FAKE_CREATE_STATUS: String(options.createStatus ?? 0),
    FAKE_DELETE_FAILS: options.deleteFails ? "1" : "0",
    FAKE_DIAGNOSTIC_PHASE: diagnosticPhase,
    FAKE_E2E_DIAGNOSTIC_TIMES_OUT: options.e2eDiagnosticTimesOut ? "1" : "0",
    FAKE_E2E_FAILS: options.e2eFails ? "1" : "0",
    FAKE_GATEWAY_CHILD_JOURNAL:
      options.gatewayChildJournal ??
      gatewayChildJournal([
        "Starting OpenShell server bind=127.0.0.1:8080",
        'Gateway listener bound address=127.0.0.1:8080 listener_purpose="primary"',
        "Error: transport error: failed to bind to 172.18.0.1:8080: Cannot assign requested",
        "address (os error 99)",
        "api_key=gateway-child-test-secret child.hidden.internal",
        "Starting OpenShell server bind=127.0.0.1:8080",
      ]),
    FAKE_GATEWAY_LIFECYCLE_COMMAND: gatewayLifecycleCommand,
    FAKE_GATEWAY_EXEC_START:
      options.gatewayExecStart ??
      "{ path=/usr/local/bin/nemoclaw-openshell-gateway-service ; argv[]=/usr/local/bin/nemoclaw-openshell-gateway-service ; ignore_errors=no ; }",
    FAKE_IMAGE_REPOSITORY_SHA: options.imageRepositorySha ?? "b".repeat(40),
    FAKE_LISTENER_OUTPUT:
      options.listenerOutput ??
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("s3cr3t",pid=99,fd=3))',
    FAKE_MISSING_PROVISION_RECEIPT: options.missingProvisionReceipt ? "1" : "0",
    FAKE_OMIT_RECEIPT_FIELD: options.omitReceiptField ?? "",
    FAKE_PLATFORM_DIAGNOSTIC_FAILS: options.platformDiagnosticFails ? "1" : "0",
    FAKE_PROVISION_IMAGE_REPOSITORY_SHA:
      options.provisionImageRepositorySha ?? options.imageRepositorySha ?? "b".repeat(40),
    FAKE_PROVISION_SHA: options.provisionSha ?? candidateSha,
    FAKE_SSH_ALIAS_CONFIGURED: options.sshAliasConfigured === false ? "0" : "1",
    FAKE_READY: options.ready === false ? "0" : "1",
    FAKE_RECEIPT_SHA: options.receiptSha ?? candidateSha,
    FAKE_REPO_CLEAN: options.repoClean === false ? "false" : "true",
    FAKE_REPO_SHA: options.repoSha ?? candidateSha,
    FAKE_REFRESH_ERROR:
      options.refreshError ??
      "refresh safe detail; api_key=brev-test-secret; endpoint=https://refresh.hidden.internal/path",
    FAKE_REFRESH_ATTEMPTS: refreshAttempts,
    FAKE_REFRESH_STATUS: String(options.refreshStatus ?? 0),
    FAKE_RUNTIME_OVERRIDES: options.runtimeOverrides ? "true" : "false",
    FAKE_SCHEMA_VERSION: String(options.schemaVersion ?? 1),
    FAKE_SSH_ATTEMPTS: sshAttempts,
    FAKE_SSH_ALIAS_QUERY_STATUS: String(options.sshAliasQueryStatus ?? 0),
    FAKE_SSH_ERROR:
      options.sshError ??
      "ssh: Could not resolve hostname workspace.hidden.internal: SSH safe detail; password=ssh-secret; identityfile=/hidden/private-key",
    FAKE_SSH_PROBE_STATUS: String(options.sshProbeStatus ?? 34),
    FAKE_SSH_READY_AFTER: String(options.sshReadyAfter ?? 1),
    FAKE_SOURCE_REPOSITORY: options.sourceRepository ?? "NVIDIA/NemoClaw",
    FAKE_SOURCE_PATH: options.sourcePath ?? "/opt/nemoclaw-image/NemoClaw",
    FAKE_STATE: state,
    FAKE_TIMEOUT_BLOCK: options.timeoutBlockCommand
      ? timeoutBlock
      : path.join(root, "timeout-disabled"),
    FAKE_TIMEOUT_BLOCK_COMMAND: options.timeoutBlockCommand ?? "",
    FAKE_TIMEOUT_BLOCK_DIAGNOSTICS: options.timeoutBlockDiagnostics ? "1" : "0",
    GH_TOKEN: "github-test-token",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "789",
    INSTANCE_NAME: "nclaw-e2e-test-1",
    NVIDIA_INFERENCE_API_KEY: "nvapi-test-value",
    RUNNER_TEMP: root,
    WORK_DIR: workDir,
  };
  for (const key of [
    "BREV_CREATE_RECONCILE_SECONDS",
    "NEMOCLAW_BREV_DEFER_CLEANUP",
    "NEMOCLAW_BREV_LAUNCHABLE_IDENTITY_ONLY",
    "NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY",
  ]) {
    delete env[key];
  }
  return { calls, env, gatewayLifecycleCommand, refreshAttempts, sshAttempts, state, workDir };
}

export function run(env: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync("bash", [SCRIPT, ...args], { cwd: REPO_ROOT, encoding: "utf8", env });
}

export function emittedOutput(result: ReturnType<typeof run>, workDir: string): string {
  return `${result.stdout}\n${result.stderr}\n${fs.readFileSync(path.join(workDir, "lane.log"), "utf8")}`;
}
