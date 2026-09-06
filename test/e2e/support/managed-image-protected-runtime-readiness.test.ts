// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactSink } from "../fixtures/artifacts.ts";
import { HostCliClient } from "../fixtures/clients/host.ts";
import { startTestProgress, type TestProgress } from "../fixtures/progress.ts";
import { ShellProbe } from "../fixtures/shell-probe.ts";
import {
  PROTECTED_PROVIDER_KIND_LABEL,
  PROTECTED_PROVIDER_OWNER_LABEL,
  type ProtectedProviderContainerAuthority,
  protectedNimReadinessCommand,
  protectedOllamaReadinessCommand,
  protectedProviderContainerCleanupCommand,
  protectedProviderContainerName,
  protectedProviderContainerPreflightCommand,
  protectedProviderFinalInventoryCommand,
  protectedProviderReportedContainerId,
  protectedVllmReadinessCommand,
} from "../live/managed-image-protected-runtime-helpers.ts";

// Vitest hoists these module-scope mocks before the statically imported live-E2E command builders
// are evaluated, keeping their unavailable runtime dependencies outside this support-test boundary.
vi.mock("../../../src/lib/inference/nim.ts", () => ({
  adoptServedModelId: () => "",
  dockerLoginNgc: () => false,
  pullNimImage: () => undefined,
}));
vi.mock("../../../src/lib/inference/ollama/proxy.ts", () => ({
  getOllamaProxyToken: () => undefined,
  isProxyHealthy: () => false,
  killStaleProxy: () => undefined,
  persistAndProbeOllamaProxy: async () => undefined,
  startOllamaAuthProxy: () => false,
}));
vi.mock("../fixtures/e2e-test.ts", () => ({
  expect: () => {
    throw new Error("live E2E assertions are unavailable in this support test");
  },
}));
vi.mock("../live/gpu-e2e-helpers.ts", () => ({
  assertNvidiaAvailable: () => undefined,
  cleanupOllama: async () => undefined,
  ensureOllama: async () => undefined,
  env: () => ({}),
  REPO_ROOT: process.cwd(),
}));

interface ReadinessFixture {
  artifacts: ArtifactSink;
  binDir: string;
  env: NodeJS.ProcessEnv;
  host: HostCliClient;
  root: string;
}

const fixtureRoots: string[] = [];
const fixtureProgress: TestProgress[] = [];
const PROVIDER_COHORT = "protected-123-1";
const PROVIDER_CONTAINER_ID = "a".repeat(64);
const PROVIDER_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const PROVIDER_IMAGE = `registry.example/vllm@sha256:${"c".repeat(64)}`;
const VLLM_PROVIDER_NAME = protectedProviderContainerName("vllm", PROVIDER_COHORT);

afterEach(() => {
  for (const progress of fixtureProgress) progress.stop();
  fixtureProgress.length = 0;
  for (const root of fixtureRoots) fs.rmSync(root, { force: true, recursive: true });
  fixtureRoots.length = 0;
});

function createReadinessFixture(): ReadinessFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-protected-readiness-"));
  fixtureRoots.push(root);
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(home, ".bash_logout"), "exit 41\n", "utf8");
  writeCommand(binDir, "id", "printf '1000\\n'");
  writeCommand(binDir, "sudo", "exit 1");
  writeCommand(binDir, "systemctl", "exit 1");
  writeCommand(
    binDir,
    "setsid",
    `while [ "$#" -gt 0 ] && [ "$1" != "ollama" ]; do
  shift
done
exec "$@"`,
  );

  const artifacts = new ArtifactSink(path.join(root, "artifacts"));
  const progress = startTestProgress(
    "protected managed-image readiness support",
    ["run protected readiness command", "verify protected readiness result"],
    { logLine: () => undefined },
  );
  fixtureProgress.push(progress);
  const shellProbe = new ShellProbe({
    artifacts,
    progress,
    redact: (text) => text,
    signal: new AbortController().signal,
  });

  return {
    artifacts,
    binDir,
    env: {
      HOME: home,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    host: new HostCliClient(shellProbe),
    root,
  };
}

