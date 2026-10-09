// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { addAbortListener } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { describe, expect, it, type TestContext, vi } from "vitest";
import YAML from "yaml";

import { superviseChild } from "../../helpers/process-supervisor.ts";

import {
  validateNativePodmanRestoreAction,
  validateNativePodmanSetupAction,
} from "../../../tools/e2e/workflow-boundary.mts";

const RESTORE_ACTION = path.resolve(".github/actions/restore-native-podman-e2e/action.yaml");
const SETUP_ACTION = path.resolve(".github/actions/setup-native-podman-e2e/action.yaml");
const FIXED_RESTORE_ROOT = "/usr/lib/nemoclaw-native-podman-e2e/docker-cli-restore";
const COMMAND_OUTPUT_LIMIT = 64 * 1024;
const OUTPUT_TRUNCATION_MARKER = "\n[output truncated]\n";

type WorkflowStep = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: string | string[];
  "runs-on"?: string;
  steps?: WorkflowStep[];
};

function e2eWorkflowJobs(): Record<string, WorkflowJob> {
  const workflow = YAML.parse(fs.readFileSync(".github/workflows/e2e.yaml", "utf8")) as {
    jobs: Record<string, WorkflowJob>;
  };
  return workflow.jobs;
}

vi.setConfig({ maxConcurrency: 5 });

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function restoreRunScript(): string {
  const action = YAML.parse(fs.readFileSync(RESTORE_ACTION, "utf8")) as {
    runs: { steps: Array<{ name?: string; run?: string }> };
  };
  return String(
    action.runs.steps.find(
      ({ name }) => name === "Restore Docker CLI after native Podman execution",
    )?.run ?? "",
  );
}

function setupRunScript(): string {
  const action = YAML.parse(fs.readFileSync(SETUP_ACTION, "utf8")) as {
    runs: { steps: Array<{ name?: string; run?: string }> };
  };
  return String(
    action.runs.steps.find(({ name }) => name === "Start native Podman runtime")?.run ?? "",
  );
}

function interruptedSetupHarness(cleanupRoot: string): string {
  const source = setupRunScript();
  const start = source.indexOf("setup_completed=false");
  const trapEndMarker = "trap 'exit 143' TERM";
  const trapEnd = source.indexOf("\nfi", source.indexOf(trapEndMarker, start));
  const trapBoundary = source
    .slice(start, trapEnd + "\nfi".length)
    .replace(
      '[[ "$CLEANUP_FIXTURE" == /usr/local/libexec/nemoclaw/* ]]',
      `[[ "$CLEANUP_FIXTURE" == ${shellQuote(cleanupRoot)}/* ]]`,
    );
  return [
    "sudo() {",
    '  if [[ "${1:-}" == "-n" ]]; then shift; fi',
    '  if [[ "${1:-}" == "stat" ]]; then printf \'0:0:555\\n\'; return; fi',
    '  "$@"',
    "}",
    trapBoundary,
    'exit "$SETUP_FAILURE_STATUS"',
  ].join("\n");
}

async function runInterruptedSetupFixture(ownerContext: ProcessOwner, cleanupExitStatus: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-setup-trap-"));
  const cleanupRoot = path.join(root, "cleanup");
  const runnerTemp = path.join(root, "runner-temp");
  const cleanupFixture = path.join(cleanupRoot, "restore");
  const cleanupCount = path.join(runnerTemp, "cleanup-count");
  const dockerState = path.join(runnerTemp, "docker-state");
  fs.mkdirSync(cleanupRoot, { recursive: true });
  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.writeFileSync(dockerState, "isolated\n");
  writeExecutable(
    cleanupFixture,
    `#!/bin/bash
set -euo pipefail
count=0
[[ ! -f "$RUNNER_TEMP/cleanup-count" ]] || count="$(cat "$RUNNER_TEMP/cleanup-count")"
printf '%s\n' "$((count + 1))" >"$RUNNER_TEMP/cleanup-count"
printf 'restored\n' >"$RUNNER_TEMP/docker-state"
exit ${String(cleanupExitStatus)}
`,
  );
  const result = await runCommand(
    ownerContext,
    "bash",
    ["--noprofile", "--norc", "-c", interruptedSetupHarness(cleanupRoot)],
    {
      ...process.env,
      CLEANUP_FIXTURE: cleanupFixture,
      RUNNER_TEMP: runnerTemp,
      SETUP_FAILURE_STATUS: "42",
    },
  );
  return { cleanupCount, dockerState, result, root };
}

type RestoreFixtureKind = "valid" | "regular-file" | "symlink";

type CommandResult = {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
};

type ProcessOwner = Pick<TestContext, "signal" | "onTestFinished">;

type OutputCapture = {
  text: string;
  truncated: boolean;
};

function appendOutput(capture: OutputCapture, chunk: string): void {
  const next = capture.truncated ? capture.text : capture.text + chunk;
  const newlyTruncated =
    !capture.truncated && Buffer.byteLength(next, "utf8") > COMMAND_OUTPUT_LIMIT;
  capture.text = capture.truncated
    ? capture.text
    : newlyTruncated
      ? `${new StringDecoder("utf8").write(
          Buffer.from(next).subarray(
            0,
            COMMAND_OUTPUT_LIMIT - Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8"),
          ),
        )}${OUTPUT_TRUNCATION_MARKER}`
      : next;
  capture.truncated ||= newlyTruncated;
}

