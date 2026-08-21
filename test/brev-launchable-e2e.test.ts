// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "tools", "e2e", "brev-launchable-e2e.sh");
const REAL_CUT = spawnSync("which", ["cut"], { encoding: "utf8" }).stdout.trim();
const REAL_PYTHON3 = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
const REAL_STAT = spawnSync("which", ["stat"], { encoding: "utf8" }).stdout.trim();
const candidateSha = "a".repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function executable(file: string, source: string): void {
  fs.writeFileSync(file, source, { mode: 0o755 });
}

function fixture(
  options: {
    bootImage?: string;
    brevExecStatus?: number;
    deleteFails?: boolean;
    e2eDiagnosticTimesOut?: boolean;
    e2eFails?: boolean;
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
  "--boot _PID=1 --unit=openshell-gateway.service --no-pager --lines=80 --output=json")
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1000","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Starting OpenShell gateway"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1100","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Started OpenShell gateway"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1200","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"guest s3cr3t password=journal-test-secret 203.0.113.20"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1300","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Start request repeated too quickly"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1400","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Scheduled restart job, restart counter is at 1"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1500","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Main process exited, code=exited, status=1/FAILURE"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1600","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Failed with result exit-code"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"1700","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Dependency failed for OpenShell gateway"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"2200","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Stopping OpenShell gateway"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"2300","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Deactivated successfully"}'
    printf '%s\n' '{"__MONOTONIC_TIMESTAMP":"2400","_SYSTEMD_UNIT":"openshell-gateway.service","MESSAGE":"Stopped OpenShell gateway"}' ;;
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
    jq -cn --arg name "$INSTANCE_NAME" --arg shell "$shell" --arg build "$build" \
      '{workspaces:[{id:"ws-1",name:$name,status:"RUNNING",shell_status:$shell,build_status:$build}]}' > "$FAKE_STATE" ;;
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

  const env = {
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
    FAKE_DELETE_FAILS: options.deleteFails ? "1" : "0",
    FAKE_DIAGNOSTIC_PHASE: diagnosticPhase,
    FAKE_E2E_DIAGNOSTIC_TIMES_OUT: options.e2eDiagnosticTimesOut ? "1" : "0",
    FAKE_E2E_FAILS: options.e2eFails ? "1" : "0",
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
  return { calls, env, refreshAttempts, sshAttempts, state, workDir };
}

function run(env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8", env });
}

function emittedOutput(result: ReturnType<typeof run>, workDir: string): string {
  return `${result.stdout}\n${result.stderr}\n${fs.readFileSync(path.join(workDir, "lane.log"), "utf8")}`;
}

