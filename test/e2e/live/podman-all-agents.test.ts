// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { resolveManagedGatewayStateDirectory } from "../../../src/lib/onboard/gateway-binding.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { assertExitZero, resultText } from "../fixtures/clients/index.ts";
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
  "verify the expected sandbox state",
  "verify the managed-image and agent runtime receipt",
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
): void {
  expect(entry.openshellDriver).toBe("podman");
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
  expect(workload.startupProfileSha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(workload.encodedProfile).toMatch(/^[A-Za-z0-9_-]+$/u);
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

async function inspectPodmanManagedContainer(
  host: HostCliClient,
  options: {
    artifactPrefix: string;
    catalog: ManagedImageEvidence;
    expectedRunning?: boolean;
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
  };
}

process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

test("native Podman: all supported agents use managed OCI images without Docker", {
  timeout: 50 * 60_000,
  meta: { e2ePhases: PHASES },
}, async ({ artifacts, environment, host, onboard, progress, sandbox, stateValidation }) => {
  const agent = selectedAgent();
  const apiKey = requiredEnvironment("NVIDIA_INFERENCE_API_KEY");
  const release = requiredEnvironment("E2E_PODMAN_MANAGED_IMAGE_RELEASE");
  const socketPath = requiredEnvironment("OPENSHELL_PODMAN_SOCKET");
  const networkName = requiredEnvironment("OPENSHELL_PODMAN_NETWORK_NAME");
  const catalogEvidencePath = requiredEnvironment("E2E_PODMAN_CATALOG_EVIDENCE");
  const dockerGuardLog = requiredEnvironment("E2E_DOCKER_GUARD_LOG");
  const sandboxName = `e2e-podman-${agent.replaceAll(/[^a-z0-9]/gu, "-")}`;
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

  progress.phase("verify the expected sandbox state");
  const state = await stateValidation.from(EXPECTED_STATES[agent], instance);

  progress.phase("verify the managed-image and agent runtime receipt");
  const registryEntry = readRegistrySandboxEntry(sandboxName);
  assertManagedWorkloadReceipt(registryEntry, catalog);
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
    sandboxName,
    socketPath,
  });
  const version = await sandbox.exec(sandboxName, [AGENT_BINARIES[agent], "--version"], {
    artifactName: `podman-${agent}-version`,
    env: podmanNativeEnv(),
    timeoutMs: 30_000,
  });
  assertExitZero(version, `${agent} managed-image binary`);
  expect(resultText(version).trim()).not.toBe("");
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
  assertManagedWorkloadReceipt(rebuiltRegistryEntry, catalog);
  const rebuiltContainer = await inspectPodmanManagedContainer(host, {
    artifactPrefix: `podman-${agent}-after-rebuild`,
    catalog,
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
    restartedContainer,
    rebuiltContainer,
    recoveredFromProtectedBinding: true,
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