function writeCommand(binDir: string, name: string, body: string): void {
  const commandPath = path.join(binDir, name);
  fs.writeFileSync(commandPath, `#!/bin/sh\nset -eu\n${body}\n`, "utf8");
  fs.chmodSync(commandPath, 0o755);
}

function providerAuthority(): ProtectedProviderContainerAuthority {
  return {
    containerId: PROVIDER_CONTAINER_ID,
    imageId: PROVIDER_IMAGE_ID,
    kind: "vllm",
    name: VLLM_PROVIDER_NAME,
    owner: PROVIDER_COHORT,
    requestedImage: PROVIDER_IMAGE,
  };
}

function installProviderDocker(
  fixture: ReadinessFixture,
  scenario:
    | "ambiguous"
    | "authority-drift"
    | "id-verification-indeterminate"
    | "indeterminate"
    | "inspect-indeterminate"
    | "missing"
    | "name-verification-indeterminate"
    | "normal"
    | "remove-indeterminate"
    | "reused"
    | "reuse-after-remove",
  initialState: "absent" | "present" = "present",
): NodeJS.ProcessEnv {
  const stateFile = path.join(fixture.root, "provider-container-state");
  const removeLog = path.join(fixture.root, "provider-container-remove.log");
  fs.writeFileSync(stateFile, `${initialState}\n`, "utf8");
  writeCommand(
    fixture.binDir,
    "docker",
    `command_name="$1"
shift
state="$(/bin/cat "$FAKE_PROVIDER_STATE")"
if [ "$command_name" = ps ]; then
  if [ "$FAKE_PROVIDER_SCENARIO" = indeterminate ]; then
    echo 'docker daemon unavailable' >&2
    exit 125
  fi
  filter=''
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --filter ]; then
      filter="$2"
      shift 2
    else
      shift
    fi
  done
  if [ "$state" = absent ] && [ "$FAKE_PROVIDER_SCENARIO" = id-verification-indeterminate ] && printf '%s' "$filter" | /usr/bin/grep -q '^id='; then
    echo 'docker daemon unavailable during ID verification' >&2
    exit 125
  fi
  if [ "$state" = absent ] && [ "$FAKE_PROVIDER_SCENARIO" = name-verification-indeterminate ] && printf '%s' "$filter" | /usr/bin/grep -q '^name='; then
    echo 'docker daemon unavailable during name verification' >&2
    exit 125
  fi
  [ "$state" = present ] || {
    if [ "$FAKE_PROVIDER_SCENARIO" = reuse-after-remove ] && printf '%s' "$filter" | /usr/bin/grep -q '^name='; then
      printf '%s\\n' "$FAKE_PROVIDER_REPLACEMENT_ID"
    fi
    exit 0
  }
  case "$FAKE_PROVIDER_SCENARIO" in
    missing) exit 0 ;;
    ambiguous) printf '%s\\n%s\\n' "$FAKE_PROVIDER_ID" "$FAKE_PROVIDER_REPLACEMENT_ID" ;;
    reused) printf '%s\\n' "$FAKE_PROVIDER_REPLACEMENT_ID" ;;
    *) printf '%s\\n' "$FAKE_PROVIDER_ID" ;;
  esac
  exit 0
fi
if [ "$command_name" = container ] && [ "$1" = inspect ]; then
  if [ "$FAKE_PROVIDER_SCENARIO" = inspect-indeterminate ]; then
    echo 'docker inspect unavailable' >&2
    exit 125
  fi
  owner="$FAKE_PROVIDER_OWNER"
  [ "$FAKE_PROVIDER_SCENARIO" != authority-drift ] || owner=other-owner
  printf '%s|/%s|%s|%s|%s|vllm\\n' \\
    "$FAKE_PROVIDER_ID" \\
    "$FAKE_PROVIDER_NAME" \\
    "$FAKE_PROVIDER_IMAGE" \\
    "$FAKE_PROVIDER_IMAGE_ID" \\
    "$owner"
  exit 0
fi
if [ "$command_name" = rm ] && [ "$1" = -f ] && [ "$2" = "$FAKE_PROVIDER_ID" ]; then
  if [ "$FAKE_PROVIDER_SCENARIO" = remove-indeterminate ]; then
    echo 'docker removal unavailable' >&2
    exit 125
  fi
  printf '%s\\n' "$2" >>"$FAKE_PROVIDER_REMOVE_LOG"
  printf 'absent\\n' >"$FAKE_PROVIDER_STATE"
  exit 0
fi
echo "unexpected fake docker command: $command_name $*" >&2
exit 64`,
  );
  return {
    ...fixture.env,
    FAKE_PROVIDER_ID: PROVIDER_CONTAINER_ID,
    FAKE_PROVIDER_IMAGE: PROVIDER_IMAGE,
    FAKE_PROVIDER_IMAGE_ID: PROVIDER_IMAGE_ID,
    FAKE_PROVIDER_NAME: VLLM_PROVIDER_NAME,
    FAKE_PROVIDER_OWNER: PROVIDER_COHORT,
    FAKE_PROVIDER_REMOVE_LOG: removeLog,
    FAKE_PROVIDER_REPLACEMENT_ID: "d".repeat(64),
    FAKE_PROVIDER_SCENARIO: scenario,
    FAKE_PROVIDER_STATE: stateFile,
  };
}