describe("focused staging Brev Launchable lane", () => {
  it("publishes exact image evidence without Brev or inference access (#8924)", () => {
    const { calls, env, state, workDir } = fixture();
    const imageOnlyEnv: NodeJS.ProcessEnv = {
      ...env,
      NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY: "1",
    };
    delete imageOnlyEnv.BREV_API_KEY;
    delete imageOnlyEnv.BREV_LAUNCHABLE_ID;
    delete imageOnlyEnv.INSTANCE_NAME;
    delete imageOnlyEnv.NVIDIA_INFERENCE_API_KEY;
    const result = run(imageOnlyEnv);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.match(/\/dispatches/gu)).toHaveLength(1);
    expect(commands).not.toMatch(/\bbrev\b|\bssh\b|sleep 300|full-e2e\.test\.ts/u);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readdirSync(workDir).sort()).toEqual(["lane.log", "launchable-image.json"]);
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "launchable-image.json"), "utf8")),
    ).toEqual({
      schemaVersion: 1,
      kind: "nemoclaw-staging-launchable-image-v1",
      candidateSha,
      producer: {
        repository: "brevdev/nemoclaw-image",
        workflow: ".github/workflows/build-launchable-e2e-image.yml",
        runId: "123",
        status: "success",
      },
      image: {
        uri: "projects/brevdevprod/global/images/nemoclaw-test-image",
        family: "nemoclaw-brev-staging-cpu",
        imageRepositorySha: "b".repeat(40),
      },
      validation: {
        launchable: "not-run",
        runtime: "not-run",
        inference: "not-run",
      },
    });
    expect(fs.readFileSync(path.join(workDir, "lane.log"), "utf8")).toContain(
      "Launchable deployment, runtime, and inference validation did not run",
    );

    const wrongReceipt = fixture({ receiptSha: "b".repeat(40) });
    const wrongResult = run({
      ...wrongReceipt.env,
      NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY: "1",
    });
    expect(wrongResult.status).not.toBe(0);
    expect(wrongResult.stderr).toContain("producer receipt does not match the candidate");
    expect(fs.readFileSync(wrongReceipt.calls, "utf8")).not.toMatch(/\bbrev\b|\bssh\b/u);
    expect(fs.existsSync(path.join(wrongReceipt.workDir, "launchable-image.json"))).toBe(false);
  });

  it("rejects an invalid image-publication mode before dispatch (#8924)", () => {
    const { calls, env, workDir } = fixture();
    const result = run({ ...env, NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY: "yes" });
    expect(result.status).not.toBe(0);
    expect(emittedOutput(result, workDir)).toContain(
      "NEMOCLAW_BREV_LAUNCHABLE_IMAGE_ONLY must be 0 or 1",
    );
    expect(fs.existsSync(calls)).toBe(false);
  });

  it("binds the producer run, verifies the clean booted SHA, runs E2E, and deletes (#6943)", () => {
    const { calls, env, sshAttempts, state, workDir } = fixture({
      sshReadyAfter: 6,
    });
    const result = run(env);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.match(/\/dispatches/gu)).toHaveLength(1);
    expect(commands).toContain("sleep 300");
    expect(commands.indexOf("sleep 300")).toBeLessThan(
      commands.indexOf("create nclaw-e2e-test-1 --launchable env-staging123"),
    );
    expect(commands).toContain("create nclaw-e2e-test-1 --launchable env-staging123");
    expect(commands.match(/ssh readiness attempt/gu)).toHaveLength(6);
    const readinessCommands = commands.slice(
      commands.indexOf("create nclaw-e2e-test-1 --launchable env-staging123"),
      commands.indexOf("NEMOCLAW_BOOT_IMAGE"),
    );
    expect(readinessCommands.split("\n").filter((line) => line === "brev refresh")).toHaveLength(2);
    expect(readinessCommands.indexOf("brev refresh")).toBeLessThan(
      readinessCommands.indexOf("ssh readiness attempt 1"),
    );
    expect(readinessCommands.lastIndexOf("brev refresh")).toBeGreaterThan(
      readinessCommands.indexOf("ssh readiness attempt 5"),
    );
    expect(readinessCommands.lastIndexOf("brev refresh")).toBeLessThan(
      readinessCommands.indexOf("ssh readiness attempt 6"),
    );
    expect(readinessCommands).toContain("sleep 5");
    const readinessCall = commands
      .split("\n")
      .find((line) => line.startsWith("ssh readiness attempt 1: "));
    expect(readinessCall).toBeDefined();
    const readinessArgs = readinessCall?.split(": ").at(1)?.split(" ") ?? [];
    expect(readinessArgs).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "NumberOfPasswordPrompts=0",
      "-o",
      "RequestTTY=no",
      "-o",
      "LogLevel=ERROR",
      "nclaw-e2e-test-1",
      "true",
    ]);
    expect(fs.readFileSync(sshAttempts, "utf8").trim()).toBe("6");
    expect(commands).toContain("ssh preinstalled full-e2e.test.ts");
    expect(commands).not.toContain("ssh full-e2e diagnostic");
    expect(commands).not.toContain("nvapi-test-value");
    expect(commands).not.toMatch(/rsync|install\.sh|npm (?:ci|install)|git clone/u);
    expect(fs.readFileSync(path.join(workDir, "lane.log"), "utf8")).not.toMatch(
      /last failure|Readiness diagnostics budget|Readiness probe|Readiness SSH alias|Readiness classification/u,
    );
    expect(fs.readFileSync(path.join(workDir, "lane.log"), "utf8")).toContain(
      "Waiting up to 900 seconds for workspace SSH access",
    );
    expect(fs.readFileSync(path.join(workDir, "lane.log"), "utf8")).not.toContain(
      "Full E2E failure diagnostic",
    );
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readdirSync(workDir).sort()).toEqual([
      "cleanup.json",
      "full-e2e.log",
      "lane.log",
      "launchable-e2e.json",
    ]);
    expect(fs.readFileSync(path.join(workDir, "full-e2e.log"), "utf8")).not.toContain(
      "nvapi-test-value",
    );
    const evidence = JSON.parse(fs.readFileSync(path.join(workDir, "launchable-e2e.json"), "utf8"));
    expect(evidence).toMatchObject({
      candidateSha,
      fullE2e: "passed",
      producer: { runId: "123", status: "success" },
      validation: {
        imageSelection: { status: "passed" },
        runtimeProvenance: { status: "passed" },
        fullE2E: "passed",
      },
      boot: {
        bootImage: "projects/brevdevprod/global/images/nemoclaw-test-image",
        sourcePath: "/opt/nemoclaw-image/NemoClaw",
        repoSha: candidateSha,
        provisionSha: candidateSha,
        repoClean: true,
        runtimeOverrides: false,
      },
      workspace: { id: "ws-1" },
    });
    expect(evidence.validation.runtimeProvenance.checks).toEqual([
      { field: "schemaVersion", expected: 1, observed: 1, status: "passed" },
      {
        field: "sourceRepository",
        expected: "NVIDIA/NemoClaw",
        observed: "NVIDIA/NemoClaw",
        status: "passed",
      },
      {
        field: "sourcePath",
        expected: "/opt/nemoclaw-image/NemoClaw",
        observed: "/opt/nemoclaw-image/NemoClaw",
        status: "passed",
      },
      { field: "repoSha", expected: candidateSha, observed: candidateSha, status: "passed" },
      {
        field: "provisionSha",
        expected: candidateSha,
        observed: candidateSha,
        status: "passed",
      },
      {
        field: "imageRepositorySha",
        expected: "b".repeat(40),
        observed: "b".repeat(40),
        status: "passed",
      },
      { field: "repoClean", expected: true, observed: true, status: "passed" },
      { field: "runtimeOverrides", expected: false, observed: false, status: "passed" },
    ]);
  });

  it("blocks workspace execution for a wrong receipt, incomplete readiness, or wrong boot image", () => {
    const receipt = fixture({ receiptSha: "b".repeat(40) });
    const receiptResult = run(receipt.env);
    expect(receiptResult.status).not.toBe(0);
    expect(receiptResult.stderr).toContain("producer receipt does not match the candidate");
    expect(fs.readFileSync(receipt.calls, "utf8")).not.toMatch(/brev create|full-e2e\.test\.ts/u);

    [
      fixture({ omitReceiptField: "project" }),
      fixture({ omitReceiptField: "imageName" }),
      fixture({ imageRepositorySha: "not-a-sha" }),
    ].forEach((malformed) => {
      const malformedResult = run(malformed.env);
      expect(malformedResult.status).not.toBe(0);
      expect(malformedResult.stderr).toContain("producer receipt does not match the candidate");
      expect(fs.readFileSync(malformed.calls, "utf8")).not.toMatch(
        /brev create|full-e2e\.test\.ts/u,
      );
    });

    const unready = fixture({ ready: false });
    const unreadyResult = run({ ...unready.env, BREV_READY_TIMEOUT_SECONDS: "1" });
    expect(unreadyResult.status).not.toBe(0);
    expect(fs.readFileSync(unready.calls, "utf8")).not.toMatch(/brev exec|full-e2e\.test\.ts/u);
    expect(fs.existsSync(unready.state)).toBe(false);

    const wrongImage = fixture({
      bootImage: "projects/brevdevprod/global/images/wrong-image",
    });
    const wrongImageResult = run(wrongImage.env);
    expect(wrongImageResult.status).not.toBe(0);
    expect(wrongImageResult.stderr).toContain("booted image does not match the producer handoff");
    expect(fs.readFileSync(wrongImage.calls, "utf8")).not.toContain("full-e2e.test.ts");
    expect(fs.existsSync(wrongImage.state)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(wrongImage.workDir, "launchable-e2e.json"), "utf8")),
    ).toMatchObject({
      validation: {
        imageSelection: {
          status: "failed",
          expected: "projects/brevdevprod/global/images/nemoclaw-test-image",
          observed: "<redacted>",
        },
        runtimeProvenance: { status: "not-run", checks: [] },
        fullE2E: "not-run",
      },
    });
  });

  it("records and reports each runtime provenance mismatch before full E2E", () => {
    const cases = [
      {
        options: { repoSha: "b".repeat(40) },
        field: "repoSha",
        expected: candidateSha,
        observed: "b".repeat(40),
      },
      {
        options: { provisionSha: "b".repeat(40) },
        field: "provisionSha",
        expected: candidateSha,
        observed: "b".repeat(40),
      },
      {
        options: { provisionImageRepositorySha: "c".repeat(40) },
        field: "imageRepositorySha",
        expected: "b".repeat(40),
        observed: "c".repeat(40),
      },
      { options: { repoClean: false }, field: "repoClean", expected: true, observed: false },
      {
        options: { runtimeOverrides: true },
        field: "runtimeOverrides",
        expected: false,
        observed: true,
      },
      { options: { schemaVersion: 2 }, field: "schemaVersion", expected: 1, observed: 2 },
      {
        options: { sourceRepository: "example/NemoClaw" },
        field: "sourceRepository",
        expected: "NVIDIA/NemoClaw",
        observed: "<redacted>",
      },
      {
        options: { sourcePath: "/home/ubuntu/NemoClaw" },
        field: "sourcePath",
        expected: "/opt/nemoclaw-image/NemoClaw",
        observed: "<redacted>",
      },
    ];

    cases.forEach(({ options, field, expected, observed }) => {
      const boot = fixture(options);
      const bootResult = run(boot.env);
      expect(bootResult.status).not.toBe(0);
      expect(emittedOutput(bootResult, boot.workDir)).toContain(
        `Runtime provenance check failed: ${field} expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`,
      );
      expect(fs.readFileSync(boot.calls, "utf8")).not.toContain("full-e2e.test.ts");
      expect(fs.existsSync(boot.state)).toBe(false);
      const evidence = JSON.parse(
        fs.readFileSync(path.join(boot.workDir, "launchable-e2e.json"), "utf8"),
      );
      expect(evidence.boot).toMatchObject({
        bootImage: "projects/brevdevprod/global/images/nemoclaw-test-image",
        [String(field)]: observed,
      });
      expect(evidence.validation).toMatchObject({
        imageSelection: { status: "passed" },
        runtimeProvenance: { status: "failed" },
        fullE2E: "not-run",
      });
      expect(evidence.validation.runtimeProvenance.checks).toHaveLength(8);
      expect(
        evidence.validation.runtimeProvenance.checks.filter(
          (check: { status: string }) => check.status === "failed",
        ),
      ).toEqual([{ field, expected, observed, status: "failed" }]);
    });

    const multiple = fixture({
      repoClean: false,
      repoSha: "b".repeat(40),
      runtimeOverrides: true,
    });
    const multipleResult = run(multiple.env);
    const multipleOutput = emittedOutput(multipleResult, multiple.workDir);
    expect(multipleResult.status).not.toBe(0);
    expect(multipleOutput).toContain("Runtime provenance check failed: repoSha");
    expect(multipleOutput).toContain("Runtime provenance check failed: repoClean");
    expect(multipleOutput).toContain("Runtime provenance check failed: runtimeOverrides");
    expect(fs.readFileSync(multiple.calls, "utf8")).not.toContain("full-e2e.test.ts");
  }, 90_000);

  it("redacts a mismatched boot-image value before retaining failure evidence", () => {
    const credentialBearingValue =
      "projects/brevdevprod/global/images/guest-controlled-boot-secret";
    const boot = fixture({ bootImage: credentialBearingValue });
    const result = run(boot.env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("booted image does not match the producer handoff");
    expect(emittedOutput(result, boot.workDir)).not.toContain(credentialBearingValue);
    expect(fs.readFileSync(boot.calls, "utf8")).not.toContain("full-e2e.test.ts");
    const artifact = fs.readFileSync(path.join(boot.workDir, "launchable-e2e.json"), "utf8");
    expect(artifact).not.toContain(credentialBearingValue);
    expect(JSON.parse(artifact)).toMatchObject({
      boot: { bootImage: "<redacted>" },
      validation: {
        imageSelection: {
          status: "failed",
          expected: "projects/brevdevprod/global/images/nemoclaw-test-image",
          observed: "<redacted>",
        },
        runtimeProvenance: { status: "not-run", checks: [] },
        fullE2E: "not-run",
      },
    });
  });

  it("redacts unconstrained runtime provenance before retaining or logging it", () => {
    const credentialBearingValue = "NVIDIA/guest-controlled-secret";
    const boot = fixture({ sourceRepository: credentialBearingValue });
    const result = run(boot.env);
    expect(result.status).not.toBe(0);
    const output = emittedOutput(result, boot.workDir);
    expect(output).not.toContain(credentialBearingValue);
    expect(output).toContain(
      'Runtime provenance check failed: sourceRepository expected "NVIDIA/NemoClaw", observed "<redacted>"',
    );
    expect(fs.readFileSync(boot.calls, "utf8")).not.toContain("full-e2e.test.ts");
    const artifact = fs.readFileSync(path.join(boot.workDir, "launchable-e2e.json"), "utf8");
    expect(artifact).not.toContain(credentialBearingValue);
    const evidence = JSON.parse(artifact);
    expect(evidence.boot.sourceRepository).toBe("<redacted>");
    expect(
      evidence.validation.runtimeProvenance.checks.find(
        (check: { field: string }) => check.field === "sourceRepository",
      ),
    ).toEqual({
      field: "sourceRepository",
      expected: "NVIDIA/NemoClaw",
      observed: "<redacted>",
      status: "failed",
    });
  });

  it("retains bounded redacted host diagnostics before failed-workspace cleanup (#6409)", () => {
    const { calls, env, state, workDir } = fixture({ e2eFails: true });
    const result = run(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.indexOf("ssh preinstalled full-e2e.test.ts")).toBeLessThan(
      commands.indexOf("ssh full-e2e diagnostic gateway state"),
    );
    expect(commands.indexOf("ssh full-e2e diagnostic gateway state")).toBeLessThan(
      commands.indexOf("brev delete nclaw-e2e-test-1"),
    );
    expect(commands.match(/ssh full-e2e diagnostic/gu)).toHaveLength(6);

    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain("Full E2E failure diagnostics budget: up to 30 seconds");
    expect(laneLog).toContain("Full E2E failure diagnostic gateway state: status 0; output:");
    expect(laneLog).toContain("ActiveState : inactive");
    expect(laneLog).toContain("NRestarts : 0");
    expect(laneLog).toContain("restart-policy is always: true");
    expect(laneLog).toContain("exec-start matches packaged gateway service: true");
    expect(laneLog).toContain("fragment-path is packaged unit path: true");
    expect(laneLog).toContain("drop-ins: absent");
    expect(laneLog).toContain("Full E2E failure diagnostic platform state: status 0; output:");
    expect(laneLog).toContain("gateway service requires Docker service: present");
    expect(laneLog).toContain("gateway service ordered after Docker service: present");
    expect(laneLog).toContain("Docker service wants gateway service: present");
    expect(laneLog).not.toContain("boot-id-prefix");
    expect(laneLog).toContain("boot-uptime-seconds 180");
    expect(laneLog).toContain("gateway-state-dir type=directory uid=1000 gid=1000 mode=750");
    expect(laneLog).toContain("Full E2E failure diagnostic gateway lifecycle: status 0; output:");
    expect(laneLog).toContain("1000 starting");
    expect(laneLog).toContain("1100 started");
    expect(laneLog).toContain("1200 other-systemd-event");
    expect(laneLog).toContain("1300 start-limit-hit");
    expect(laneLog).toContain("1400 restart-scheduled");
    expect(laneLog).toContain("1500 main-exited");
    expect(laneLog).toContain("1600 failed-result");
    expect(laneLog).toContain("1700 dependency-failed");
    expect(laneLog).toContain("2200 stopping");
    expect(laneLog).toContain("2300 deactivated");
    expect(laneLog).toContain("2400 stopped");
    expect(laneLog).toContain("Full E2E failure diagnostic Docker lifecycle: status 0; output:");
    expect(laneLog).toContain("900 docker-service starting");
    expect(laneLog).toContain("950 docker-service started");
    expect(laneLog).toContain("960 docker-socket started");
    expect(laneLog).toContain("970 docker-unit other-systemd-event");
    expect(laneLog).toContain("Full E2E failure diagnostic cloud-final state: status 0; output:");
    expect(laneLog).toContain("SubState : exited");
    expect(laneLog).toContain("active-enter-us: 1200");
    expect(laneLog).toContain("inactive-enter-us: 0");
    expect(laneLog).toContain("listener presence: present");
    expect(laneLog).toContain("listener owner: unexpected");
    expect(laneLog).not.toContain("s3cr3t");
    const diagnosticLines = laneLog
      .split("\n")
      .filter((line) => line.startsWith("Full E2E failure diagnostic "));
    expect(diagnosticLines).toHaveLength(6);
    diagnosticLines
      .filter((line) => line.includes("; output: "))
      .forEach((line) => {
        const payload = line.split("; output: ", 2)[1] ?? "";
        expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(512);
      });
    const output = emittedOutput(result, workDir);
    expect(
      [
        "brev-test-secret",
        "github-test-token",
        "journal-test-secret",
        "nvapi-test-value",
        "private-key-material",
        "203.0.113.20",
        "workspace.hidden.internal",
        "s3cr3t",
      ].filter((secretOrAddress) => output.includes(secretOrAddress)),
    ).toEqual([]);
    expect(output).not.toContain("\u001B");
    expect(fs.existsSync(state)).toBe(false);
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "launchable-e2e.json"), "utf8")),
    ).toMatchObject({
      fullE2e: "failed",
      validation: {
        imageSelection: { status: "passed" },
        runtimeProvenance: { status: "passed" },
        fullE2E: "failed",
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("continues bounded diagnostics and cleanup after a probe error (#6409)", () => {
    const { calls, env, state, workDir } = fixture({
      e2eFails: true,
      platformDiagnosticFails: true,
    });
    const result = run(env);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain(
      "Full E2E failure diagnostic platform state: status 42; output:",
    );
    expect(laneLog).toContain("platform diagnostic safe detail");
    expect(laneLog).toContain("[REDACTED PRIVATE KEY]");
    expect(laneLog).toContain("[REDACTED LONG LINE]");
    expect(laneLog).toContain("Full E2E failure diagnostic gateway lifecycle: status 0; output:");
    expect(laneLog).toContain("Full E2E failure diagnostic port 8080 listener: status 0; output:");
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands.indexOf("ssh full-e2e diagnostic platform state")).toBeLessThan(
      commands.indexOf("ssh full-e2e diagnostic gateway lifecycle"),
    );
    expect(commands.indexOf("ssh full-e2e diagnostic gateway lifecycle")).toBeLessThan(
      commands.indexOf("brev delete nclaw-e2e-test-1"),
    );
    const output = emittedOutput(result, workDir);
    expect(
      [
        "brev-test-secret",
        "github-test-token",
        "journal-test-secret",
        "nvapi-test-value",
        "private-key-material",
        "203.0.113.20",
        "workspace.hidden.internal",
      ].filter((secretOrAddress) => output.includes(secretOrAddress)),
    ).toEqual([]);
    expect(output).not.toContain("\u001B");
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it.each([
    ["absent", "", ["listener presence: absent"]],
    [
      "expected owner",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "expected owner in a v2 descendant cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=97,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "expected owner in an exact v1 cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=96,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "expected owner in a v1 descendant cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=95,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "mixed owners",
      [
        'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3))',
        'LISTEN 0 4096 172.18.0.1:8080 0.0.0.0:* users:(("s3cr3t",pid=99,fd=4))',
      ].join("\n"),
      ["listener presence: present", "listener owner: mixed"],
    ],
    [
      "mixed owners in one socket record",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3),("s3cr3t",pid=99,fd=4))',
      ["listener presence: present", "listener owner: mixed"],
    ],
    [
      "unexpected owner",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gatew",pid=94,fd=3))',
      ["listener presence: present", "listener owner: unexpected"],
    ],
    [
      "unrelated cgroup",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("other-process",pid=93,fd=3))',
      ["listener presence: present", "listener owner: unexpected"],
    ],
    [
      "owner unavailable",
      "LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:*",
      ["listener presence: present", "listener owner: unavailable"],
    ],
    [
      "PID-like text inside a process label",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("s3cr3t,pid=7,fd=8",pid=98,fd=3))',
      ["listener presence: present", "listener owner: openshell-gateway"],
    ],
    [
      "an injected owner tuple inside a process label",
      'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("s3cr3t",pid=98,fd=3",pid=99,fd=4))',
      ["listener presence: present", "listener owner: unavailable"],
    ],
    [
      "one socket record without owner metadata",
      [
        'LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:* users:(("openshell-gateway",pid=98,fd=3))',
        "LISTEN 0 4096 172.18.0.1:8080 0.0.0.0:*",
      ].join("\n"),
      ["listener presence: present", "listener owner: unavailable"],
    ],
  ])(
    "classifies port 8080 listener evidence with %s (#6409)",
    (_name, listenerOutput, expectedEvidence) => {
      const { env, workDir } = fixture({
        e2eFails: true,
        listenerOutput,
      });
      const result = run(env);

      expect(result.status).not.toBe(0);
      const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
      expectedEvidence.forEach((entry) => expect(laneLog).toContain(entry));
      expect(laneLog).not.toContain("s3cr3t");
      expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject(
        { status: "ABSENT" },
      );
    },
  );

  it.each([
    [
      "a similarly prefixed executable",
      "{ path=/usr/local/bin/nemoclaw-openshell-gateway-service-wrapper ; argv[]=/usr/local/bin/nemoclaw-openshell-gateway-service-wrapper ; ignore_errors=no ; }",
      "nemoclaw-openshell-gateway-service-wrapper",
    ],
    [
      "an extra argument",
      "{ path=/usr/local/bin/nemoclaw-openshell-gateway-service ; argv[]=/usr/local/bin/nemoclaw-openshell-gateway-service --extra ; ignore_errors=no ; }",
      "--extra",
    ],
    [
      "a second serialized command",
      "{ path=/usr/local/bin/nemoclaw-openshell-gateway-service ; argv[]=/usr/local/bin/nemoclaw-openshell-gateway-service ; ignore_errors=no ; } { path=/usr/bin/true ; argv[]=/usr/bin/true ; ignore_errors=no ; }",
      "/usr/bin/true",
    ],
  ])("rejects gateway ExecStart with %s (#6409)", (_name, gatewayExecStart, rawValue) => {
    const { env, workDir } = fixture({ e2eFails: true, gatewayExecStart });
    const result = run(env);

    expect(result.status).not.toBe(0);
    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain("exec-start matches packaged gateway service: false");
    expect(laneLog).not.toContain(rawValue);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("keeps the E2E failure and cleanup when the diagnostic budget expires (#6409)", () => {
    const { calls, env, state, workDir } = fixture({
      e2eDiagnosticTimesOut: true,
      e2eFails: true,
    });
    const result = run({
      ...env,
      FULL_E2E_FAILURE_DIAGNOSTIC_TIMEOUT_SECONDS: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
    const laneLog = fs.readFileSync(path.join(workDir, "lane.log"), "utf8");
    expect(laneLog).toContain(
      "Full E2E failure diagnostic gateway state: status 124; output: probe timed out",
    );
    expect(laneLog).toContain(
      "Full E2E failure diagnostic platform state: not run; output: diagnostic budget exhausted",
    );
    expect(laneLog).toContain(
      "Full E2E failure diagnostic port 8080 listener: not run; output: diagnostic budget exhausted",
    );
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).not.toContain("ssh full-e2e diagnostic platform state");
    expect(commands.indexOf("ExecMainCode")).toBeLessThan(
      commands.indexOf("brev delete nclaw-e2e-test-1"),
    );
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("protects and removes raw inference evidence without passing the credential to redactor arguments", () => {
    const { calls, env, state, workDir } = fixture();
    fs.mkdirSync(path.join(workDir, "full-e2e.log"));
    const result = run(env);

    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(calls, "utf8")).toContain(
      "python redactor arg-count 3 with environment secret and modes 600/700",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("nvapi-test-value");
    expect(
      fs
        .readdirSync(String(env.RUNNER_TEMP))
        .filter((entry) => entry.startsWith("brev-launchable-e2e.")),
    ).toEqual([]);
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("reports only the final sanitized refresh and workspace SSH failures", () => {
    const { calls, env, state, workDir } = fixture({
      sshAliasConfigured: false,
      refreshError: `refresh final safe detail\npassword=hunter2\n${"x".repeat(5_000)}`,
      refreshStatus: 35,
      sshError:
        "hidden-user@example.internal: Permission denied (publickey); SSH final safe detail; kex_exchange_identification; password=ssh-secret; identityfile=/hidden/private-key\nAuthorization: Bearer short-token",
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
    });
    const result = run({ ...env, BREV_SSH_TIMEOUT_SECONDS: "2" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("workspace SSH readiness timed out");
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).toContain("timeout 2s ssh -G nclaw-e2e-test-1");
    expect(commands).toContain("timeout 5s brev exec nclaw-e2e-test-1 true");
    expect(commands).toMatch(
      /timeout 5s ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o NumberOfPasswordPrompts=0 -o RequestTTY=no -o LogLevel=ERROR nclaw-e2e-test-1 true/u,
    );
    expect(commands).not.toMatch(/--host|nclaw-e2e-test-1-host/u);
    expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);

    const output = emittedOutput(result, workDir);
    expect(output).toContain(
      "Readiness Brev refresh last failure: status 35; error: refresh final safe detail",
    );
    expect(output).toContain("Readiness direct SSH last failure: status 34; error:");
    expect(output).toContain("SSH final safe detail");
    expect(output).toContain("kex_exchange_identification");
    expect(output).toContain("Readiness SSH alias nclaw-e2e-test-1: missing");
    expect(output).toContain("Readiness probe brev exec: failure; status 31;");
    expect(output).toContain("Readiness probe direct SSH: failure; status 34;");
    expect(output).toContain("Readiness classification: Brev refresh/configuration failure");
    expect(output).not.toContain("stale refresh detail");
    expect(output).not.toContain("stale SSH detail");
    const diagnosticErrorLines = fs
      .readFileSync(path.join(workDir, "lane.log"), "utf8")
      .split("\n")
      .filter((line) => line.includes("; error:"));
    expect(diagnosticErrorLines).not.toHaveLength(0);
    diagnosticErrorLines.forEach((line) => {
      const error = line.split("; error: ", 2)[1]?.replace(/\)$/u, "") ?? "";
      expect(Buffer.byteLength(error)).toBeLessThanOrEqual(512);
    });
    expect(
      [
        "brev-test-secret",
        "exec-secret",
        "ssh-secret",
        "short-token",
        "hunter2",
        "hidden-user",
        "github-test-token",
        "nvapi-test-value",
        "/hidden/private-key",
        "workspace.hidden.internal",
        "exec.hidden.internal",
        "refresh.hidden.internal",
        "203.0.113.20",
        "identityfile /hidden/private-key",
        "user hidden-user",
      ].filter((secretOrConfiguration) => output.includes(secretOrConfiguration)),
    ).toEqual([]);
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it.each([
    ["Brev execution works but direct SSH fails", { brevExecStatus: 0 }],
    ["direct SSH recovered during diagnostics", { sshProbeStatus: 0 }],
    ["workspace shell is unreachable", {}],
  ])("classifies %s after the shared readiness deadline", (classification, probeOptions) => {
    const { calls, env, state, workDir } = fixture({
      ...probeOptions,
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
    });
    const result = run({ ...env, BREV_SSH_TIMEOUT_SECONDS: "1" });
    expect(result.status).not.toBe(0);
    expect(emittedOutput(result, workDir)).toContain(`Readiness classification: ${classification}`);
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).toContain("timeout 5s brev exec nclaw-e2e-test-1 true");
    expect(commands).toMatch(/timeout 5s ssh -T .* nclaw-e2e-test-1 true/u);
    expect(commands).not.toMatch(/--host|nclaw-e2e-test-1-host/u);
    expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("reports unavailable when SSH alias lookup fails", () => {
    const { env, state, workDir } = fixture({
      sshAliasQueryStatus: 42,
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
    });
    const result = run({ ...env, BREV_SSH_TIMEOUT_SECONDS: "1" });
    expect(result.status).not.toBe(0);
    const output = emittedOutput(result, workDir);
    expect(output).toContain("Readiness SSH alias nclaw-e2e-test-1: unavailable");
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("reports unavailable when the SSH alias diagnostic times out", () => {
    const { env, state, workDir } = fixture({
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
      timeoutBlockDiagnostics: true,
    });
    const result = run({
      ...env,
      BREV_SSH_TIMEOUT_SECONDS: "1",
      BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS: "2",
    });
    expect(result.status).not.toBe(0);
    const output = emittedOutput(result, workDir);
    expect(output).toContain("Readiness SSH alias nclaw-e2e-test-1: unavailable");
    expect(output).toContain(
      "Readiness classification: incomplete diagnostics; inspect available bounded probe results",
    );
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it.each([
    ["BREV_SSH_TIMEOUT_SECONDS", "1+1"],
    ["BREV_SSH_TIMEOUT_SECONDS", "0"],
    ["BREV_SSH_TIMEOUT_SECONDS", ""],
    ["BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS", "0"],
    ["FULL_E2E_FAILURE_DIAGNOSTIC_TIMEOUT_SECONDS", "0"],
    ["POLL_SECONDS", "0"],
    ["POLL_SECONDS", ""],
  ])("rejects invalid %s=%s before dispatch", (name, value) => {
    const { calls, env, workDir } = fixture();
    const result = run({ ...env, [name]: value });
    expect(result.status).not.toBe(0);
    expect(emittedOutput(result, workDir)).toContain(`${name} must be a positive integer`);
    expect(fs.existsSync(calls)).toBe(false);
  });

  it("rejects arithmetic expansion in the poll interval before dispatch", () => {
    const { calls, env, workDir } = fixture();
    const marker = path.join(workDir, "arithmetic-expansion-ran");
    const result = run({ ...env, POLL_SECONDS: `$(touch ${marker})` });
    expect(result.status).not.toBe(0);
    expect(emittedOutput(result, workDir)).toContain("POLL_SECONDS must be a positive integer");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(calls)).toBe(false);
  });

  it("caps blocking readiness and failure diagnostics by separate deadlines", () => {
    const { calls, env, state, workDir } = fixture({
      timeoutBlockCommand: "brev refresh",
      timeoutBlockDiagnostics: true,
    });
    const startedAt = performance.now();
    const result = run({
      ...env,
      BREV_SSH_TIMEOUT_SECONDS: "1",
      BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS: "4",
    });
    const elapsedMs = performance.now() - startedAt;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("workspace SSH readiness timed out");
    expect(elapsedMs).toBeLessThan(10_000);
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).toContain("timeout 1s brev refresh");
    expect(commands).toContain("timeout 2s ssh -G nclaw-e2e-test-1");
    expect(commands).toMatch(/timeout [12]s brev exec nclaw-e2e-test-1 true/u);
    expect(commands).not.toMatch(/--host|nclaw-e2e-test-1-host/u);
    expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);
    const output = emittedOutput(result, workDir);
    expect(output).toContain("Readiness diagnostics budget: up to 4 seconds");
    expect(output).toContain("Readiness probe brev exec: failure; status 124;");
    expect(output).toContain(
      "Readiness probe direct SSH: not run; status unavailable; error: diagnostic budget exhausted",
    );
    expect(output).toContain("diagnostic budget exhausted");
    expect(output).toContain(
      "Readiness classification: incomplete diagnostics; inspect available bounded probe results",
    );
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  }, 90_000);

  it("caps a blocking SSH probe by the workspace SSH deadline and deletes the workspace", () => {
    const { calls, env, state, workDir } = fixture({ timeoutBlockCommand: "ssh" });
    const startedAt = performance.now();
    const result = run({ ...env, BREV_SSH_TIMEOUT_SECONDS: "2" });
    const elapsedMs = performance.now() - startedAt;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("workspace SSH readiness timed out");
    expect(elapsedMs).toBeLessThan(10_000);
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).toMatch(/timeout [12]s ssh -T .*nclaw-e2e-test-1 true/u);
    expect(commands.match(/timeout [12]s ssh -T .*nclaw-e2e-test-1 true/gu)).toHaveLength(1);
    expect(commands).not.toMatch(/--host|nclaw-e2e-test-1-host/u);
    expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  }, 90_000);

  it("caps the poll sleep by the shared readiness deadline", () => {
    const { calls, env, state, workDir } = fixture({
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
    });
    const result = run({
      ...env,
      BREV_SSH_TIMEOUT_SECONDS: "2",
      POLL_SECONDS: "9",
    });
    expect(result.status).not.toBe(0);
    const commands = fs.readFileSync(calls, "utf8");
    const readinessCommands = commands.slice(
      commands.indexOf("timeout 2s brev refresh"),
      commands.indexOf("timeout 60s brev delete"),
    );
    expect(readinessCommands).toMatch(/sleep [12]/u);
    expect(readinessCommands).not.toContain("sleep 9");
    expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("preserves the booted image when the provision receipt is missing", () => {
    const { calls, env, state, workDir } = fixture({ missingProvisionReceipt: true });
    const result = run(env);
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.readFileSync(calls, "utf8")).not.toContain("full-e2e.test.ts");
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "launchable-e2e.json"), "utf8")),
    ).toMatchObject({
      candidateSha,
      boot: { bootImage: "projects/brevdevprod/global/images/nemoclaw-test-image" },
      fullE2e: "pending",
      validation: {
        imageSelection: { status: "passed" },
        runtimeProvenance: { status: "not-run", checks: [] },
        fullE2E: "not-run",
      },
    });
  });

  it("fails the lane when workspace deletion cannot be verified", () => {
    const { env, state } = fixture({ deleteFails: true });
    const result = run({ ...env, BREV_DELETE_TIMEOUT_SECONDS: "1", POLL_SECONDS: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("still exists after deletion");
    expect(fs.existsSync(state)).toBe(true);
  });
});