async function runCommand(
  ownerContext: ProcessOwner,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 15_000,
): Promise<CommandResult> {
  ownerContext.signal.throwIfAborted();
  const stdout: OutputCapture = { text: "", truncated: false };
  const stderr: OutputCapture = { text: "", truncated: false };
  const child = spawn(command, [...args], { detached: true, env });
  const finishController = new AbortController();
  const abort = addAbortListener(ownerContext.signal, () => finishController.abort());
  const supervision = superviseChild(child, {
    killGraceMs: 0,
    onStderr: (chunk) => {
      appendOutput(stderr, chunk);
    },
    onStdout: (chunk) => {
      appendOutput(stdout, chunk);
    },
    signal: finishController.signal,
    timeoutMs,
  });
  ownerContext.onTestFinished(async () => {
    finishController.abort();
    await supervision;
  });

  try {
    const result = await supervision;
    const cleanupDiagnostic = result.cleanupError ? `${result.cleanupError.message}\n` : "";
    const stderrContent = stderr.truncated
      ? stderr.text.slice(0, -OUTPUT_TRUNCATION_MARKER.length)
      : stderr.text;
    const stderrNeedsTruncation =
      result.cleanupError !== undefined &&
      (stderr.truncated ||
        Buffer.byteLength(stderrContent + cleanupDiagnostic, "utf8") > COMMAND_OUTPUT_LIMIT);
    const stderrPrefixBudget = Math.max(
      0,
      COMMAND_OUTPUT_LIMIT -
        Buffer.byteLength(cleanupDiagnostic, "utf8") -
        Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8"),
    );
    const boundedStderrPrefix = new StringDecoder("utf8").write(
      Buffer.from(stderrContent).subarray(0, stderrPrefixBudget),
    );
    return {
      status: result.cleanupError ? -1 : result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stdout: stdout.text,
      stderr: result.cleanupError
        ? stderrNeedsTruncation
          ? `${boundedStderrPrefix}${cleanupDiagnostic}${OUTPUT_TRUNCATION_MARKER}`
          : `${stderrContent}${cleanupDiagnostic}`
        : stderr.text,
    };
  } finally {
    abort[Symbol.dispose]();
  }
}

