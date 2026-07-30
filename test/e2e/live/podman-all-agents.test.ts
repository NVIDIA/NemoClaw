// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { resolveManagedGatewayStateDirectory } from "../../../src/lib/onboard/gateway-binding.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { assertExitZero, resultText } from "../fixtures/clients/index.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { CLI_DIST_ENTRYPOINT, CLI_ENTRYPOINT } from "../fixtures/paths.ts";
import { readRegistrySandboxEntry } from "../fixtures/phases/index.ts";
import type { TargetEnvironment } from "../registry/types.ts";

const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
type Agent = (typeof AGENTS)[number];

const AGENT_BINARIES: Readonly<Record<Agent, string>> = {
  openclaw: "openclaw",
  hermes: "hermes",
  "langchain-deepagents-code": "dcode",
};

const EXPECTED_STATES: Readonly<Record<Agent, string>> = {
  openclaw: "cloud-openclaw-ready",
  hermes: "cloud-hermes-ready",
  "langchain-deepagents-code": "cloud-deepagents-code-ready",
};

const ONBOARDING_PROFILES: Readonly<Record<Agent, string>> = {
  openclaw: "cloud-openclaw",
  hermes: "cloud-hermes",
  "langchain-deepagents-code": "cloud-langchain-deepagents-code",
};

const PHASES = [
  "verify the native Podman lane contract",
  "onboard the selected agent without Docker",
  "verify the expected sandbox, managed image, and agent runtime receipt",
  "snapshot and restore the selected agent into a native Podman clone",
  "verify Podman doctor and exact-socket ownership",
  "stop and start the exact managed sandbox",
  "reject a conflicting shared-gateway Docker request",
  "stop the host gateway and recover it from protected state",
  "resume and rebuild the selected agent from a fresh shell",
  "destroy the Podman sandbox and its final shared gateway",
  "verify final Podman and gateway cleanup",
  "record native Podman completion evidence",
] as const;
const DOCKER_ENV_KEYS = [
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
] as const;

interface ManagedImageEvidence {
  agent: Agent;
  release: string;
  image: string;
  reference: string;
  digest: string;
  sourceRevision: string;
  sourceCohort: string;
}

interface PodmanManagedContainerEvidence {
  containerId: string;
  containerName: string;
  imageId: string;
  imageName: string;
  imageDigest: string;
  imageRepoDigests: string[];
  startupCommand: string[];
  startupEntrypoint: string[];
}

interface ManagedStartupCompletionEvidence {
  agent: Agent;
  corporateCaMerged: boolean;
  profileFingerprint: string;
  runtimeEnvironmentSha256: string;
  schemaVersion: 1;
}

interface GatewayProcessReceipt {
  pid: number;
  startTicks: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the native Podman E2E lane.`);
  return value;
}

function selectedAgent(): Agent {
  const value = requiredEnvironment("E2E_PODMAN_AGENT");
  if (!AGENTS.includes(value as Agent)) {
    throw new Error(`E2E_PODMAN_AGENT must be one of ${AGENTS.join(", ")}; got '${value}'.`);
  }
  return value as Agent;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireStringField(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireStringArrayField(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`${label} must be a string array.`);
  }
  return value;
}

function readCatalogEvidence(file: string, agent: Agent): ManagedImageEvidence {
  const parsed = requireRecord(JSON.parse(fs.readFileSync(file, "utf8")), "catalog evidence");
  const entries = parsed.images;
  if (!Array.isArray(entries)) throw new Error("catalog evidence images must be an array.");
  const entry = entries.find(
    (candidate) => requireRecord(candidate, "catalog image").agent === agent,
  );
  const image = requireRecord(entry, `${agent} catalog image`);
  const evidence = {
    agent,
    release: image.release,
    image: image.image,
    reference: image.reference,
    digest: image.digest,
    sourceRevision: image.sourceRevision,
    sourceCohort: image.sourceCohort,
  };
  for (const [key, value] of Object.entries(evidence)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${agent} catalog evidence field '${key}' must be a non-empty string.`);
    }
  }
  expect(evidence.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(evidence.reference).toBe(`${evidence.image}@${evidence.digest}`);
  return evidence as ManagedImageEvidence;
}

function assertManagedWorkloadReceipt(
  entry: Record<string, unknown>,
  catalog: ManagedImageEvidence,
): string {
  expect(entry.openshellDriver).toBe("podman");
  expect(entry.pendingRouteReservation).not.toBe(true);
  const workload = requireRecord(entry.workload, "registry workload");
  expect(workload).toMatchObject({
    schemaVersion: 1,
    kind: "managed-image",
    reference: catalog.reference,
    release: catalog.release,
    sourceRevision: catalog.sourceRevision,
    sourceCohort: catalog.sourceCohort,
    capabilityContractVersion: 1,
    startupProfileContractVersion: 1,
    credentialProxyReplayRequired: catalog.agent !== "langchain-deepagents-code",
    shared: true,
  });
  expect(workload.reference).toMatch(
    /^ghcr[.]io\/nvidia\/nemoclaw\/[a-z0-9-]+-sandbox@sha256:[0-9a-f]{64}$/u,
  );
  const startupProfileSha256 = requireStringField(
    workload,
    "startupProfileSha256",
    "registry workload startupProfileSha256",
  );
  expect(startupProfileSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(workload.encodedProfile).toMatch(/^[A-Za-z0-9_-]+$/u);
  return startupProfileSha256;
}

function assertDockerGuardClean(file: string): void {
  expect(fs.existsSync(file), "workflow must install the Docker invocation guard").toBe(true);
  expect(fs.readFileSync(file, "utf8"), "native Podman lane invoked the Docker CLI").toBe("");
}

function podmanNativeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = buildAvailabilityProbeEnv();
  for (const key of DOCKER_ENV_KEYS) delete env[key];
  env.OPENSHELL_GATEWAY = process.env.OPENSHELL_GATEWAY ?? "nemoclaw";
  return { ...env, ...extra };
}

function freshPodmanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = podmanNativeEnv(extra);
  delete env.NEMOCLAW_COMPUTE_DRIVER;
  delete env.OPENSHELL_PODMAN_NETWORK_NAME;
  delete env.OPENSHELL_PODMAN_SOCKET;
  delete env.OPENSHELL_SUPERVISOR_IMAGE;
  return env;
}

function gatewayName(entry: Record<string, unknown>): string {
  const candidate = entry.gatewayName;
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  return process.env.OPENSHELL_GATEWAY?.trim() || "nemoclaw";
}

function managedRuntimeBinding(stateDir: string): Record<string, unknown> {
  return requireRecord(
    JSON.parse(fs.readFileSync(path.join(stateDir, "managed-runtime.json"), "utf8")),
    "managed runtime binding",
  );
}

function assertPodmanRuntimeBinding(
  binding: Record<string, unknown>,
  socketPath: string,
  networkName: string,
): void {
  expect(binding).toMatchObject({
    version: 1,
    driverName: "podman",
    configSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    values: {
      socket_path: socketPath,
      network_name: networkName,
    },
  });
}

function assertHealthyPodmanDoctor(stdout: string, sandboxName: string): void {
  const report = requireRecord(JSON.parse(stdout), "doctor report");
  expect(report.schemaVersion).toBe(1);
  expect(report.sandbox).toBe(sandboxName);
  expect(report.failed).toBe(0);
  expect(report.status === "ok" || report.status === "warn").toBe(true);
  const checks = report.checks;
  if (!Array.isArray(checks)) throw new Error("doctor report checks must be an array.");
  for (const label of ["Podman service", "OpenShell status", "Live sandbox"]) {
    const check = checks.find(
      (candidate) => requireRecord(candidate, "doctor check").label === label,
    );
    expect(requireRecord(check, `doctor check '${label}'`).status).toBe("ok");
  }
}

function managedStartupCommand(
  config: Record<string, unknown>,
  agent: Agent,
  profileFingerprint: string,
): void {
  const env = requireStringArrayField(config, "Env", "Podman container Config.Env");
  const commandEntries = env.filter((entry) => entry.startsWith("OPENSHELL_SANDBOX_COMMAND="));
  if (commandEntries.length !== 1) {
    throw new Error("managed Podman container must persist one sandbox startup command");
  }
  const command = commandEntries[0]?.slice("OPENSHELL_SANDBOX_COMMAND=".length) ?? "";
  const exactImageOwnedSuffix =
    `/usr/local/bin/nemoclaw-managed-startup-hold --agent ${agent} ` +
    `--profile-fingerprint ${profileFingerprint}`;
  if (
    !command.startsWith("env ") ||
    !command.endsWith(exactImageOwnedSuffix) ||
    /(?:^|\s)sleep\s+infinity(?:\s|$)/u.test(command)
  ) {
    throw new Error(
      "managed Podman container did not persist the exact image-owned startup command",
    );
  }
}

function normalizedPodmanUlimits(
  hostConfig: Record<string, unknown>,
): Map<string, { hard: number; soft: number }> {
  const raw = hostConfig.Ulimits;
  if (!Array.isArray(raw)) throw new Error("Podman HostConfig.Ulimits must be an array.");
  const limits = new Map<string, { hard: number; soft: number }>();
  for (const [index, entry] of raw.entries()) {
    const limit = requireRecord(entry, `Podman HostConfig.Ulimits[${String(index)}]`);
    const name = requireStringField(
      limit,
      "Name",
      `Podman HostConfig.Ulimits[${String(index)}].Name`,
    )
      .replace(/^RLIMIT_/iu, "")
      .toLowerCase();
    const soft = limit.Soft;
    const hard = limit.Hard;
    if (!Number.isSafeInteger(soft) || !Number.isSafeInteger(hard) || limits.has(name)) {
      throw new Error(`Podman HostConfig.Ulimits contains invalid or repeated '${name}'.`);
    }
    limits.set(name, { hard: hard as number, soft: soft as number });
  }
  return limits;
}

function assertDcodeContainerUlimits(agent: Agent, hostConfig: Record<string, unknown>): void {
  if (agent !== "langchain-deepagents-code") return;
  const limits = normalizedPodmanUlimits(hostConfig);
  expect(limits.get("nproc")).toEqual({ hard: 512, soft: 512 });
  expect(limits.get("nofile")).toEqual({ hard: 65_536, soft: 65_536 });
}

function readGatewayProcessReceipt(pidFile: string): GatewayProcessReceipt {
  const firstPidText = fs.readFileSync(pidFile, "utf8").trim();
  if (!/^[1-9][0-9]*$/u.test(firstPidText)) {
    throw new Error("managed Podman gateway PID receipt is malformed");
  }
  const pid = Number(firstPidText);
  const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  const fields =
    commandEnd >= 0
      ? stat
          .slice(commandEnd + 2)
          .trim()
          .split(/\s+/u)
      : [];
  const startTicks = fields[19];
  if (!startTicks || !/^[1-9][0-9]*$/u.test(startTicks)) {
    throw new Error("managed Podman gateway process start identity is unavailable");
  }
  const argv = fs
    .readFileSync(`/proc/${String(pid)}/cmdline`)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (argv.length === 0 || !argv.join(" ").includes("openshell-gateway")) {
    throw new Error("managed Podman gateway PID does not identify the OpenShell gateway");
  }
  if (fs.readFileSync(pidFile, "utf8").trim() !== firstPidText) {
    throw new Error("managed Podman gateway PID receipt changed during inspection");
  }
  return { pid, startTicks };
}