function installProviderInventoryDocker(
  fixture: ReadinessFixture,
  scenario:
    | "clean"
    | "indeterminate-network"
    | "indeterminate-provider"
    | "retained-name"
    | "retained-network"
    | "retained-provider"
    | "retained-sandbox" = "clean",
): NodeJS.ProcessEnv {
  const commandLog = path.join(fixture.root, "provider-inventory-docker.log");
  writeCommand(
    fixture.binDir,
    "docker",
    `command_name="$1"
shift
printf '%s %s\\n' "$command_name" "$*" >>"$FAKE_PROVIDER_INVENTORY_COMMAND_LOG"
if [ "$command_name" = ps ]; then
  if [ "$FAKE_PROVIDER_INVENTORY_SCENARIO" = indeterminate-provider ]; then
    echo 'provider inventory unavailable' >&2
    exit 125
  fi
  case "$*" in
    *"label=$FAKE_PROVIDER_OWNER_LABEL=$FAKE_PROVIDER_COHORT"*)
      case "$*" in
        *"label=$FAKE_PROVIDER_KIND_LABEL"*)
          [ "$FAKE_PROVIDER_INVENTORY_SCENARIO" != retained-provider ] || printf '%s|provider|%s|vllm\\n' "$FAKE_PROVIDER_CONTAINER_ID" "$FAKE_PROVIDER_COHORT"
          exit 0
          ;;
        *) printf '%s|protected-registry|%s|\\n' "$FAKE_PROVIDER_REGISTRY_ID" "$FAKE_PROVIDER_COHORT" ;;
      esac
      ;;
    *"name=^/$FAKE_PROVIDER_VLLM_NAME\\$"*)
      [ "$FAKE_PROVIDER_INVENTORY_SCENARIO" != retained-name ] || printf '%s\\n' "$FAKE_PROVIDER_CONTAINER_ID"
      exit 0
      ;;
    *"label=openshell.ai/managed-by=openshell"*)
      [ "$FAKE_PROVIDER_INVENTORY_SCENARIO" != retained-sandbox ] || printf 'nmc-mi-protected-retained\\n'
      exit 0
      ;;
    *) exit 0 ;;
  esac
fi
if [ "$command_name" = network ] && [ "$1" = ls ]; then
  if [ "$FAKE_PROVIDER_INVENTORY_SCENARIO" = indeterminate-network ]; then
    echo 'network inventory unavailable' >&2
    exit 125
  fi
  [ "$FAKE_PROVIDER_INVENTORY_SCENARIO" != retained-network ] || printf 'nemoclaw-managed-pr-retained\\n'
  exit 0
fi
echo "unexpected fake docker command: $command_name $*" >&2
exit 64`,
  );
  return {
    ...fixture.env,
    FAKE_PROVIDER_COHORT: PROVIDER_COHORT,
    FAKE_PROVIDER_CONTAINER_ID: PROVIDER_CONTAINER_ID,
    FAKE_PROVIDER_INVENTORY_COMMAND_LOG: commandLog,
    FAKE_PROVIDER_INVENTORY_SCENARIO: scenario,
    FAKE_PROVIDER_KIND_LABEL: PROTECTED_PROVIDER_KIND_LABEL,
    FAKE_PROVIDER_OWNER_LABEL: PROTECTED_PROVIDER_OWNER_LABEL,
    FAKE_PROVIDER_REGISTRY_ID: "e".repeat(64),
    FAKE_PROVIDER_VLLM_NAME: VLLM_PROVIDER_NAME,
  };
}