async function runRestoreFixture(
  ownerContext: ProcessOwner,
  kind: RestoreFixtureKind,
  serviceActiveState = "active",
  socketActiveState = "active",
  loadState = "loaded",
  unitFileState = "enabled",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-restore-"));
  const restoreRoot = path.join(root, "authority");
  const destination = path.join(root, "bin", "docker");
  const disabled = path.join(restoreRoot, "docker");
  fs.mkdirSync(restoreRoot, { mode: 0o700 });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const original = "#!/bin/sh\nexit 0\n";
  const expectedSha256 = createHash("sha256").update(original).digest("hex");
  fs.writeFileSync(path.join(restoreRoot, "metadata"), `${destination}\n${expectedSha256}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(
    path.join(restoreRoot, "runtime.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      dockerService: {
        loadState,
        activeState: serviceActiveState,
        unitFileState,
      },
      dockerSocket: {
        loadState,
        activeState: socketActiveState,
        unitFileState,
      },
    })}\n`,
    { mode: 0o600 },
  );
  const prepareSource = {
    valid: () => fs.writeFileSync(disabled, original, { mode: 0o755 }),
    "regular-file": () => fs.writeFileSync(disabled, "#!/bin/sh\necho tampered\n", { mode: 0o755 }),
    symlink: () => {
      const malicious = path.join(root, "malicious-docker");
      fs.writeFileSync(malicious, original, { mode: 0o755 });
      fs.symlinkSync(malicious, disabled);
    },
  } satisfies Record<RestoreFixtureKind, () => void>;
  prepareSource[kind]();
  const serviceState = path.join(root, "docker-service.state");
  const socketState = path.join(root, "docker-socket.state");
  const systemctlLog = path.join(root, "systemctl.log");
  fs.writeFileSync(serviceState, "inactive\n");
  fs.writeFileSync(socketState, "inactive\n");

  const commandShims = [
    "sudo() {",
    '  if [[ "${1:-}" == "-n" ]]; then shift; fi',
    '  "$@"',
    "}",
    "stat() {",
    '  case "${2:-}" in',
    "    %u:%g:%a) [[ \"${3:-}\" == *runtime.json ]] && printf '0:0:600\\n' || printf '0:0:700\\n' ;;",
    "    %u:%g) printf '0:0\\n' ;;",
    "    *) return 64 ;;",
    "  esac",
    "}",
    "sha256sum() {",
    '  if [[ "${1:-}" == "--" ]]; then shift; fi',
    `  "$NODE_BINARY" -e 'const fs=require("fs"),c=require("crypto"),p=process.argv[1];process.stdout.write(c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")+"  "+p+"\\\\n")' "$1"`,
    "}",
    "find() {",
    '  local target=""',
    '  for value in "$@"; do [[ "$value" == /* ]] && target="$value" && break; done',
    '  [[ -n "$target" ]]',
    `  "$NODE_BINARY" -e 'const fs=require("fs"),p=process.argv[1];for(const name of fs.readdirSync(p).sort())process.stdout.write(name+"\\n")' "$target"`,
    "}",
    "systemctl() {",
    '  printf \'%s\\n\' "$*" >>"$SYSTEMCTL_LOG"',
    '  local operation="${1:-}"',
    "  shift || true",
    '  local unit="${*: -1}"',
    '  local state_file="$DOCKER_SERVICE_STATE"',
    '  [[ "$unit" == "docker.socket" ]] && state_file="$DOCKER_SOCKET_STATE"',
    '  case "$operation" in',
    "    show) printf '%s\\n' \"$DOCKER_LOAD_STATE\" ;;",
    '    is-active) cat "$state_file"; [[ "$(cat "$state_file")" == "active" ]] ;;',
    '    is-enabled) [[ "$DOCKER_UNIT_FILE_STATE" == "not-found" ]] && return 1; printf \'%s\\n\' "$DOCKER_UNIT_FILE_STATE" ;;',
    "    unmask) return 0 ;;",
    "    start) printf 'active\\n' >\"$state_file\" ;;",
    "    stop) printf 'inactive\\n' >\"$state_file\" ;;",
    "    *) return 64 ;;",
    "  esac",
    "}",
  ].join("\n");
  const script = restoreRunScript()
    .replace(`restore_root=${FIXED_RESTORE_ROOT}`, `restore_root=${shellQuote(restoreRoot)}`)
    .replace(
      "/usr/bin/docker | /usr/local/bin/docker | /snap/bin/docker) ;;",
      `${destination}) ;;`,
    );
  const result = await runCommand(
    ownerContext,
    "bash",
    ["--noprofile", "--norc", "-c", `${commandShims}\n${script}`],
    {
      ...process.env,
      NODE_BINARY: process.execPath,
      DOCKER_SERVICE_STATE: serviceState,
      DOCKER_SOCKET_STATE: socketState,
      DOCKER_LOAD_STATE: loadState,
      DOCKER_UNIT_FILE_STATE: unitFileState,
      PATH: `${path.dirname(destination)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      SYSTEMCTL_LOG: systemctlLog,
    },
  );
  return {
    destination,
    expectedSha256,
    restoreRoot,
    result,
    root,
    serviceState,
    socketState,
    systemctlLog,
  };
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o700 });
}

async function runPodmanCleanupFixture(
  ownerContext: ProcessOwner,
  withDockerState: boolean,
  podmanStopFails = false,
  withUnrelatedServiceUnit = false,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-cleanup-"));
  const runnerTemp = path.join(root, "runner-temp");
  const home = path.join(root, "home");
  const fakeBin = path.join(root, "fake-bin");
  const toolchainRoot = path.join(root, "toolchain");
  const helperRoot = path.join(root, "helpers");
  const runtimeDirectory = path.join(root, "runtime");
  const serviceUnitDirectory = path.join(home, ".config", "systemd", "user");
  const storageDirectory = path.join(runnerTemp, "native-podman-e2e-storage");
  const restoreRoot = path.join(toolchainRoot, "docker-cli-restore");
  const destination = path.join(root, "docker-bin", "docker");
  const systemctlLog = path.join(root, "systemctl.log");
  const podmanServiceState = path.join(root, "podman-service.state");
  const loopbackState = path.join(root, "loopback-present");
  const uid = process.getuid?.() ?? 0;
  fs.mkdirSync(runnerTemp, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.join(toolchainRoot, "bin"), { recursive: true });
  fs.mkdirSync(helperRoot, { recursive: true });
  fs.mkdirSync(path.join(runtimeDirectory, "podman"), { recursive: true });
  fs.mkdirSync(serviceUnitDirectory, { recursive: true });
  fs.mkdirSync(path.join(storageDirectory, "runroot"), { recursive: true });
  fs.mkdirSync(path.join(storageDirectory, "graphroot"), { recursive: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.mkdirSync(path.join(runnerTemp, "native-podman-e2e-toolchain"), { recursive: true });
  fs.writeFileSync(path.join(toolchainRoot, "bin", "podman"), "owned\n");
  fs.writeFileSync(path.join(toolchainRoot, "bin", "pasta"), "owned\n");
  fs.writeFileSync(path.join(toolchainRoot, "podman.apparmor"), "owned\n");
  fs.writeFileSync(path.join(toolchainRoot, "pasta.apparmor"), "owned\n");
  fs.writeFileSync(path.join(helperRoot, "aardvark-dns"), "owned\n");
  fs.writeFileSync(path.join(helperRoot, "netavark"), "owned\n");
  fs.writeFileSync(path.join(helperRoot, "rootlessport"), "owned\n");
  fs.writeFileSync(
    path.join(serviceUnitDirectory, "nemoclaw-native-podman-e2e.service"),
    "owned\n",
  );
  fs.writeFileSync(path.join(serviceUnitDirectory, "nemoclaw-native-podman-e2e.socket"), "owned\n");
  new Map<boolean, () => void>([
    [
      true,
      () => fs.writeFileSync(path.join(serviceUnitDirectory, "unrelated.service"), "unowned\n"),
    ],
    [false, () => undefined],
  ]).get(withUnrelatedServiceUnit)!();
  fs.writeFileSync(path.join(runnerTemp, "native-podman-e2e-service.env"), "owned\n");
  fs.writeFileSync(path.join(runnerTemp, "native-podman-e2e-storage.conf"), "owned\n");
  fs.writeFileSync(path.join(runnerTemp, "native-podman-e2e-containers.conf"), "owned\n");
  fs.writeFileSync(path.join(runnerTemp, "native-podman-e2e-info.json"), "owned\n");
  fs.writeFileSync(loopbackState, "present\n");
  fs.writeFileSync(podmanServiceState, "active\n");
  fs.writeFileSync(
    path.join(toolchainRoot, "cleanup.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      uid,
      userRuntimeActive: "active",
      userManagerActive: "active",
      dbusActive: "active",
      podmanDirectoryPreexisting: false,
      serviceUnitDirectoryPreexisting: false,
      helperDirectoryPreexisting: false,
      loopbackAddressAdded: true,
      subuidRange: null,
      subgidRange: null,
    })}\n`,
    { mode: 0o600 },
  );
  const dockerBytes = "#!/bin/sh\nexit 0\n";
  const expectedSha256 = createHash("sha256").update(dockerBytes).digest("hex");
  const prepareDockerState = () => {
    fs.mkdirSync(restoreRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(restoreRoot, "docker"), dockerBytes, { mode: 0o755 });
    fs.writeFileSync(path.join(restoreRoot, "metadata"), `${destination}\n${expectedSha256}\n`);
    fs.writeFileSync(
      path.join(restoreRoot, "runtime.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        dockerService: { loadState: "loaded", activeState: "active", unitFileState: "enabled" },
        dockerSocket: { loadState: "loaded", activeState: "active", unitFileState: "enabled" },
      })}\n`,
    );
  };
  new Map<boolean, () => void>([
    [true, prepareDockerState],
    [false, () => undefined],
  ]).get(withDockerState)!();
  writeExecutable(
    path.join(fakeBin, "systemctl"),
    `#!/bin/sh
printf '%s\\n' "$*" >>"$SYSTEMCTL_LOG"
case "$*" in
  'is-active user@${String(uid)}.service') printf 'active\\n' ;;
  '--user stop nemoclaw-native-podman-e2e.socket nemoclaw-native-podman-e2e.service')
    if [ "$PODMAN_STOP_FAILS" = true ]; then exit 1; fi
    printf 'inactive\\n' >"$PODMAN_SERVICE_STATE"
    ;;
  '--user is-active nemoclaw-native-podman-e2e.socket'|'--user is-active nemoclaw-native-podman-e2e.service')
    cat "$PODMAN_SERVICE_STATE"
    [ "$(cat "$PODMAN_SERVICE_STATE")" = active ]
    ;;
  *is-active*) printf 'active\\n' ;;
  *is-enabled*) printf 'enabled\\n' ;;
  *show*) printf 'loaded\\n' ;;