async function findPodmanContainerIds(
  host: HostCliClient,
  socketPath: string,
  sandboxName: string,
  artifactName: string,
): Promise<string[]> {
  const result = await host.command(
    "podman",
    [
      "--url",
      `unix://${socketPath}`,
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      `label=openshell.sandbox-name=${sandboxName}`,
      "--filter",
      "label=openshell.managed=true",
      "--format",
      "{{.ID}}",
    ],
    {
      artifactName,
      env: podmanNativeEnv(),
      timeoutMs: 30_000,
    },
  );
  assertExitZero(result, `Podman container lookup for ${sandboxName}`);
  return [
    ...new Set(
      result.stdout
        .split(/\r?\n/gu)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

async function assertNoPodmanRecreateArtifacts(
  host: HostCliClient,
  socketPath: string,
  sandboxName: string,
  artifactName: string,
): Promise<void> {
  const result = await host.command(
    "podman",
    ["--url", `unix://${socketPath}`, "ps", "--all", "--no-trunc", "--format", "{{.Names}}"],
    {
      artifactName,
      env: podmanNativeEnv(),
      timeoutMs: 30_000,
    },
  );
  assertExitZero(result, `inspect Podman recreate artifacts for ${sandboxName}`);
  const backupPrefix = `openshell-sandbox-${sandboxName}-nemoclaw-backup-`;
  const backups = result.stdout
    .split(/\r?\n/gu)
    .map((value) => value.trim())
    .filter((value) => value.startsWith(backupPrefix));
  expect(backups, `Podman recreate backup remained for ${sandboxName}`).toEqual([]);
}

async function inspectPodmanManagedContainer(
  host: HostCliClient,
  options: {
    artifactPrefix: string;
    catalog: ManagedImageEvidence;
    expectedRunning?: boolean;
    profileFingerprint: string;
    sandboxName: string;
    socketPath: string;
  },
): Promise<PodmanManagedContainerEvidence> {
  const ids = await findPodmanContainerIds(
    host,
    options.socketPath,
    options.sandboxName,
    `${options.artifactPrefix}-lookup`,
  );
  expect(
    ids,
    `expected exactly one Podman container for managed sandbox ${options.sandboxName}`,
  ).toHaveLength(1);
  const containerResult = await host.command(
    "podman",
    [
      "--url",
      `unix://${options.socketPath}`,
      "container",
      "inspect",
      "--format",
      "{{json .}}",
      ids[0],
    ],
    {
      artifactName: `${options.artifactPrefix}-container-inspect`,
      env: podmanNativeEnv(),
      timeoutMs: 30_000,
    },
  );
  assertExitZero(containerResult, `inspect Podman container for ${options.sandboxName}`);
  const container = requireRecord(
    JSON.parse(containerResult.stdout),
    `Podman container ${options.sandboxName}`,
  );
  const containerConfig = requireRecord(container.Config, "Podman container Config");
  const containerHostConfig = requireRecord(container.HostConfig, "Podman container HostConfig");
  const containerLabels = requireRecord(containerConfig.Labels, "Podman container labels");
  const containerState = requireRecord(container.State, "Podman container State");
  const containerId = requireStringField(container, "Id", "Podman container Id");
  const containerName = requireStringField(container, "Name", "Podman container Name");
  const imageId = requireStringField(container, "Image", "Podman container Image");
  const imageName = requireStringField(container, "ImageName", "Podman container ImageName");
  expect(containerId).toBe(ids[0]);
  expect(containerName).toBe(`openshell-sandbox-${options.sandboxName}`);
  expect(imageName).toBe(options.catalog.reference);
  expect(containerLabels["openshell.sandbox-name"]).toBe(options.sandboxName);
  expect(containerLabels["openshell.managed"]).toBe("true");
  expect(containerState.Running).toBe(options.expectedRunning ?? true);
  managedStartupCommand(containerConfig, options.catalog.agent, options.profileFingerprint);
  assertDcodeContainerUlimits(options.catalog.agent, containerHostConfig);

  const imageResult = await host.command(
    "podman",
    [
      "--url",
      `unix://${options.socketPath}`,
      "image",
      "inspect",
      "--format",
      "{{json .}}",
      options.catalog.reference,
    ],
    {
      artifactName: `${options.artifactPrefix}-image-inspect`,
      env: podmanNativeEnv(),
      timeoutMs: 30_000,
    },
  );
  assertExitZero(imageResult, `inspect managed Podman image ${options.catalog.reference}`);
  const image = requireRecord(JSON.parse(imageResult.stdout), "Podman managed image");
  const imageConfig = requireRecord(image.Config, "Podman managed image Config");
  const imageLabels = requireRecord(imageConfig.Labels, "Podman managed image labels");
  const startupEntrypoint = requireStringArrayField(
    imageConfig,
    "Entrypoint",
    "Podman managed image Config.Entrypoint",
  );
  const startupCommand = requireStringArrayField(
    imageConfig,
    "Cmd",
    "Podman managed image Config.Cmd",
  );
  expect(
    requireStringArrayField(containerConfig, "Entrypoint", "Podman container Config.Entrypoint"),
  ).toContain("/opt/openshell/bin/openshell-sandbox");
  expect(
    requireStringArrayField(containerConfig, "Cmd", "Podman container Config.Cmd"),
  ).not.toEqual(["sleep", "infinity"]);
  expect(startupEntrypoint).toContain("/usr/local/bin/nemoclaw-start");
  expect(startupCommand).not.toEqual(["sleep", "infinity"]);
  const imageDigest = image.Digest;
  const imageRepoDigests = image.RepoDigests;
  const inspectedImageId = requireStringField(image, "Id", "Podman managed image Id");
  if (typeof imageDigest !== "string") {
    throw new Error("Podman managed image Digest must be a string.");
  }
  if (
    !Array.isArray(imageRepoDigests) ||
    !imageRepoDigests.every((value): value is string => typeof value === "string")
  ) {
    throw new Error("Podman managed image RepoDigests must be a string array.");
  }
  expect(imageId).toBe(inspectedImageId);
  expect(imageDigest).toBe(options.catalog.digest);
  expect(imageRepoDigests).toContain(options.catalog.reference);
  expect(imageLabels).toMatchObject({
    "io.nvidia.nemoclaw.agent": options.catalog.agent,
    "io.nvidia.nemoclaw.managed-image.contract": "1",
    "io.nvidia.nemoclaw.managed-image.platform": "linux/amd64",
    "io.nvidia.nemoclaw.managed-image.startup-profile": "1",
    "io.nvidia.nemoclaw.managed-image.capabilities": "1",
    "io.nvidia.nemoclaw.managed-image.cohort": options.catalog.sourceCohort,
    "org.opencontainers.image.revision": options.catalog.sourceRevision,
    "org.opencontainers.image.source": "https://github.com/NVIDIA/NemoClaw",
  });

  return {
    containerId,
    containerName,
    imageId,
    imageName,
    imageDigest,
    imageRepoDigests,
    startupCommand,
    startupEntrypoint,
  };
}

async function inspectManagedStartupCompletion(
  sandbox: SandboxClient,
  options: {
    agent: Agent;
    artifactName: string;
    profileFingerprint: string;
    sandboxName: string;
  },
): Promise<ManagedStartupCompletionEvidence> {
  const result = await sandbox.exec(
    options.sandboxName,
    ["cat", "/run/nemoclaw/managed-startup-complete.json"],
    {
      artifactName: options.artifactName,
      env: freshPodmanEnv(),
      timeoutMs: 30_000,
    },
  );
  assertExitZero(result, `${options.agent} managed-startup completion marker`);
  const marker = requireRecord(JSON.parse(result.stdout), "managed-startup completion marker");
  const evidence = {
    agent: marker.agent,
    corporateCaMerged: marker.corporateCaMerged,
    profileFingerprint: marker.profileFingerprint,
    runtimeEnvironmentSha256: marker.runtimeEnvironmentSha256,
    schemaVersion: marker.schemaVersion,
  };
  expect(evidence).toMatchObject({
    agent: options.agent,
    profileFingerprint: options.profileFingerprint,
    runtimeEnvironmentSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    schemaVersion: 1,
  });
  expect(typeof evidence.corporateCaMerged).toBe("boolean");
  return evidence as ManagedStartupCompletionEvidence;
}

async function assertDcodeLiveUlimits(
  sandbox: SandboxClient,
  agent: Agent,
  sandboxName: string,
  artifactName: string,
): Promise<void> {
  if (agent !== "langchain-deepagents-code") return;
  const result = await sandbox.exec(
    sandboxName,
    [
      "bash",
      "-lc",
      'printf "%s:%s:%s:%s\\n" "$(ulimit -Su)" "$(ulimit -Hu)" "$(ulimit -Sn)" "$(ulimit -Hn)"',
    ],
    {
      artifactName,
      env: freshPodmanEnv(),
      timeoutMs: 30_000,
    },
  );
  assertExitZero(result, "DCode live nproc/nofile contract");
  expect(result.stdout.trim()).toBe("512:512:65536:65536");
}

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

test("native Podman: all supported agents use managed OCI images without Docker", {
  timeout: 75 * 60_000,
  meta: { e2ePhases: PHASES },
}, async ({
  artifacts,
  cleanup,
  environment,
  host,
  onboard,
  progress,
  sandbox,
  stateValidation,
}) => {
  const agent = selectedAgent();
  const apiKey = requiredEnvironment("NVIDIA_INFERENCE_API_KEY");
  const release = requiredEnvironment("E2E_PODMAN_MANAGED_IMAGE_RELEASE");
  const socketPath = requiredEnvironment("OPENSHELL_PODMAN_SOCKET");
  const networkName = requiredEnvironment("OPENSHELL_PODMAN_NETWORK_NAME");
  const catalogEvidencePath = requiredEnvironment("E2E_PODMAN_CATALOG_EVIDENCE");
  const dockerGuardLog = requiredEnvironment("E2E_DOCKER_GUARD_LOG");
  const sandboxName = `e2e-podman-${agent.replaceAll(/[^a-z0-9]/gu, "-")}`;
  const snapshotCloneName = `${sandboxName}-snapshot`;
  const catalog = readCatalogEvidence(catalogEvidencePath, agent);

  expect(fs.existsSync(CLI_DIST_ENTRYPOINT), "run `npm run build:cli` before live targets").toBe(
    true,
  );
  expect(path.isAbsolute(socketPath)).toBe(true);
  expect(fs.statSync(socketPath).isSocket()).toBe(true);
  expect(process.env.DOCKER_HOST ?? "").toBe("");
  expect(catalog.release).toBe(release);
  assertDockerGuardClean(dockerGuardLog);

  await artifacts.target.declare({
    id: "podman-all-agents",
    agent,
    sandboxName,
    contracts: [
      "the CLI selects the native Podman compute driver through an exact rootless API socket",
      "OpenClaw, Hermes, and DCode consume immutable managed OCI images",
      "managed startup, snapshot clone, and rebuild preserve the agent-specific Podman contract",
      "the native Podman lane never invokes Docker or uses DOCKER_HOST",
    ],
  });

  const targetEnvironment: TargetEnvironment = {
    platform: "ubuntu-local",
    install: "repo-current",
    runtime: "podman-running",
    onboarding: ONBOARDING_PROFILES[agent],
  };
  const ready = await environment.assertReady(targetEnvironment);

  progress.phase("onboard the selected agent without Docker");
  const instance = await onboard.from(ready, { sandboxName });

  progress.phase("verify the expected sandbox, managed image, and agent runtime receipt");
  const state = await stateValidation.from(EXPECTED_STATES[agent], instance);

  const registryEntry = readRegistrySandboxEntry(sandboxName);
  const initialProfileFingerprint = assertManagedWorkloadReceipt(registryEntry, catalog);
  const runtimeGatewayName = gatewayName(registryEntry);
  const gatewayStateDir = resolveManagedGatewayStateDirectory(runtimeGatewayName, {
    env: podmanNativeEnv(),
  });
  const gatewayPidFile = path.join(gatewayStateDir, "openshell-gateway.pid");
  const runtimeBindingBeforeRecovery = managedRuntimeBinding(gatewayStateDir);
  assertPodmanRuntimeBinding(runtimeBindingBeforeRecovery, socketPath, networkName);
  const initialContainer = await inspectPodmanManagedContainer(host, {
    artifactPrefix: `podman-${agent}-initial`,
    catalog,
    profileFingerprint: initialProfileFingerprint,
    sandboxName,
    socketPath,
  });
  const initialCompletion = await inspectManagedStartupCompletion(sandbox, {
    agent,
    artifactName: `podman-${agent}-managed-startup-completion`,
    profileFingerprint: initialProfileFingerprint,
    sandboxName,
  });
  await assertDcodeLiveUlimits(sandbox, agent, sandboxName, `podman-${agent}-live-ulimits`);
  await assertNoPodmanRecreateArtifacts(
    host,
    socketPath,
    sandboxName,
    `podman-${agent}-recreate-artifacts-initial`,
  );
  const initialGatewayProcess = readGatewayProcessReceipt(gatewayPidFile);
  const version = await sandbox.exec(sandboxName, [AGENT_BINARIES[agent], "--version"], {
    artifactName: `podman-${agent}-version`,
    env: podmanNativeEnv(),
    timeoutMs: 30_000,
  });
  assertExitZero(version, `${agent} managed-image binary`);
  expect(resultText(version).trim()).not.toBe("");
  assertDockerGuardClean(dockerGuardLog);

  progress.phase("snapshot and restore the selected agent into a native Podman clone");
  const snapshotCreate = await host.nemoclaw(
    [sandboxName, "snapshot", "create", "--name", "podman-runtime"],
    {
      artifactName: `podman-${agent}-snapshot-create`,
      env: freshPodmanEnv(),
      timeoutMs: 180_000,
    },
  );
  assertExitZero(snapshotCreate, `create Podman snapshot for ${sandboxName}`);
  expect(resultText(snapshotCreate)).toMatch(/Snapshot v\d+.*created/u);

  let snapshotCloneDestroyed = false;
  cleanup.trackDisposable(`destroy Podman snapshot clone ${snapshotCloneName}`, async () => {
    if (snapshotCloneDestroyed) return;
    await host.nemoclaw([snapshotCloneName, "destroy", "--yes"], {
      artifactName: `podman-${agent}-snapshot-clone-cleanup`,
      env: freshPodmanEnv(),
      timeoutMs: 180_000,
    });
  });
  const snapshotRestore = await host.nemoclaw(
    [sandboxName, "snapshot", "restore", "podman-runtime", "--to", snapshotCloneName, "--yes"],
    {
      artifactName: `podman-${agent}-snapshot-restore-clone`,
      env: freshPodmanEnv({ NVIDIA_INFERENCE_API_KEY: apiKey }),
      redactionValues: [apiKey],
      timeoutMs: 10 * 60_000,
    },
  );
  assertExitZero(snapshotRestore, `restore Podman snapshot into ${snapshotCloneName}`);
  const snapshotCloneEntry = readRegistrySandboxEntry(snapshotCloneName);
  const snapshotCloneProfileFingerprint = assertManagedWorkloadReceipt(snapshotCloneEntry, catalog);
  const snapshotCloneContainer = await inspectPodmanManagedContainer(host, {
    artifactPrefix: `podman-${agent}-snapshot-clone`,
    catalog,
    profileFingerprint: snapshotCloneProfileFingerprint,
    sandboxName: snapshotCloneName,
    socketPath,
  });
  expect(snapshotCloneContainer.containerId).not.toBe(initialContainer.containerId);
  const snapshotCloneCompletion = await inspectManagedStartupCompletion(sandbox, {
    agent,
    artifactName: `podman-${agent}-snapshot-clone-completion`,
    profileFingerprint: snapshotCloneProfileFingerprint,
    sandboxName: snapshotCloneName,
  });
  await assertDcodeLiveUlimits(
    sandbox,
    agent,
    snapshotCloneName,
    `podman-${agent}-snapshot-clone-live-ulimits`,
  );
  await assertNoPodmanRecreateArtifacts(
    host,
    socketPath,
    snapshotCloneName,
    `podman-${agent}-snapshot-clone-recreate-artifacts`,
  );
  const snapshotCloneVersion = await sandbox.exec(
    snapshotCloneName,
    [AGENT_BINARIES[agent], "--version"],
    {
      artifactName: `podman-${agent}-snapshot-clone-version`,
      env: freshPodmanEnv(),
      timeoutMs: 30_000,
    },
  );
  assertExitZero(snapshotCloneVersion, `${agent} managed-image binary in snapshot clone`);
  expect(resultText(snapshotCloneVersion).trim()).not.toBe("");
  const destroySnapshotClone = await host.nemoclaw([snapshotCloneName, "destroy", "--yes"], {
    artifactName: `podman-${agent}-snapshot-clone-destroy`,
    env: freshPodmanEnv(),
    timeoutMs: 180_000,
  });
  assertExitZero(destroySnapshotClone, `destroy Podman snapshot clone ${snapshotCloneName}`);
  snapshotCloneDestroyed = true;
  expect(
    await findPodmanContainerIds(
      host,
      socketPath,
      snapshotCloneName,
      `podman-${agent}-snapshot-clone-after-destroy`,
    ),
  ).toHaveLength(0);
  await assertNoPodmanRecreateArtifacts(
    host,
    socketPath,
    snapshotCloneName,
    `podman-${agent}-snapshot-clone-artifacts-after-destroy`,
  );
  const snapshotGatewayProcess = readGatewayProcessReceipt(gatewayPidFile);
  expect(
    `${snapshotGatewayProcess.pid}:${snapshotGatewayProcess.startTicks}`,
    "snapshot clone cutover must resume a new exact standalone gateway process",
  ).not.toBe(`${initialGatewayProcess.pid}:${initialGatewayProcess.startTicks}`);
  assertDockerGuardClean(dockerGuardLog);

  progress.phase("verify Podman doctor and exact-socket ownership");
  const doctor = await host.nemoclaw([sandboxName, "doctor", "--json"], {
    artifactName: `podman-${agent}-doctor-initial`,
    env: podmanNativeEnv(),
    redactionValues: [apiKey],
    timeoutMs: 120_000,
  });
  assertExitZero(doctor, `doctor the Podman sandbox ${sandboxName}`);
  assertHealthyPodmanDoctor(doctor.stdout, sandboxName);
  assertPodmanRuntimeBinding(managedRuntimeBinding(gatewayStateDir), socketPath, networkName);
  assertDockerGuardClean(dockerGuardLog);

  progress.phase("stop and start the exact managed sandbox");
  const stoppedSandbox = await host.nemoclaw([sandboxName, "stop"], {
    artifactName: `podman-${agent}-sandbox-stop`,
    env: freshPodmanEnv(),
    timeoutMs: 120_000,
  });
  assertExitZero(stoppedSandbox, `stop the exact managed Podman sandbox ${sandboxName}`);
  const stoppedContainer = await inspectPodmanManagedContainer(host, {
    artifactPrefix: `podman-${agent}-after-stop`,
    catalog,
    expectedRunning: false,
    profileFingerprint: initialProfileFingerprint,
    sandboxName,
    socketPath,
  });
  expect(stoppedContainer).toEqual(initialContainer);
  assertDockerGuardClean(dockerGuardLog);

  const startedSandbox = await host.nemoclaw([sandboxName, "start"], {
    artifactName: `podman-${agent}-sandbox-start`,
    env: freshPodmanEnv(),
    timeoutMs: 180_000,
  });
  assertExitZero(startedSandbox, `start the exact managed Podman sandbox ${sandboxName}`);
  const restartedStatus = await host.expectStatus(sandboxName, {
    artifactName: `podman-${agent}-status-after-sandbox-start`,
    env: freshPodmanEnv(),
    timeoutMs: 120_000,
  });
  assertExitZero(restartedStatus, `prove readiness after starting Podman sandbox ${sandboxName}`);
  const restartedContainer = await inspectPodmanManagedContainer(host, {
    artifactPrefix: `podman-${agent}-after-start`,
    catalog,
    profileFingerprint: initialProfileFingerprint,
    sandboxName,
    socketPath,
  });
  expect(
    restartedContainer,
    "stop/start must preserve the exact managed Podman container and immutable image identity",
  ).toEqual(initialContainer);
  const restartedVersion = await sandbox.exec(sandboxName, [AGENT_BINARIES[agent], "--version"], {
    artifactName: `podman-${agent}-version-after-sandbox-start`,
    env: freshPodmanEnv(),
    timeoutMs: 30_000,
  });
  assertExitZero(restartedVersion, `${agent} managed-image binary after stop/start`);
  expect(resultText(restartedVersion).trim()).not.toBe("");
  assertDockerGuardClean(dockerGuardLog);

  progress.phase("reject a conflicting shared-gateway Docker request");
  const conflictName = `${sandboxName}-docker-conflict`;
  const conflictingDriver = await host.nemoclaw(
    [
      "onboard",
      "--non-interactive",
      "--yes",
      "--yes-i-accept-third-party-software",
      "--compute-driver",
      "docker",
      "--name",
      conflictName,
    ],
    {
      artifactName: `podman-${agent}-reject-docker-conflict`,
      env: podmanNativeEnv({
        NVIDIA_INFERENCE_API_KEY: apiKey,
        NEMOCLAW_AGENT: agent,
        NEMOCLAW_PROVIDER: "cloud",
        NEMOCLAW_SANDBOX_NAME: conflictName,
      }),
      redactionValues: [apiKey],
      timeoutMs: 120_000,
    },
  );
  expect(conflictingDriver.exitCode).not.toBe(0);
  expect(resultText(conflictingDriver)).toMatch(
    /Requested OpenShell compute driver 'docker' does not match existing sandbox driver 'podman'|Conflicting persisted OpenShell compute drivers/u,
  );
  const afterConflict = await host.expectListed(sandboxName, {
    artifactName: `podman-${agent}-listed-after-driver-conflict`,
    env: podmanNativeEnv(),
    timeoutMs: 120_000,
  });
  assertExitZero(afterConflict, `list original Podman sandbox after conflicting driver request`);
  expect(resultText(afterConflict)).not.toContain(conflictName);
  const afterConflictContainer = await inspectPodmanManagedContainer(host, {
    artifactPrefix: `podman-${agent}-after-conflict`,
    catalog,
    profileFingerprint: initialProfileFingerprint,
    sandboxName,
    socketPath,
  });
  expect(afterConflictContainer.containerId).toBe(initialContainer.containerId);
  assertDockerGuardClean(dockerGuardLog);

  progress.phase("stop the host gateway and recover it from protected state");
  const stoppedGateway = await host.command(
    "bash",
    [
      "-lc",
      `
set -euo pipefail
pid_file="$1"
test -f "$pid_file"
pid="$(tr -d '[:space:]' <"$pid_file")"
[[ "$pid" =~ ^[1-9][0-9]*$ ]]
cmdline="$(tr '\\0' ' ' <"/proc/$pid/cmdline")"
[[ "$cmdline" == *openshell-gateway* ]]
kill -TERM "$pid"
for _ in $(seq 1 30); do
  if ! kill -0 "$pid" 2>/dev/null; then exit 0; fi
  state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$state" == Z* ]] && exit 0
  sleep 1
done
echo "managed OpenShell gateway pid $pid did not stop" >&2
exit 1
`,
      "stop-managed-podman-gateway",
      gatewayPidFile,
    ],
    {
      artifactName: `podman-${agent}-stop-managed-gateway`,
      env: podmanNativeEnv(),
      timeoutMs: 45_000,
    },
  );
  assertExitZero(stoppedGateway, `stop the managed Podman gateway for ${sandboxName}`);
  expect(fs.existsSync(path.join(gatewayStateDir, "managed-runtime.json"))).toBe(true);
  assertDockerGuardClean(dockerGuardLog);

  const recoveredStatus = await host.expectStatus(sandboxName, {
    artifactName: `podman-${agent}-fresh-shell-recovery-status`,
    env: freshPodmanEnv(),
    timeoutMs: 180_000,
  });
  assertExitZero(recoveredStatus, `recover the Podman gateway from protected runtime state`);
  const runtimeBindingAfterRecovery = managedRuntimeBinding(gatewayStateDir);
  assertPodmanRuntimeBinding(runtimeBindingAfterRecovery, socketPath, networkName);
  expect(runtimeBindingAfterRecovery).toEqual(runtimeBindingBeforeRecovery);
  const recoveredDoctor = await host.nemoclaw([sandboxName, "doctor", "--json"], {
    artifactName: `podman-${agent}-doctor-after-recovery`,
    env: freshPodmanEnv(),
    redactionValues: [apiKey],
    timeoutMs: 120_000,
  });
  assertExitZero(recoveredDoctor, `doctor recovered Podman sandbox ${sandboxName}`);
  assertHealthyPodmanDoctor(recoveredDoctor.stdout, sandboxName);
  const recoveredGatewayProcess = readGatewayProcessReceipt(gatewayPidFile);
  expect(
    `${recoveredGatewayProcess.pid}:${recoveredGatewayProcess.startTicks}`,
    "fresh-shell recovery must replace the exact standalone gateway process",
  ).not.toBe(`${snapshotGatewayProcess.pid}:${snapshotGatewayProcess.startTicks}`);
  assertDockerGuardClean(dockerGuardLog);

  progress.phase("resume and rebuild the selected agent from a fresh shell");
  const resume = await host.nemoclaw(
    ["onboard", "--resume", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
    {
      artifactName: `podman-${agent}-fresh-shell-resume`,
      env: freshPodmanEnv({
        NVIDIA_INFERENCE_API_KEY: apiKey,
        NEMOCLAW_AGENT: agent,
        NEMOCLAW_PROVIDER: "cloud",
      }),
      redactionValues: [apiKey],
      timeoutMs: 15 * 60_000,
    },
  );
  assertExitZero(resume, `resume Podman onboarding for ${sandboxName}`);
  const runtimeBindingAfterResume = managedRuntimeBinding(gatewayStateDir);
  assertPodmanRuntimeBinding(runtimeBindingAfterResume, socketPath, networkName);
  expect(runtimeBindingAfterResume).toEqual(runtimeBindingBeforeRecovery);
  assertDockerGuardClean(dockerGuardLog);

  const rebuilt = await host.nemoclaw([sandboxName, "rebuild", "--yes"], {
    artifactName: `podman-${agent}-fresh-shell-rebuild`,
    env: freshPodmanEnv({
      NVIDIA_INFERENCE_API_KEY: apiKey,
    }),
    redactionValues: [apiKey],
    timeoutMs: 15 * 60_000,
  });
  assertExitZero(rebuilt, `rebuild Podman sandbox ${sandboxName}`);
  const rebuiltRegistryEntry = readRegistrySandboxEntry(sandboxName);
  const rebuiltProfileFingerprint = assertManagedWorkloadReceipt(rebuiltRegistryEntry, catalog);
  const rebuiltContainer = await inspectPodmanManagedContainer(host, {
    artifactPrefix: `podman-${agent}-after-rebuild`,
    catalog,
    profileFingerprint: rebuiltProfileFingerprint,
    sandboxName,
    socketPath,
  });
  expect(
    rebuiltContainer.containerId,
    "rebuild must replace the managed Podman sandbox container",
  ).not.toBe(initialContainer.containerId);
  const runtimeBindingAfterRebuild = managedRuntimeBinding(gatewayStateDir);
  assertPodmanRuntimeBinding(runtimeBindingAfterRebuild, socketPath, networkName);
  expect(runtimeBindingAfterRebuild).toEqual(runtimeBindingBeforeRecovery);
  const rebuiltCompletion = await inspectManagedStartupCompletion(sandbox, {
    agent,
    artifactName: `podman-${agent}-managed-startup-completion-after-rebuild`,
    profileFingerprint: rebuiltProfileFingerprint,
    sandboxName,
  });
  await assertDcodeLiveUlimits(
    sandbox,
    agent,
    sandboxName,
    `podman-${agent}-live-ulimits-after-rebuild`,
  );
  await assertNoPodmanRecreateArtifacts(
    host,
    socketPath,
    sandboxName,
    `podman-${agent}-recreate-artifacts-after-rebuild`,
  );
  const rebuiltGatewayProcess = readGatewayProcessReceipt(gatewayPidFile);
  expect(
    `${rebuiltGatewayProcess.pid}:${rebuiltGatewayProcess.startTicks}`,
    "rebuild cutover must resume a new exact standalone gateway process",
  ).not.toBe(`${recoveredGatewayProcess.pid}:${recoveredGatewayProcess.startTicks}`);
  const rebuiltVersion = await sandbox.exec(sandboxName, [AGENT_BINARIES[agent], "--version"], {
    artifactName: `podman-${agent}-version-after-rebuild`,
    env: freshPodmanEnv(),
    timeoutMs: 30_000,
  });
  assertExitZero(rebuiltVersion, `${agent} managed-image binary after rebuild`);
  expect(resultText(rebuiltVersion).trim()).not.toBe("");
  assertDockerGuardClean(dockerGuardLog);

  progress.phase("destroy the Podman sandbox and its final shared gateway");
  const destroyed = await host.nemoclaw([sandboxName, "destroy", "--yes", "--cleanup-gateway"], {
    artifactName: `podman-${agent}-final-destroy`,
    env: freshPodmanEnv(),
    timeoutMs: 15 * 60_000,
  });
  assertExitZero(destroyed, `destroy Podman sandbox and final gateway ${sandboxName}`);
  assertDockerGuardClean(dockerGuardLog);

  progress.phase("verify final Podman and gateway cleanup");
  expect(
    await findPodmanContainerIds(
      host,
      socketPath,
      sandboxName,
      `podman-${agent}-container-after-final-destroy`,
    ),
  ).toHaveLength(0);
  await assertNoPodmanRecreateArtifacts(
    host,
    socketPath,
    sandboxName,
    `podman-${agent}-recreate-artifacts-after-final-destroy`,
  );
  const podmanAfterCleanup = await host.command(
    "podman",
    ["--url", `unix://${socketPath}`, "info", "--format", "json"],
    {
      artifactName: `podman-${agent}-info-after-final-destroy`,
      env: freshPodmanEnv(),
      timeoutMs: 30_000,
    },
  );
  assertExitZero(podmanAfterCleanup, "prove Podman remained reachable for final cleanup");
  const networkAfterCleanup = await host.command(
    "podman",
    ["--url", `unix://${socketPath}`, "network", "exists", networkName],
    {
      artifactName: `podman-${agent}-network-after-final-destroy`,
      env: freshPodmanEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(networkAfterCleanup.timedOut, resultText(networkAfterCleanup)).toBe(false);
  expect(
    networkAfterCleanup.exitCode,
    `managed Podman network '${networkName}' still exists or could not be checked: ${resultText(
      networkAfterCleanup,
    )}`,
  ).toBe(1);
  expect(fs.existsSync(gatewayPidFile), "final cleanup must remove the managed gateway PID").toBe(
    false,
  );
  expect(
    fs.existsSync(path.join(gatewayStateDir, "managed-runtime.json")),
    "final cleanup must remove the protected runtime binding",
  ).toBe(false);
  assertDockerGuardClean(dockerGuardLog);

  progress.phase("record native Podman completion evidence");
  await artifacts.writeJson("podman-runtime-evidence.json", {
    agent,
    candidateRevision: process.env.GITHUB_SHA ?? null,
    driverName: registryEntry.openshellDriver,
    release: catalog.release,
    reference: catalog.reference,
    digest: catalog.digest,
    sourceRevision: catalog.sourceRevision,
    sourceCohort: catalog.sourceCohort,
    socketPath,
    networkName,
    gatewayName: runtimeGatewayName,
    gatewayStateDir,
    initialContainer,
    initialCompletion,
    snapshotClone: {
      container: snapshotCloneContainer,
      completion: snapshotCloneCompletion,
      destroyed: true,
      sandboxName: snapshotCloneName,
    },
    restartedContainer,
    rebuiltContainer,
    rebuiltCompletion,
    gatewayProcessIdentities: {
      initial: {
        pid: initialGatewayProcess.pid,
        startTicks: initialGatewayProcess.startTicks,
      },
      recovered: {
        pid: recoveredGatewayProcess.pid,
        startTicks: recoveredGatewayProcess.startTicks,
      },
      snapshotClone: {
        pid: snapshotGatewayProcess.pid,
        startTicks: snapshotGatewayProcess.startTicks,
      },
      rebuilt: {
        pid: rebuiltGatewayProcess.pid,
        startTicks: rebuiltGatewayProcess.startTicks,
      },
    },
    recoveredFromProtectedBinding: true,
    snapshotCloneRestored: true,
    stoppedAndStarted: true,
    rebuilt: true,
    finalGatewayCleanup: true,
    expectedStateId: state.state.id,
    dockerGuardLogBytes: fs.statSync(dockerGuardLog).size,
  });
  await artifacts.target.complete({
    id: "podman-all-agents",
    agent,
    release: catalog.release,
    reference: catalog.reference,
    expectedStateId: state.state.id,
  });
});