describe("protected managed-image runtime commands", () => {
  it("derives bounded provider container names from the protected cohort", () => {
    expect(VLLM_PROVIDER_NAME).toBe("nemoclaw-mi-vllm-protected-123-1");
    expect(protectedProviderContainerName("nim", PROVIDER_COHORT)).toBe(
      "nemoclaw-mi-nim-protected-123-1",
    );
    expect(
      protectedProviderContainerName("vllm", "protected-99999999999999999999-9999999999"),
    ).toHaveLength(58);
    expect(() => protectedProviderContainerName("vllm", "other-123-1")).toThrow(
      "invalid protected cohort",
    );
  });

  it("refuses a pre-existing provider container without deleting it", async () => {
    const fixture = createReadinessFixture();
    const env = installProviderDocker(fixture, "normal");
    const command = protectedProviderContainerPreflightCommand(VLLM_PROVIDER_NAME);
    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "provider-preflight-preexisting",
      captureLimitBytes: command.captureLimitBytes,
      env,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("refusing to replace pre-existing provider container");
    expect(fs.existsSync(env.FAKE_PROVIDER_REMOVE_LOG!)).toBe(false);
    expect(fs.readFileSync(result.artifacts.result, "utf8")).toContain(VLLM_PROVIDER_NAME);
  });

  it.each([
    { case: "missing", stdout: "" },
    { case: "short", stdout: "abc123" },
    { case: "ambiguous", stdout: `${PROVIDER_CONTAINER_ID}\n${"d".repeat(64)}` },
  ])("rejects a $case provider run ID before authority capture", ({ stdout }) => {
    expect(() => protectedProviderReportedContainerId(VLLM_PROVIDER_NAME, stdout)).toThrow(
      "did not report one full container ID",
    );
  });

  it("removes a provider container by exact authority and verifies ID and name absence", async () => {
    const fixture = createReadinessFixture();
    const env = installProviderDocker(fixture, "normal");
    const command = protectedProviderContainerCleanupCommand(providerAuthority());
    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "provider-cleanup-exact-authority",
      captureLimitBytes: command.captureLimitBytes,
      env,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`name=${VLLM_PROVIDER_NAME}`);
    expect(result.stdout).toContain(`id=${PROVIDER_CONTAINER_ID}`);
    expect(result.stdout).toContain(`${PROTECTED_PROVIDER_OWNER_LABEL}=${PROVIDER_COHORT}`);
    expect(result.stdout).toContain(`${PROTECTED_PROVIDER_KIND_LABEL}=vllm`);
    expect(fs.readFileSync(env.FAKE_PROVIDER_STATE!, "utf8").trim()).toBe("absent");
    expect(fs.readFileSync(env.FAKE_PROVIDER_REMOVE_LOG!, "utf8").trim()).toBe(
      PROVIDER_CONTAINER_ID,
    );
    expect(fs.readFileSync(result.artifacts.result, "utf8")).toContain(PROVIDER_IMAGE_ID);

    const revalidation = protectedProviderContainerPreflightCommand(VLLM_PROVIDER_NAME);
    const revalidated = await fixture.host.command(revalidation.command, revalidation.args, {
      artifactName: "provider-cleanup-callback-revalidation",
      captureLimitBytes: revalidation.captureLimitBytes,
      env,
      timeoutMs: 5_000,
    });
    expect(revalidated.exitCode).toBe(0);
    expect(revalidated.stdout).toContain(`name=${VLLM_PROVIDER_NAME}`);
  });

  it.each([
    ["missing", "cleanup evidence is missing"],
    ["ambiguous", "cleanup evidence is ambiguous"],
    ["reused", "container name"],
    ["indeterminate", "inventory is indeterminate"],
    ["inspect-indeterminate", "authority inspection is indeterminate"],
    ["authority-drift", "cleanup authority drifted"],
    ["remove-indeterminate", "cleanup removal is indeterminate"],
    ["id-verification-indeterminate", "ID verification is indeterminate"],
    ["name-verification-indeterminate", "name verification is indeterminate"],
  ] as const)("fails closed for %s provider cleanup evidence", async (scenario, message) => {
    const fixture = createReadinessFixture();
    const env = installProviderDocker(fixture, scenario);
    const command = protectedProviderContainerCleanupCommand(providerAuthority());
    const result = await fixture.host.command(command.command, command.args, {
      artifactName: `provider-cleanup-${scenario}`,
      captureLimitBytes: command.captureLimitBytes,
      env,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain(message);
    const removalEvidence = fs.existsSync(env.FAKE_PROVIDER_REMOVE_LOG!)
      ? fs.readFileSync(env.FAKE_PROVIDER_REMOVE_LOG!, "utf8").trim()
      : "";
    expect(removalEvidence).toBe(
      scenario === "id-verification-indeterminate" || scenario === "name-verification-indeterminate"
        ? PROVIDER_CONTAINER_ID
        : "",
    );
  });

  it("fails when the provider name is reused after exact-ID removal", async () => {
    const fixture = createReadinessFixture();
    const env = installProviderDocker(fixture, "reuse-after-remove");
    const command = protectedProviderContainerCleanupCommand(providerAuthority());
    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "provider-cleanup-name-reused-after-remove",
      captureLimitBytes: command.captureLimitBytes,
      env,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain("retained or replaced");
    expect(fs.readFileSync(env.FAKE_PROVIDER_REMOVE_LOG!, "utf8").trim()).toBe(
      PROVIDER_CONTAINER_ID,
    );
  });

  it("excludes a same-cohort registry from the provider cleanup inventory", async () => {
    const fixture = createReadinessFixture();
    const env = installProviderInventoryDocker(fixture);
    const nimName = protectedProviderContainerName("nim", PROVIDER_COHORT);
    const command = protectedProviderFinalInventoryCommand(
      PROVIDER_COHORT,
      VLLM_PROVIDER_NAME,
      nimName,
    );
    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "provider-final-inventory-with-registry",
      captureLimitBytes: command.captureLimitBytes,
      env,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`expected-provider name=${VLLM_PROVIDER_NAME}`);
    expect(result.stdout).toContain(`expected-provider name=${nimName}`);
    expect(result.stdout).toContain("protected-runtime-inventory-clean");
    const dockerCalls = fs.readFileSync(env.FAKE_PROVIDER_INVENTORY_COMMAND_LOG!, "utf8");
    expect(dockerCalls).toContain(`label=${PROTECTED_PROVIDER_OWNER_LABEL}=${PROVIDER_COHORT}`);
    expect(dockerCalls).toContain(`label=${PROTECTED_PROVIDER_KIND_LABEL}`);
  });

  it.each([
    ["retained-provider", "retained state"],
    ["retained-name", "retained state"],
    ["retained-sandbox", "retained state"],
    ["retained-network", "retained state"],
    ["indeterminate-provider", "provider-owned container inventory is indeterminate"],
    ["indeterminate-network", "managed network inventory is indeterminate"],
  ] as const)("fails closed for %s final provider inventory", async (scenario, message) => {
    const fixture = createReadinessFixture();
    const env = installProviderInventoryDocker(fixture, scenario);
    const command = protectedProviderFinalInventoryCommand(
      PROVIDER_COHORT,
      VLLM_PROVIDER_NAME,
      protectedProviderContainerName("nim", PROVIDER_COHORT),
    );
    const result = await fixture.host.command(command.command, command.args, {
      artifactName: `provider-final-inventory-${scenario}`,
      captureLimitBytes: command.captureLimitBytes,
      env,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(70);
    expect(result.stderr).toContain(message);
  });

  it.each([
    { kind: "relative", logPath: "ollama.log" },
    { kind: "multiline", logPath: "/tmp/ollama\r\nother.log" },
    { kind: "NUL-containing", logPath: "/tmp/ollama\0other.log" },
  ])("rejects a $kind Ollama log path", ({ logPath }) => {
    expect(() => protectedOllamaReadinessCommand(logPath)).toThrow(
      "protected Ollama log path must be absolute",
    );
  });

  it("ignores login-shell logout hooks and reports successful readiness", async () => {
    const fixture = createReadinessFixture();
    writeCommand(fixture.binDir, "ollama", "exit 0");
    writeCommand(fixture.binDir, "curl", "exit 0");

    const ollamaLog = path.join(fixture.root, "ollama.log");
    const ollamaCommand = protectedOllamaReadinessCommand(ollamaLog);
    const ollama = await fixture.host.command(ollamaCommand.command, ollamaCommand.args, {
      artifactName: "ollama-readiness-success",
      captureLimitBytes: ollamaCommand.captureLimitBytes,
      env: fixture.env,
      timeoutMs: 5_000,
    });
    const vllmCommand = protectedVllmReadinessCommand(VLLM_PROVIDER_NAME);
    const vllm = await fixture.host.command(vllmCommand.command, vllmCommand.args, {
      artifactName: "vllm-readiness-success",
      captureLimitBytes: vllmCommand.captureLimitBytes,
      env: fixture.env,
      timeoutMs: 5_000,
    });

    expect(ollama.command.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(ollama.exitCode).toBe(0);
    expect(ollama.stdout).toBe("restart_mode=manual\nmanaged-image-ollama-ready\n");
    expect(vllm.command.slice(0, 4)).toEqual(["bash", "--noprofile", "--norc", "-c"]);
    expect(vllm.exitCode).toBe(0);
    expect(vllm.stdout).toBe("managed-image-vllm-ready attempts=1\n");
  });

  it("returns failure with a redacted tail of at most 200 Ollama log lines", async () => {
    const fixture = createReadinessFixture();
    const sensitiveValue = "protected-readiness-sensitive-value";
    const sourceLog = path.join(fixture.root, "ollama-source.log");
    fs.writeFileSync(
      sourceLog,
      `${Array.from(
        { length: 260 },
        (_, index) => `runtime-log-line-${String(index + 1).padStart(3, "0")} ${sensitiveValue}`,
      ).join("\n")}\n`,
      "utf8",
    );
    writeCommand(fixture.binDir, "ollama", '/bin/cat "$FAKE_OLLAMA_SOURCE_LOG"');
    writeCommand(fixture.binDir, "curl", "/bin/sleep 0.2\nexit 1");
    writeCommand(fixture.binDir, "seq", "printf '1\\n'");
    writeCommand(fixture.binDir, "sleep", "exit 0");

    const ollamaLog = path.join(fixture.root, "ollama.log");
    const command = protectedOllamaReadinessCommand(ollamaLog);
    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "ollama-readiness-failure",
      captureLimitBytes: command.captureLimitBytes,
      env: { ...fixture.env, FAKE_OLLAMA_SOURCE_LOG: sourceLog },
      redactionValues: [sensitiveValue],
      timeoutMs: 5_000,
    });
    const diagnosticLines = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("runtime-log-line-"));

    expect(result.command.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("managed-image-ollama-not-ready status=1");
    expect(diagnosticLines).toHaveLength(200);
    expect(diagnosticLines[0]).toContain("runtime-log-line-061");
    expect(diagnosticLines.at(-1)).toContain("runtime-log-line-260");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(sensitiveValue);

    const stderrArtifact = fs.readFileSync(result.artifacts.stderr, "utf8");
    const resultArtifact = fs.readFileSync(result.artifacts.result, "utf8");
    expect(stderrArtifact).not.toContain("runtime-log-line-001");
    expect(stderrArtifact).not.toContain(sensitiveValue);
    expect(resultArtifact).not.toContain(sensitiveValue);
  });

  it("bounds one oversized Ollama log line while retaining the readiness failure", async () => {
    const fixture = createReadinessFixture();
    const sensitiveValue = "oversized-protected-readiness-sensitive-value";
    writeCommand(fixture.binDir, "curl", "/bin/sleep 0.2\nexit 1");
    writeCommand(fixture.binDir, "seq", "printf '1\\n'");
    writeCommand(fixture.binDir, "sleep", "exit 0");

    const ollamaLog = path.join(fixture.root, "ollama.log");
    const command = protectedOllamaReadinessCommand(ollamaLog);
    const sourceLog = path.join(fixture.root, "ollama-oversized-source.log");
    fs.writeFileSync(
      sourceLog,
      `${"x".repeat(command.captureLimitBytes + 1_024)}${sensitiveValue}\n`,
      "utf8",
    );
    writeCommand(fixture.binDir, "ollama", '/bin/cat "$FAKE_OLLAMA_SOURCE_LOG"');

    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "ollama-readiness-oversized-failure",
      captureLimitBytes: command.captureLimitBytes,
      env: { ...fixture.env, FAKE_OLLAMA_SOURCE_LOG: sourceLog },
      redactionValues: [sensitiveValue],
      timeoutMs: 5_000,
    });
    const stderrArtifact = fs.readFileSync(result.artifacts.stderr, "utf8");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[shell-probe omitted ");
    expect(result.stderr).toContain("managed-image-ollama-not-ready status=1");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(sensitiveValue);
    expect(Buffer.byteLength(stderrArtifact)).toBeLessThanOrEqual(command.captureLimitBytes + 256);
  });

  it("retains the vLLM readiness failure after oversized failing Docker logs", async () => {
    const fixture = createReadinessFixture();
    const sensitiveValue = "oversized-vllm-readiness-sensitive-value";
    const command = protectedVllmReadinessCommand(VLLM_PROVIDER_NAME);
    const sourceLog = path.join(fixture.root, "vllm-oversized-source.log");
    fs.writeFileSync(
      sourceLog,
      `${"x".repeat(command.captureLimitBytes + 1_024)}${sensitiveValue}\n`,
      "utf8",
    );
    writeCommand(fixture.binDir, "curl", "/bin/sleep 0.2\nexit 1");
    writeCommand(fixture.binDir, "sleep", "exit 0");
    writeCommand(
      fixture.binDir,
      "docker",
      `if [ "$1" = "container" ]; then
  printf 'false\\n'
  exit 0
fi
/bin/cat "$FAKE_VLLM_SOURCE_LOG"
exit 42`,
    );

    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "vllm-readiness-oversized-failure",
      captureLimitBytes: command.captureLimitBytes,
      env: { ...fixture.env, FAKE_VLLM_SOURCE_LOG: sourceLog },
      redactionValues: [sensitiveValue],
      timeoutMs: 5_000,
    });
    const stderrArtifact = fs.readFileSync(result.artifacts.stderr, "utf8");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("[shell-probe omitted ");
    expect(result.stderr).toContain("managed-image-vllm-not-ready attempts=1");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stderr).not.toContain(sensitiveValue);
    expect(Buffer.byteLength(stderrArtifact)).toBeLessThanOrEqual(command.captureLimitBytes + 256);
  });

  it("redacts provider-native NIM failure evidence in memory and artifacts", async () => {
    const fixture = createReadinessFixture();
    const sensitiveValue = "protected-nim-readiness-sensitive-value";
    const command = protectedNimReadinessCommand(
      protectedProviderContainerName("nim", PROVIDER_COHORT),
    );
    writeCommand(fixture.binDir, "curl", "exit 1");
    writeCommand(fixture.binDir, "seq", "printf '1\\n'");
    writeCommand(fixture.binDir, "sleep", "exit 0");
    writeCommand(
      fixture.binDir,
      "docker",
      `if [ "$1" = "container" ]; then
  printf 'false\\n'
  exit 0
fi
printf 'provider-native-log %s\\n' "$FAKE_NIM_SECRET"
exit 42`,
    );

    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "nim-readiness-provider-failure",
      captureLimitBytes: command.captureLimitBytes,
      env: { ...fixture.env, FAKE_NIM_SECRET: sensitiveValue },
      redactionValues: [sensitiveValue],
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("provider-native-log [REDACTED]");
    expect(result.stderr).toContain("managed-image-nim-not-ready attempts=1");
    expect(result.stderr).not.toContain(sensitiveValue);
    expect(fs.readFileSync(result.artifacts.stderr, "utf8")).not.toContain(sensitiveValue);
    expect(fs.readFileSync(result.artifacts.result, "utf8")).not.toContain(sensitiveValue);
  });

  it("reports vLLM diagnostics when the container stops during readiness", async () => {
    const fixture = createReadinessFixture();
    const command = protectedVllmReadinessCommand(VLLM_PROVIDER_NAME);
    writeCommand(fixture.binDir, "curl", "exit 1");
    writeCommand(fixture.binDir, "sleep", "exit 99");
    writeCommand(
      fixture.binDir,
      "docker",
      `if [ "$1" = "container" ]; then
  printf 'false\\n'
  exit 0
fi
printf 'vllm-stopped-diagnostic\\n'`,
    );

    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "vllm-readiness-stopped-container",
      captureLimitBytes: command.captureLimitBytes,
      env: fixture.env,
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("vllm-stopped-diagnostic");
    expect(result.stderr).toContain("managed-image-vllm-not-ready attempts=1");
  });

  it("bounds a connected-but-stalled vLLM probe before collecting diagnostics", async () => {
    const fixture = createReadinessFixture();
    const command = protectedVllmReadinessCommand(VLLM_PROVIDER_NAME);
    const curlArgvLog = path.join(fixture.root, "curl-argv.log");
    writeCommand(
      fixture.binDir,
      "curl",
      `printf '%s\\n' "$@" >>"$FAKE_CURL_ARGV_LOG"
/bin/sleep 0.2
exit 28`,
    );
    writeCommand(fixture.binDir, "sleep", "exit 0");
    writeCommand(
      fixture.binDir,
      "docker",
      `if [ "$1" = "container" ]; then
  printf 'false\\n'
  exit 0
fi
printf 'vllm-stalled-probe-diagnostic\\n'`,
    );

    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "vllm-readiness-stalled-probe",
      captureLimitBytes: command.captureLimitBytes,
      env: { ...fixture.env, FAKE_CURL_ARGV_LOG: curlArgvLog },
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(fs.readFileSync(curlArgvLog, "utf8").trim().split("\n")).toEqual([
      "-fsS",
      "--connect-timeout",
      "2",
      "--max-time",
      "5",
      "http://127.0.0.1:8000/v1/models",
    ]);
    expect(result.stderr).toContain("vllm-stalled-probe-diagnostic");
    expect(result.stderr).toContain("managed-image-vllm-not-ready attempts=1");
  });

  it("bounds a connected-but-stalled NIM probe and redacts its diagnostics", async () => {
    const fixture = createReadinessFixture();
    const sensitiveValue = "protected-nim-stalled-probe-api-key";
    const command = protectedNimReadinessCommand(
      protectedProviderContainerName("nim", PROVIDER_COHORT),
    );
    const curlArgvLog = path.join(fixture.root, "nim-curl-argv.log");
    writeCommand(
      fixture.binDir,
      "curl",
      `printf '%s\\n' "$@" >>"$FAKE_CURL_ARGV_LOG"
/bin/sleep 0.2
exit 28`,
    );
    writeCommand(fixture.binDir, "sleep", "exit 0");
    writeCommand(
      fixture.binDir,
      "docker",
      `if [ "$1" = "container" ]; then
  printf 'false\\n'
  exit 0
fi
printf 'nim-stalled-probe-diagnostic key=%s\\n' "$FAKE_NIM_API_KEY"`,
    );

    const result = await fixture.host.command(command.command, command.args, {
      artifactName: "nim-readiness-stalled-probe",
      captureLimitBytes: command.captureLimitBytes,
      env: {
        ...fixture.env,
        FAKE_CURL_ARGV_LOG: curlArgvLog,
        FAKE_NIM_API_KEY: sensitiveValue,
      },
      redactionValues: [sensitiveValue],
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(fs.readFileSync(curlArgvLog, "utf8").trim().split("\n")).toEqual([
      "-fsS",
      "--connect-timeout",
      "5",
      "--max-time",
      "5",
      "http://127.0.0.1:8000/v1/models",
    ]);
    expect(result.stderr).toContain("nim-stalled-probe-diagnostic key=[REDACTED]");
    expect(result.stderr).toContain("managed-image-nim-not-ready attempts=1");
    expect(result.stderr).not.toContain(sensitiveValue);
    expect(fs.readFileSync(result.artifacts.stderr, "utf8")).not.toContain(sensitiveValue);
    expect(fs.readFileSync(result.artifacts.result, "utf8")).not.toContain(sensitiveValue);
  });
});
