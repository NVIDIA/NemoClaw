// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "tools", "e2e", "brev-launchable-e2e.sh");
const REAL_PYTHON3 = spawnSync("which", ["python3"], { encoding: "utf8" }).stdout.trim();
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
    brevContainerStatus?: number;
    brevHostStatus?: number;
    deleteFails?: boolean;
    e2eFails?: boolean;
    imageRepositorySha?: string;
    missingProvisionReceipt?: boolean;
    omitReceiptField?: "imageName" | "imageRepositorySha" | "project";
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
    hostAliasConfigured?: boolean;
    plainAliasConfigured?: boolean;
    sshDefaultStatus?: number;
    sshHostError?: string;
    sshHostProbeStatus?: number;
    sshReadyAfter?: number;
    sshAliasQueryStatus?: number;
    sourceRepository?: string;
    sourcePath?: string;
    timeoutBlockCommand?: "brev refresh" | "ssh-host";
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
elif [ "$FAKE_TIMEOUT_BLOCK_COMMAND" = "ssh-host" ] && [ "\${1:-}" = ssh ] &&
  [[ " $* " == *" $INSTANCE_NAME-host true "* ]]; then
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
      if [ "\${4:-}" = --host ]; then
        [ "$FAKE_BREV_HOST_STATUS" -eq 0 ] || printf '%s\n' "$FAKE_BREV_HOST_ERROR" >&2
        exit "$FAKE_BREV_HOST_STATUS"
      fi
      [ "$FAKE_BREV_CONTAINER_STATUS" -eq 0 ] || printf '%s\n' "$FAKE_BREV_CONTAINER_ERROR" >&2
      exit "$FAKE_BREV_CONTAINER_STATUS"
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
if [ "\${1:-}" = -G ]; then
  touch "$FAKE_DIAGNOSTIC_PHASE"
  [ "$FAKE_SSH_ALIAS_QUERY_STATUS" -eq 0 ] || exit "$FAKE_SSH_ALIAS_QUERY_STATUS"
  alias="\${2:-}"
  configured=0
  if [ "$alias" = "$INSTANCE_NAME" ]; then
    configured="$FAKE_PLAIN_ALIAS_CONFIGURED"
  elif [ "$alias" = "$INSTANCE_NAME-host" ]; then
    configured="$FAKE_HOST_ALIAS_CONFIGURED"
  fi
  if [ "$configured" = 1 ]; then hostname=203.0.113.20; else hostname="$alias"; fi
  printf 'hostname %s\n' "$hostname"
  printf 'user hidden-user\nidentityfile /hidden/private-key\nproxycommand none\n'
  exit 0
fi
if [ "\${*: -1}" = true ]; then
  required=(-T "-o BatchMode=yes" "-o ConnectTimeout=10" "-o ConnectionAttempts=1" "-o NumberOfPasswordPrompts=0" "-o RequestTTY=no" "-o LogLevel=ERROR")
  for argument in "\${required[@]}"; do
    [[ " $* " == *" $argument "* ]]
  done
  target="\${*: -2:1}"
  if [ "$target" = "$INSTANCE_NAME" ]; then
    printf 'ssh default diagnostic probe: %s\n' "$*" >> "$FAKE_CALLS"
    if [ "$FAKE_SSH_DEFAULT_STATUS" -ne 0 ]; then
      printf '%s\n' "$FAKE_SSH_DEFAULT_ERROR" >&2
      exit "$FAKE_SSH_DEFAULT_STATUS"
    fi
    exit 0
  fi
  [ "$target" = "$INSTANCE_NAME-host" ]
  if [ -f "$FAKE_DIAGNOSTIC_PHASE" ]; then
    if [ "$FAKE_SSH_HOST_PROBE_STATUS" -ne 0 ]; then
      printf '%s\n' "$FAKE_SSH_HOST_ERROR" >&2
      exit "$FAKE_SSH_HOST_PROBE_STATUS"
    fi
    exit 0
  fi
  attempts=0
  [ ! -f "$FAKE_SSH_ATTEMPTS" ] || attempts="$(cat "$FAKE_SSH_ATTEMPTS")"
  attempts=$((attempts + 1))
  printf '%s\n' "$attempts" > "$FAKE_SSH_ATTEMPTS"
  printf 'ssh host readiness attempt %s: %s\n' "$attempts" "$*" >> "$FAKE_CALLS"
  if [ "$attempts" -lt "$FAKE_SSH_READY_AFTER" ]; then
    if [ "$attempts" -eq 1 ]; then
      printf 'stale host SSH detail\n' >&2
    else
      printf '%s\n' "$FAKE_SSH_HOST_ERROR" >&2
    fi
    exit 34
  fi
  exit 0