esac
exit 0
`,
  );
  writeExecutable(path.join(fakeBin, "apparmor_parser"), "#!/bin/sh\nexit 0\n");
  writeExecutable(
    path.join(fakeBin, "ip"),
    `#!/bin/sh
case "$*" in
  '-o -4 address show dev lo')
    if [ -e "$LOOPBACK_STATE" ]; then printf '1: lo inet 169.254.2.2/32 scope global lo\\n'; fi
    ;;
  'address del 169.254.2.2/32 dev lo') rm -f "$LOOPBACK_STATE" ;;
esac
`,
  );
  const commandShims = [
    "sudo() {",
    '  if [[ "${1:-}" == "-n" ]]; then shift; fi',
    '  "$@"',
    "}",
    "stat() {",
    '  case "${2:-}" in',
    `    %u:%g:%a) case "\${3:-}" in ${toolchainRoot}/cleanup.json|${restoreRoot}/runtime.json) printf '0:0:600\\n' ;; ${restoreRoot}) printf '0:0:700\\n' ;; *) printf '0:0:755\\n' ;; esac ;;`,
    "    %u:%g) printf '0:0\\n' ;;",
    `    %u) case "\${3:-}" in ${toolchainRoot}/*|${helperRoot}/*) printf '0\\n' ;; *) printf '${String(uid)}\\n' ;; esac ;;`,
    "    *) return 64 ;;",
    "  esac",
    "}",
    "sha256sum() {",
    '  if [[ "${1:-}" == "--" ]]; then shift; fi',
    `  "$NODE_BINARY" -e 'const fs=require("fs"),c=require("crypto"),p=process.argv[1];process.stdout.write(c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")+"  "+p+"\\n")' "$1"`,
    "}",
    "find() {",
    '  local target=""',
    '  for value in "$@"; do [[ "$value" == /* ]] && target="$value" && break; done',
    '  [[ -n "$target" ]]',
    `  "$NODE_BINARY" -e 'const fs=require("fs"),p=process.argv[1];for(const name of fs.readdirSync(p).sort())process.stdout.write(name+"\\n")' "$target"`,
    "}",
    "rm() {",
    "  local filtered=()",
    '  for value in "$@"; do [[ "$value" == "--one-file-system" ]] || filtered+=("$value"); done',
    '  command rm "${filtered[@]}"',
    "}",
  ].join("\n");
  const script = restoreRunScript()
    .replace(`restore_root=${FIXED_RESTORE_ROOT}`, `restore_root=${shellQuote(restoreRoot)}`)
    .replace(
      "toolchain_install_root=/usr/lib/nemoclaw-native-podman-e2e",
      `toolchain_install_root=${shellQuote(toolchainRoot)}`,
    )
    .replace(
      "helper_install_root=/usr/local/libexec/podman",
      `helper_install_root=${shellQuote(helperRoot)}`,
    )
    .replace(
      'runtime_directory="/run/user/$uid"',
      `runtime_directory=${shellQuote(runtimeDirectory)}`,
    )
    .replaceAll("/usr/bin/systemctl", "systemctl")
    .replace(
      "/usr/bin/docker | /usr/local/bin/docker | /snap/bin/docker) ;;",
      `${destination}) ;;`,
    );
  const result = await runCommand(
    ownerContext,
    "bash",
    ["--noprofile", "--norc", "-c", `${commandShims}\n${script}`],
    {
      ...process.env,
      HOME: home,
      LOOPBACK_STATE: loopbackState,
      NODE_BINARY: process.execPath,
      PATH: `${fakeBin}:${path.dirname(destination)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      PODMAN_SERVICE_STATE: podmanServiceState,
      PODMAN_STOP_FAILS: podmanStopFails ? "true" : "false",
      RUNNER_TEMP: runnerTemp,
      SYSTEMCTL_LOG: systemctlLog,
    },
  );
  return {
    destination,
    expectedSha256,
    helperRoot,
    loopbackState,
    podmanServiceState,
    result,
    root,
    runnerTemp,
    runtimeDirectory,
    restoreRoot,
    serviceUnitDirectory,
    storageDirectory,
    systemctlLog,
    toolchainRoot,
    withDockerState,
  };
}

describe("native Podman E2E setup boundary", () => {
  // source-shape-contract: security -- Candidate code may consume only a trusted-main-built Podman 5.7 artifact on the reviewed GPU lane
  it("builds the Portable Podman toolchain outside candidate execution", () => {
    const toolchain = e2eWorkflowJobs()["portable-podman-toolchain"]!;
    const checkout = toolchain.steps?.find(
      (step) => step.name === "Check out the pinned Podman 5.7 source",
    );
    const dependencyInstall = toolchain.steps?.find(
      (step) =>
        step.name === "Install pinned Podman build dependencies from the signed Ubuntu snapshot",
    );
    const replace = toolchain.steps?.find(
      (step) => step.name === "Replace only Podman with the pinned portable runtime",
    );
    const upload = toolchain.steps?.find(
      (step) => step.name === "Upload the pinned Portable Podman toolchain",
    );

    expect(toolchain.needs).toBe("generate-matrix");
    expect(toolchain.if).toBe(
      "${{ contains(fromJSON(needs.generate-matrix.outputs.selected_jobs), 'portable-hermes-finalization') }}",
    );
    expect(toolchain["runs-on"]).toBe("ubuntu-24.04");
    expect(checkout?.with).toMatchObject({
      repository: "podman-container-tools/podman",
      ref: "0370128fc8dcae93533334324ef838db8f8da8cb",
      path: ".podman-source",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    expect(dependencyInstall?.env).toEqual({
      UBUNTU_SNAPSHOT_ID: "20260911T000000Z",
    });
    expect(dependencyInstall?.run).toContain(
      "URIs: https://snapshot.ubuntu.com/ubuntu/$UBUNTU_SNAPSHOT_ID",
    );
    expect(dependencyInstall?.run).toContain('-o "Dir::Etc::sourcelist=$snapshot_sources"');
    expect(dependencyInstall?.run).toContain("Dir::Etc::sourceparts=-");
    expect(dependencyInstall?.run).toContain("Pin: origin snapshot.ubuntu.com");
    expect(dependencyInstall?.run).toContain("Pin-Priority: 1001");
    expect(dependencyInstall?.run).toContain('-o "Dir::Etc::preferences=$snapshot_preferences"');
    expect(dependencyInstall?.run).toContain("Dir::Etc::preferencesparts=-");
    expect(dependencyInstall?.run).toContain('-o "Dir::State::lists=$snapshot_lists"');
    expect(dependencyInstall?.run).toContain("APT::Get::AllowUnauthenticated=false");
    expect(dependencyInstall?.run).toContain("Acquire::AllowInsecureRepositories=false");
    expect(dependencyInstall?.run).toContain("--allow-downgrades");
    expect(dependencyInstall?.run).toContain(
      [
        '  "gcc=4:13.2.0-7ubuntu1"',
        '  "git=1:2.43.0-1ubuntu7.3"',
        '  "libapparmor-dev=4.0.1really4.0.1-0ubuntu0.24.04.7"',
        '  "libbtrfs-dev=6.6.3-1.1build2"',
        '  "libc6-dev=2.39-0ubuntu8.9"',
        '  "libdevmapper-dev=2:1.02.185-3ubuntu3.2"',
        '  "libglib2.0-dev=2.80.0-6ubuntu3.8"',
        '  "libprotobuf-c-dev=1.4.1-1ubuntu4"',
        '  "libprotobuf-dev=3.21.12-8.2ubuntu0.3"',
        '  "libseccomp-dev=2.5.5-1ubuntu3.1"',
        '  "libselinux1-dev=3.5-2ubuntu2.1"',
        '  "libsqlite3-dev=3.45.1-1ubuntu2.7"',
        '  "libsystemd-dev=255.4-1ubuntu8.17"',
        '  "make=4.3-4.1build2"',
        '  "pkg-config=1.8.1-2build1"',
        '  "protobuf-compiler=3.21.12-8.2ubuntu0.3"',
      ].join("\n"),
    );
    expect(dependencyInstall?.run).toContain("dpkg-query --show --showformat='${Version}'");
    expect(dependencyInstall?.run).toContain('[[ "$actual_version" == "$expected_version" ]]');
    expect(replace?.run).toContain("sha256sum --check --strict SHA256SUMS");
    expect(replace?.run).toContain('"podman version 5.7.0"');
    expect(replace?.run).toContain('.podmanVersion = "5.7.0"');
    expect(upload?.with).toEqual({
      name: "portable-podman-e2e-toolchain-amd64",
      path: "${{ runner.temp }}/portable-podman-e2e-toolchain/",
      "if-no-files-found": "error",
      "retention-days": 3,
      "compression-level": 0,
    });
  });

  // source-shape-contract: security -- The explicit selector must retain the reviewed GPU, runtime, candidate, and cleanup boundaries
  it("runs Portable Hermes only on the explicit Podman 5.7 GPU lane", () => {
    const setupAction = YAML.parse(fs.readFileSync(SETUP_ACTION, "utf8")) as {
      inputs: Record<string, { default?: string }>;
      runs: { steps: WorkflowStep[] };
    };
    const setupRuntime = setupAction.runs.steps.find(
      (step) => step.name === "Start native Podman runtime",
    );
    const dockerCliIsolation = setupAction.runs.steps.find(
      (step) => step.name === "Remove Docker CLI from native Podman execution",
    );
    const liveSource = fs.readFileSync(
      "test/e2e/live/portable-profile-rootless-linux.test.ts",
      "utf8",
    );
    const job = e2eWorkflowJobs()["portable-hermes-finalization"]!;
    const trustedCheckout = job.steps?.find(
      (step) => step.name === "Check out trusted workflow cleanup authority",
    );
    const fixtureInstall = job.steps?.find(
      (step) => step.name === "Install immutable native Podman cleanup fixture",
    );
    const candidateCheckout = job.steps?.find(
      (step) => step.name === "Check out the exact candidate",
    );
    const setup = job.steps?.find((step) => step.name === "Prepare Portable Podman 5.7 runtime");
    const live = job.steps?.find(
      (step) => step.name === "Run Portable Hermes finalization live Vitest test",
    );
    const fixtureRemoval = job.steps?.find(
      (step) => step.name === "Remove immutable native Podman cleanup fixture",
    );
    const trustedCheckoutIndex = job.steps?.indexOf(trustedCheckout!) ?? -1;
    const candidateCheckoutIndex = job.steps?.indexOf(candidateCheckout!) ?? -1;
    const setupIndex = job.steps?.indexOf(setup!) ?? -1;
    const uploadIndex =
      job.steps?.findIndex(
        (step) => step.name === "Upload Portable Hermes finalization artifacts",
      ) ?? -1;
    const restoreIndex =
      job.steps?.findIndex(
        (step) => step.name === "Restore Docker and retire Portable Podman runtime",
      ) ?? -1;
    const fixtureRemovalIndex = job.steps?.indexOf(fixtureRemoval!) ?? -1;

    expect(job.needs).toEqual(["generate-matrix", "portable-podman-toolchain"]);
    expect(job["runs-on"]).toBe("linux-amd64-gpu-rtxpro6000-latest-1");
    expect(job.env).toMatchObject({
      E2E_DEFAULT_ENABLED: "0",
      E2E_GATEWAY_RUNTIMES: "podman",
      E2E_TARGET_ID: "portable-hermes-finalization",
      E2E_AGENT_RUNTIME: "hermes",
    });
    expect(job.env).not.toHaveProperty("E2E_HERMES_BASE_STORAGE_HOME");
    expect(setupAction.inputs["cleanup-fixture"]?.default).toBe("");
    expect(setupAction.inputs["isolate-docker-cli"]?.default).toBe("true");
    expect(dockerCliIsolation?.if).toBe(
      "${{ inputs.enabled == 'true' && inputs.isolate-docker-cli == 'true' }}",
    );
    expect(setupRuntime?.env).toMatchObject({
      CLEANUP_FIXTURE: "${{ inputs.cleanup-fixture }}",
    });
    expect(setupRuntime?.run).toContain("trap cleanup_interrupted_setup EXIT");
    expect(setupRuntime?.run).toContain("trap 'exit 130' INT");
    expect(setupRuntime?.run).toContain("trap 'exit 143' TERM");
    expect(setupRuntime?.run).toContain('== "0:0:555"');
    expect(setupRuntime?.run).toContain("setup_completed=true");
    expect(setupRuntime?.run).toContain("trap - EXIT INT TERM");
    expect(trustedCheckout?.with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    expect(fixtureInstall?.env).toMatchObject({
      TRUSTED_FIXTURE_SHA256: "f9b26c07e5b84660a0f2710307cefc9c0c811d3d88628bb0a9500e031ec02ba8",
    });
    expect(createHash("sha256").update(restoreRunScript()).digest("hex")).toBe(
      "f9b26c07e5b84660a0f2710307cefc9c0c811d3d88628bb0a9500e031ec02ba8",
    );
    expect(fixtureInstall?.run).toContain("sha256sum --check --strict");
    expect(fixtureInstall?.run).toContain("--owner=root --group=root --mode=0555");
    expect(setup?.with).toEqual({
      "cleanup-fixture":
        "/usr/local/libexec/nemoclaw/native-podman-e2e-restore.${{ github.run_id }}.${{ github.run_attempt }}",
      enabled: "true",
      toolchain: "portable-5.7",
      "isolate-docker-cli": "false",
    });
    expect(setup?.uses).toBe(
      "NVIDIA/NemoClaw/.github/actions/setup-native-podman-e2e@22789bcaf835db7cf6390781c8d0f454f1e73dec",
    );
    expect(live).toMatchObject({
      env: {
        E2E_HERMES_BASE_STORAGE_HOME: "${{ runner.temp }}/nemoclaw-hermes-base-storage",
      },
    });
    expect(live?.run).toContain("trap restore_runner EXIT");
    expect(live?.run).toContain("trap 'exit 130' INT");
    expect(live?.run).toContain("trap 'exit 143' TERM");
    expect(live?.run).toContain('[[ "$(uname -m)" == x86_64 ]]');
    expect(live?.run).toContain("nvidia-smi --query-gpu=name");
    expect(live?.run).toContain("podman build");
    expect(
      liveSource.indexOf(
        "assert.equal(process.env.DOCKER_HOST, `unix://${runtimeDir}/podman/podman.sock`)",
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(liveSource.indexOf('run("docker", ["version"])')).toBeGreaterThan(
      liveSource.indexOf(
        "assert.equal(process.env.DOCKER_HOST, `unix://${runtimeDir}/podman/podman.sock`)",
      ),
    );
    expect(live?.run).toMatch(
      /live-vitest-invocation\.mts run \\\n\s+--test-path test\/e2e\/live\/portable-profile-rootless-linux\.test\.ts/u,
    );
    expect(trustedCheckoutIndex).toBeGreaterThanOrEqual(0);
    expect(candidateCheckoutIndex).toBeGreaterThan(trustedCheckoutIndex);
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBeGreaterThan(setupIndex);
    expect(restoreIndex).toBeGreaterThan(uploadIndex);
    expect(fixtureRemovalIndex).toBeGreaterThan(restoreIndex);
    expect(JSON.stringify(job)).not.toContain("NVIDIA_API_KEY");
    expect(JSON.stringify(job)).not.toContain("NVIDIA_INFERENCE_API_KEY");
  });

  it.concurrent("runs interrupted setup cleanup once and preserves the authoritative failure status", async (context) => {
    const restored = await runInterruptedSetupFixture(context, 0);
    const restoreFailed = await runInterruptedSetupFixture(context, 73);

    try {
      expect(restored.result.status, restored.result.stderr).toBe(42);
      expect(fs.readFileSync(restored.cleanupCount, "utf8").trim()).toBe("1");
      expect(fs.readFileSync(restored.dockerState, "utf8").trim()).toBe("restored");
      expect(restoreFailed.result.status).toBe(73);
      expect(restoreFailed.result.stderr).toContain(
        "Native Podman setup failed and runner restoration also failed",
      );
      expect(fs.readFileSync(restoreFailed.cleanupCount, "utf8").trim()).toBe("1");
      expect(fs.readFileSync(restoreFailed.dockerState, "utf8").trim()).toBe("restored");
    } finally {
      fs.rmSync(restored.root, { force: true, recursive: true });
      fs.rmSync(restoreFailed.root, { force: true, recursive: true });
    }
  });

  it("provides Podman authority without impersonating Docker", () => {
    expect(validateNativePodmanSetupAction()).toEqual([]);
  });

  it("restores Docker state only from the immutable root-owned authority (#11014)", () => {
    expect(validateNativePodmanRestoreAction()).toEqual([]);
  });

  it("rejects Docker isolation before runtime recovery state is recorded (#11014)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-setup-mutation-"));
    const mutatedAction = path.join(root, "action.yaml");
    const source = fs
      .readFileSync(SETUP_ACTION, "utf8")
      .replace(
        '        docker_service_state="$(capture_unit_state docker.service)"',
        '        systemctl stop docker.service docker.socket\n        docker_service_state="$(capture_unit_state docker.service)"',
      );
    fs.writeFileSync(mutatedAction, source);

    try {
      expect(validateNativePodmanSetupAction(mutatedAction)).toContain(
        "native Podman setup must make Docker unavailable before qualification",
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects mutable privileged dependency acquisition for native Podman (#11014)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-setup-dependencies-"));
    const mutatedAction = path.join(root, "action.yaml");
    const source = fs
      .readFileSync(SETUP_ACTION, "utf8")
      .replace(
        "        required_host_commands=(\n",
        "        sudo apt-get update\n        sudo apt-get install --yes conmon\n        required_host_commands=(\n",
      );
    fs.writeFileSync(mutatedAction, source);

    try {
      expect(validateNativePodmanSetupAction(mutatedAction)).toContain(
        "native Podman setup must use trusted preinstalled host dependencies without mutable privileged acquisition",
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects restore logic that omits Docker service recovery (#11014)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-restore-mutation-"));
    const mutatedAction = path.join(root, "action.yaml");
    const source = fs
      .readFileSync(RESTORE_ACTION, "utf8")
      .replace("        apply_unit_activity docker.service dockerService\n", "");
    fs.writeFileSync(mutatedAction, source);

    try {
      expect(validateNativePodmanRestoreAction(mutatedAction)).toContain(
        "native Podman restore action must verify and restore its root-owned Docker runtime state",
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects restore logic that never invokes native Podman cleanup (#11014)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-cleanup-invocation-"));
    const mutatedAction = path.join(root, "action.yaml");
    const source = fs
      .readFileSync(RESTORE_ACTION, "utf8")
      .replace("        (set -e; cleanup_native_podman_runtime)\n", "");
    fs.writeFileSync(mutatedAction, source);

    try {
      expect(validateNativePodmanRestoreAction(mutatedAction)).toContain(
        "native Podman restore action must remove recorded runner resources before restoring Docker",
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.concurrent("reports signal termination without an exit status", async (context) => {
    const result = await runCommand(
      context,
      "bash",
      ["--noprofile", "--norc", "-c", "kill -TERM $$"],
      process.env,
    );

    expect(result.status).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(false);
  });

  it.concurrent("does not report a timeout after a normal exit", async (context) => {
    const result = await runCommand(context, process.execPath, ["-e", ""], process.env, 1_000);

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it.concurrent("terminates a timed-out subprocess group", async (context) => {
    const startedAt = Date.now();
    const result = await runCommand(
      context,
      "bash",
      ["--noprofile", "--norc", "-c", "sleep 30"],
      process.env,
      100,
    );

    expect(result.status).not.toBe(0);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.concurrent("reports external cancellation separately from timeout", async (context) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-cancel-"));
    const readyFile = path.join(root, "ready");
    const controller = new AbortController();
    const ownerContext: ProcessOwner = {
      onTestFinished: (cleanup, timeout) => context.onTestFinished(cleanup, timeout),
      signal: controller.signal,
    };

    try {
      const resultPromise = runCommand(
        ownerContext,
        process.execPath,
        [
          "-e",
          'const fs = require("node:fs"); process.on("SIGTERM", () => {}); fs.writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1_000);',
          readyFile,
        ],
        process.env,
        2_000,
      );
      await vi.waitFor(() => expect(fs.existsSync(readyFile)).toBe(true));
      controller.abort();
      const result = await resultPromise;

      expect(result.status).toBeNull();
      expect(result.signal).toBe("SIGKILL");
      expect(result.timedOut).toBe(false);
    } finally {
      controller.abort();
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.concurrent("bounds captured subprocess output", async (context) => {
    const result = await runCommand(
      context,
      process.execPath,
      [
        "-e",
        `process.stdout.write("€".repeat(${Math.ceil(COMMAND_OUTPUT_LIMIT / 3) + 1_024})); process.stderr.write("€".repeat(${Math.ceil(COMMAND_OUTPUT_LIMIT / 3) + 1_024})); setTimeout(() => process.stdout.write("later output"), 25);`,
      ],
      process.env,
    );

    expect(result.status).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(COMMAND_OUTPUT_LIMIT);
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(COMMAND_OUTPUT_LIMIT);
    expect(result.stdout.endsWith(OUTPUT_TRUNCATION_MARKER)).toBe(true);
    expect(result.stderr.endsWith(OUTPUT_TRUNCATION_MARKER)).toBe(true);
    expect(result.stdout.startsWith("€")).toBe(true);
    expect(result.stdout).not.toContain("later output");
    expect(result.stdout.match(/\[output truncated\]/gu)).toHaveLength(1);
    expect(result.stdout).not.toContain("�");
    expect(result.stderr).not.toContain("�");
  });

  it.concurrent("keeps the output truncation marker stable across later chunks", () => {
    const capture: OutputCapture = { text: "", truncated: false };
    appendOutput(capture, "€".repeat(Math.ceil(COMMAND_OUTPUT_LIMIT / 3) + 1));
    const truncated = capture.text;
    appendOutput(capture, "later output");

    expect(capture.text).toBe(truncated);
    expect(capture.text.endsWith(OUTPUT_TRUNCATION_MARKER)).toBe(true);
    expect(capture.text.match(/\[output truncated\]/gu)).toHaveLength(1);
  });

  it.concurrent("restores unchanged Docker runtime state and retires its authority (#11014)", async (context) => {
    const {
      destination,
      expectedSha256,
      restoreRoot,
      result,
      root,
      serviceState,
      socketState,
      systemctlLog,
    } = await runRestoreFixture(context, "valid");

    try {
      expect(result.status, result.stderr).toBe(0);
      expect(createHash("sha256").update(fs.readFileSync(destination)).digest("hex")).toBe(
        expectedSha256,
      );
      expect(
        (
          await runCommand(context, "bash", ["--noprofile", "--norc", "-c", "command -v docker"], {
            ...process.env,
            PATH: `${path.dirname(destination)}:/usr/bin:/bin`,
          })
        ).stdout.trim(),
      ).toBe(destination);
      expect(fs.existsSync(restoreRoot)).toBe(false);
      expect(fs.readFileSync(serviceState, "utf8").trim()).toBe("active");
      expect(fs.readFileSync(socketState, "utf8").trim()).toBe("active");
      expect(fs.readFileSync(systemctlLog, "utf8")).toContain("unmask --runtime docker.service");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.concurrent.for(["regular-file", "symlink"] as const)(
    "rejects a tampered %s restore source without modifying the Docker destination",
    async (kind, context) => {
      const { destination, result, root } = await runRestoreFixture(context, kind);

      try {
        expect(result.status).not.toBe(0);
        expect(fs.existsSync(destination)).toBe(false);
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it.concurrent("keeps Docker services inactive when they were inactive before isolation (#11014)", async (context) => {
    const fixture = await runRestoreFixture(context, "valid", "inactive", "inactive");

    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fs.readFileSync(fixture.serviceState, "utf8").trim()).toBe("inactive");
      expect(fs.readFileSync(fixture.socketState, "utf8").trim()).toBe("inactive");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it.concurrent("restores absent Docker units when is-enabled returns no text (#11014)", async (context) => {
    const fixture = await runRestoreFixture(
      context,
      "valid",
      "inactive",
      "inactive",
      "not-found",
      "not-found",
    );

    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fs.existsSync(fixture.destination)).toBe(true);
      expect(createHash("sha256").update(fs.readFileSync(fixture.destination)).digest("hex")).toBe(
        fixture.expectedSha256,
      );
      expect(fs.existsSync(fixture.restoreRoot)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it.concurrent.for([
    ["after complete setup", true],
    ["after setup fails before Docker-state capture", false],
  ] as const)(
    "removes native Podman runner resources %s (#11014)",
    async ([_label, withDockerState], context) => {
      const fixture = await runPodmanCleanupFixture(context, withDockerState);

      try {
        expect(fixture.result.status, fixture.result.stderr).toBe(0);
        expect(fs.existsSync(fixture.toolchainRoot)).toBe(false);
        expect(fs.existsSync(fixture.storageDirectory)).toBe(false);
        expect(fs.existsSync(fixture.serviceUnitDirectory)).toBe(false);
        expect(fs.existsSync(path.join(fixture.runtimeDirectory, "podman"))).toBe(false);
        expect(fs.existsSync(fixture.loopbackState)).toBe(false);
        expect(fs.existsSync(fixture.helperRoot)).toBe(false);
        expect(fs.existsSync(path.join(fixture.runnerTemp, "native-podman-e2e-toolchain"))).toBe(
          false,
        );
        expect(fs.existsSync(fixture.destination)).toBe(withDockerState);
        expect(
          withDockerState
            ? createHash("sha256").update(fs.readFileSync(fixture.destination)).digest("hex")
            : null,
        ).toBe(withDockerState ? fixture.expectedSha256 : null);
        expect(fs.readFileSync(fixture.systemctlLog, "utf8")).toContain(
          "--user stop nemoclaw-native-podman-e2e.socket nemoclaw-native-podman-e2e.service",
        );
      } finally {
        fs.rmSync(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it.concurrent("preserves unrelated user units while completing native Podman cleanup", async (context) => {
    const fixture = await runPodmanCleanupFixture(context, true, false, true);
    const unrelatedServiceUnit = path.join(fixture.serviceUnitDirectory, "unrelated.service");

    try {
      expect(fixture.result.status, fixture.result.stderr).toBe(0);
      expect(fs.readFileSync(unrelatedServiceUnit, "utf8")).toBe("unowned\n");
      expect(
        fs.existsSync(
          path.join(fixture.serviceUnitDirectory, "nemoclaw-native-podman-e2e.service"),
        ),
      ).toBe(false);
      expect(fs.existsSync(fixture.toolchainRoot)).toBe(false);
      expect(fs.existsSync(fixture.destination)).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it.concurrent("restores Docker and preserves Podman recovery authority when Podman cleanup fails (#11014)", async (context) => {
    const fixture = await runPodmanCleanupFixture(context, true, true);

    try {
      expect(fixture.result.status).not.toBe(0);
      expect(fixture.result.stderr).toContain(
        "systemctl --user status nemoclaw-native-podman-e2e.socket nemoclaw-native-podman-e2e.service",
      );
      expect(fs.existsSync(path.join(fixture.toolchainRoot, "cleanup.json"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.toolchainRoot, "bin", "podman"))).toBe(true);
      expect(fs.existsSync(fixture.storageDirectory)).toBe(true);
      expect(fs.existsSync(fixture.serviceUnitDirectory)).toBe(true);
      expect(fs.existsSync(fixture.destination)).toBe(true);
      expect(fs.existsSync(fixture.restoreRoot)).toBe(false);
      expect(createHash("sha256").update(fs.readFileSync(fixture.destination)).digest("hex")).toBe(
        fixture.expectedSha256,
      );
      const systemctlLog = fs.readFileSync(fixture.systemctlLog, "utf8");
      expect(systemctlLog).toContain("unmask --runtime docker.service");
      expect(systemctlLog).toContain("unmask --runtime docker.socket");
      expect(systemctlLog).toContain("start docker.service");
      expect(systemctlLog).toContain("start docker.socket");
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });

  it.concurrent("rejects a restore record that cannot prove the prior Docker service state (#11014)", async (context) => {
    const fixture = await runRestoreFixture(context, "valid", "activating");

    try {
      expect(fixture.result.status).not.toBe(0);
      expect(fs.existsSync(fixture.destination)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { force: true, recursive: true });
    }
  });
});