fi
script="$(cat)"
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
    FAKE_BREV_CONTAINER_ERROR:
      "Brev container safe detail; credential=container-secret; endpoint=container.hidden.internal",
    FAKE_BREV_CONTAINER_STATUS: String(options.brevContainerStatus ?? 31),
    FAKE_BREV_HOST_ERROR:
      "Brev host safe detail; token=host-token; endpoint=host-exec.hidden.internal",
    FAKE_BREV_HOST_STATUS: String(options.brevHostStatus ?? 32),
    FAKE_CALLS: calls,
    FAKE_DELETE_FAILS: options.deleteFails ? "1" : "0",
    FAKE_DIAGNOSTIC_PHASE: diagnosticPhase,
    FAKE_E2E_FAILS: options.e2eFails ? "1" : "0",
    FAKE_IMAGE_REPOSITORY_SHA: options.imageRepositorySha ?? "b".repeat(40),
    FAKE_HOST_ALIAS_CONFIGURED: options.hostAliasConfigured === false ? "0" : "1",
    FAKE_MISSING_PROVISION_RECEIPT: options.missingProvisionReceipt ? "1" : "0",
    FAKE_OMIT_RECEIPT_FIELD: options.omitReceiptField ?? "",
    FAKE_PROVISION_IMAGE_REPOSITORY_SHA:
      options.provisionImageRepositorySha ?? options.imageRepositorySha ?? "b".repeat(40),
    FAKE_PROVISION_SHA: options.provisionSha ?? candidateSha,
    FAKE_PLAIN_ALIAS_CONFIGURED: options.plainAliasConfigured === false ? "0" : "1",
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
    FAKE_SSH_DEFAULT_ERROR:
      "default SSH safe detail; kex_exchange_identification; password=default-secret; host=default.hidden.internal",
    FAKE_SSH_DEFAULT_STATUS: String(options.sshDefaultStatus ?? 33),
    FAKE_SSH_ALIAS_QUERY_STATUS: String(options.sshAliasQueryStatus ?? 0),
    FAKE_SSH_HOST_ERROR:
      options.sshHostError ??
      "ssh: Could not resolve hostname host.hidden.internal: host SSH safe detail; password=ssh-secret; identityfile=/hidden/private-key",
    FAKE_SSH_HOST_PROBE_STATUS: String(options.sshHostProbeStatus ?? 34),
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
    expect(commands.match(/ssh host readiness attempt/gu)).toHaveLength(6);
    const readinessCommands = commands.slice(
      commands.indexOf("create nclaw-e2e-test-1 --launchable env-staging123"),
      commands.indexOf("NEMOCLAW_BOOT_IMAGE"),
    );
    expect(readinessCommands.split("\n").filter((line) => line === "brev refresh")).toHaveLength(2);
    expect(readinessCommands.indexOf("brev refresh")).toBeLessThan(
      readinessCommands.indexOf("ssh default diagnostic probe"),
    );
    expect(readinessCommands.indexOf("brev refresh")).toBeLessThan(
      readinessCommands.indexOf("ssh host readiness attempt 1"),
    );
    expect(readinessCommands.lastIndexOf("brev refresh")).toBeGreaterThan(
      readinessCommands.indexOf("ssh host readiness attempt 5"),
    );
    expect(readinessCommands.lastIndexOf("brev refresh")).toBeLessThan(
      readinessCommands.indexOf("ssh host readiness attempt 6"),
    );
    expect(readinessCommands).toContain("sleep 5");
    const readinessCall = commands
      .split("\n")
      .find((line) => line.startsWith("ssh host readiness attempt 1: "));
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
      "nclaw-e2e-test-1-host",
      "true",
    ]);
    expect(fs.readFileSync(sshAttempts, "utf8").trim()).toBe("6");
    expect(commands).toContain("ssh preinstalled full-e2e.test.ts");
    expect(commands).not.toContain("nvapi-test-value");
    expect(commands).not.toMatch(/rsync|install\.sh|npm (?:ci|install)|git clone/u);
    expect(fs.readFileSync(path.join(workDir, "lane.log"), "utf8")).not.toMatch(
      /last failure|Readiness diagnostics budget|Readiness probe|Readiness SSH alias|Readiness classification/u,
    );
    expect(fs.readFileSync(path.join(workDir, "lane.log"), "utf8")).toContain(
      "Waiting up to 900 seconds for host SSH access",
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
    expect(
      JSON.parse(fs.readFileSync(path.join(workDir, "launchable-e2e.json"), "utf8")),
    ).toMatchObject({
      candidateSha,
      fullE2e: "passed",
      producer: { runId: "123", status: "success" },
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
  });

  it("blocks E2E for a wrong receipt, incomplete readiness, or booted checkout mismatch", () => {
    const receipt = fixture({ receiptSha: "b".repeat(40) });
    const receiptResult = run(receipt.env);
    expect(receiptResult.status).not.toBe(0);
    expect(receiptResult.stderr).toContain("producer receipt does not match the candidate");
    expect(fs.readFileSync(receipt.calls, "utf8")).not.toMatch(/brev create|full-e2e\.test\.ts/u);

    for (const malformed of [
      fixture({ omitReceiptField: "project" }),
      fixture({ omitReceiptField: "imageName" }),
      fixture({ imageRepositorySha: "not-a-sha" }),
    ]) {
      const malformedResult = run(malformed.env);
      expect(malformedResult.status).not.toBe(0);
      expect(malformedResult.stderr).toContain("producer receipt does not match the candidate");
      expect(fs.readFileSync(malformed.calls, "utf8")).not.toMatch(
        /brev create|full-e2e\.test\.ts/u,
      );
    }

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

    for (const boot of [
      fixture({ repoSha: "b".repeat(40) }),
      fixture({ provisionSha: "b".repeat(40) }),
      fixture({ provisionImageRepositorySha: "c".repeat(40) }),
      fixture({ repoClean: false }),
      fixture({ runtimeOverrides: true }),
      fixture({ schemaVersion: 2 }),
      fixture({ sourceRepository: "example/NemoClaw" }),
      fixture({ sourcePath: "/home/ubuntu/NemoClaw" }),
    ]) {
      const bootResult = run(boot.env);
      expect(bootResult.status).not.toBe(0);
      expect(bootResult.stderr).toContain(
        "booted image runtime does not match the producer handoff",
      );
      expect(fs.readFileSync(boot.calls, "utf8")).not.toContain("full-e2e.test.ts");
      expect(fs.existsSync(boot.state)).toBe(false);
    }
  }, 90_000);

  it("reports E2E failure only after verified workspace cleanup", () => {
    const { env, state, workDir } = fixture({ e2eFails: true });
    const result = run(env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("full E2E failed");
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

  it("reports only the final sanitized refresh and direct host SSH failures", () => {
    const { calls, env, state, workDir } = fixture({
      plainAliasConfigured: false,
      refreshError: `refresh final safe detail\npassword=hunter2\n${"x".repeat(5_000)}`,
      refreshStatus: 35,
      sshHostError:
        "hidden-user@example.internal: Permission denied (publickey); host SSH final safe detail; password=ssh-secret; identityfile=/hidden/private-key\nAuthorization: Bearer short-token",
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
    });
    const result = run({ ...env, BREV_HOST_SSH_TIMEOUT_SECONDS: "2" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("host SSH readiness timed out");
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).toContain("timeout 2s ssh -G nclaw-e2e-test-1");
    expect(commands).toContain("timeout 2s ssh -G nclaw-e2e-test-1-host");
    expect(commands).toContain("timeout 5s brev exec nclaw-e2e-test-1 true");
    expect(commands).toContain("timeout 5s brev exec nclaw-e2e-test-1 true --host");
    expect(commands).toMatch(
      /timeout 5s ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o NumberOfPasswordPrompts=0 -o RequestTTY=no -o LogLevel=ERROR nclaw-e2e-test-1 true/u,
    );
    expect(commands).toMatch(
      /timeout 5s ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o NumberOfPasswordPrompts=0 -o RequestTTY=no -o LogLevel=ERROR nclaw-e2e-test-1-host true/u,
    );
    expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);

    const output = emittedOutput(result, workDir);
    expect(output).toContain(
      "Readiness Brev refresh last failure: status 35; error: refresh final safe detail",
    );
    expect(output).toContain("Readiness direct host SSH last failure: status 34; error:");
    expect(output).toContain("host SSH final safe detail");
    expect(output).toContain("kex_exchange_identification");
    expect(output).toContain("Readiness SSH alias nclaw-e2e-test-1: missing");
    expect(output).toContain("Readiness SSH alias nclaw-e2e-test-1-host: configured");
    expect(output).toContain("Readiness probe brev exec container: failure; status 31;");
    expect(output).toContain("Readiness probe brev exec host: failure; status 32;");
    expect(output).toContain("Readiness probe direct SSH container: failure; status 33;");
    expect(output).toContain("Readiness probe direct SSH host: failure; status 34;");
    expect(output).toContain("Readiness classification: Brev refresh/configuration failure");
    expect(output).not.toContain("stale refresh detail");
    expect(output).not.toContain("stale host SSH detail");
    const diagnosticErrorLines = fs
      .readFileSync(path.join(workDir, "lane.log"), "utf8")
      .split("\n")
      .filter((line) => line.includes("; error:"));
    expect(diagnosticErrorLines).not.toHaveLength(0);
    for (const line of diagnosticErrorLines) {
      const error = line.split("; error: ", 2)[1]?.replace(/\)$/u, "") ?? "";
      expect(Buffer.byteLength(error)).toBeLessThanOrEqual(512);
    }
    expect([
          "brev-test-secret",
          "container-secret",
          "default-secret",
          "host-token",
          "ssh-secret",
          "short-token",
          "hunter2",
          "hidden-user",
          "github-test-token",
          "nvapi-test-value",
          "/hidden/private-key",
          "host.hidden.internal",
          "host-exec.hidden.internal",
          "container.hidden.internal",
          "refresh.hidden.internal",
          "203.0.113.20",
          "identityfile /hidden/private-key",
          "user hidden-user",
        ].every((secretOrConfiguration) => !output.includes(secretOrConfiguration))).toBe(true);
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it.each([
    ["default container reachable but host unreachable", { brevContainerStatus: 0 }],
    ["Brev host execution works but direct host SSH fails", { brevHostStatus: 0 }],
    ["mixed connectivity failure; inspect bounded probe results", { sshHostProbeStatus: 0 }],
    ["neither target reachable", {}],
  ])("classifies %s after the shared readiness deadline", (classification, probeOptions) => {
    const { calls, env, state, workDir } = fixture({
      ...probeOptions,
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
    });
    const result = run({ ...env, BREV_HOST_SSH_TIMEOUT_SECONDS: "1" });
    expect(result.status).not.toBe(0);
    expect(emittedOutput(result, workDir)).toContain(`Readiness classification: ${classification}`);
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).toContain("timeout 5s brev exec nclaw-e2e-test-1 true");
    expect(commands).toContain("timeout 5s brev exec nclaw-e2e-test-1 true --host");
    expect(commands).toMatch(/timeout 5s ssh -T .* nclaw-e2e-test-1 true/u);
    expect(commands).toMatch(/timeout 5s ssh -T .* nclaw-e2e-test-1-host true/u);
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
    const result = run({ ...env, BREV_HOST_SSH_TIMEOUT_SECONDS: "1" });
    expect(result.status).not.toBe(0);
    const output = emittedOutput(result, workDir);
    expect(output).toContain("Readiness SSH alias nclaw-e2e-test-1: unavailable");
    expect(output).toContain("Readiness SSH alias nclaw-e2e-test-1-host: unavailable");
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it("reports not checked when the SSH alias diagnostic budget expires", () => {
    const { env, state, workDir } = fixture({
      sshReadyAfter: Number.MAX_SAFE_INTEGER,
      timeoutBlockDiagnostics: true,
    });
    const result = run({
      ...env,
      BREV_HOST_SSH_TIMEOUT_SECONDS: "1",
      BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS: "2",
    });
    expect(result.status).not.toBe(0);
    const output = emittedOutput(result, workDir);
    expect(output).toContain("Readiness SSH alias nclaw-e2e-test-1-host: not checked");
    expect(output).toContain(
      "Readiness classification: incomplete diagnostics; inspect available bounded probe results",
    );
    expect(fs.existsSync(state)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject({
      status: "ABSENT",
    });
  });

  it.each([
    ["BREV_HOST_SSH_TIMEOUT_SECONDS", "1+1"],
    ["BREV_HOST_SSH_TIMEOUT_SECONDS", "0"],
    ["BREV_HOST_SSH_TIMEOUT_SECONDS", ""],
    ["BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS", "0"],
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

  it.each(
    ["brev exec host", "direct SSH container", "direct SSH host"],
  )(
    "caps blocking readiness and failure diagnostics by separate deadlines [%s]",
    (label) => {
      const { calls, env, state, workDir } = fixture({
        timeoutBlockCommand: "brev refresh",
        timeoutBlockDiagnostics: true,
      });
      const startedAt = performance.now();
      const result = run({
        ...env,
        BREV_HOST_SSH_TIMEOUT_SECONDS: "1",
        BREV_READINESS_DIAGNOSTIC_TIMEOUT_SECONDS: "6",
      });
      const elapsedMs = performance.now() - startedAt;
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("host SSH readiness timed out");
      expect(elapsedMs).toBeLessThan(12_000);
      const commands = fs.readFileSync(calls, "utf8");
      expect(commands).toContain("timeout 1s brev refresh");
      expect(commands).toContain("timeout 2s ssh -G nclaw-e2e-test-1");
      expect(commands).toContain("timeout 2s ssh -G nclaw-e2e-test-1-host");
      expect(commands).toMatch(/timeout [12]s brev exec nclaw-e2e-test-1 true/u);
      expect(commands).not.toMatch(/NEMOCLAW_BOOT_IMAGE|full-e2e\.test\.ts/u);
      const output = emittedOutput(result, workDir);
      expect(output).toContain("Readiness diagnostics budget: up to 6 seconds");
      expect(output).toContain("Readiness probe brev exec container: failure; status 124;");

      expect(output).toContain(
        `Readiness probe ${label}: not run; status unavailable; error: diagnostic budget exhausted`,
      );

      expect(output).toContain("diagnostic budget exhausted");
      expect(output).toContain(
        "Readiness classification: incomplete diagnostics; inspect available bounded probe results",
      );
      expect(output).not.toContain("Readiness classification: neither target reachable");
      expect(fs.existsSync(state)).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(workDir, "cleanup.json"), "utf8"))).toMatchObject(
        {
          status: "ABSENT",
        },
      );
    },
    90_000,
  );

  it("caps a blocking SSH probe by the host SSH deadline and deletes the workspace", () => {
    const { calls, env, state, workDir } = fixture({ timeoutBlockCommand: "ssh-host" });
    const startedAt = performance.now();
    const result = run({ ...env, BREV_HOST_SSH_TIMEOUT_SECONDS: "2" });
    const elapsedMs = performance.now() - startedAt;
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("host SSH readiness timed out");
    expect(elapsedMs).toBeLessThan(10_000);
    const commands = fs.readFileSync(calls, "utf8");
    expect(commands).toMatch(/timeout [12]s ssh -T .*nclaw-e2e-test-1-host true/u);
    expect(commands.match(/timeout [12]s ssh -T .*nclaw-e2e-test-1-host true/gu)).toHaveLength(1);
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
      BREV_HOST_SSH_TIMEOUT_SECONDS: "2",
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
