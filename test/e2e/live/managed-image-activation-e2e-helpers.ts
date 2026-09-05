// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import {
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
  managedImagePlatformForNodeArchitecture,
  parseManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import {
  assertExitZero,
  type HostCliClient,
  outputContainsSandbox,
  resultText,
  type SandboxClient,
  trustedSandboxShellScript,
} from "../fixtures/clients/index.ts";
import { expect } from "../fixtures/e2e-test.ts";
import {
  type DockerBuildGuard,
  assertNoDockerfileBuild,
  createDockerBuildGuard,
} from "../fixtures/docker-build-guard.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { captureIssue4462FailureDiagnostics } from "../fixtures/issue-4462-diagnostics.ts";
import type { LifecyclePhaseFixture } from "../fixtures/phases/lifecycle.ts";
import type { TestProgress } from "../fixtures/progress.ts";

const API_KEY = "nemoclaw-managed-activation-e2e-key";
const MODEL = "nemoclaw-managed-activation-model";
const GATEWAY = "nemoclaw";
const AGENT_TIMEOUT_MS = 3 * 60_000;
const ONBOARD_TIMEOUT_MS = 20 * 60_000;
const ONBOARD_FAILURE_STARTUP_SIGNALS = {
  setupStarted: "Setting up NemoClaw",
} as const;
type OnboardFailureStartupSignal = keyof typeof ONBOARD_FAILURE_STARTUP_SIGNALS;

export function summarizeOnboardFailureStartupSignals(
  output: string,
): Record<OnboardFailureStartupSignal, boolean> {
  return Object.fromEntries(
    Object.entries(ONBOARD_FAILURE_STARTUP_SIGNALS).map(([signal, marker]) => [
      signal,
      output.includes(marker),
    ]),
  ) as Record<OnboardFailureStartupSignal, boolean>;
}

export async function captureManagedImageOnboardPairingDiagnostics(
  sandbox: Pick<SandboxClient, "exec">,
  agent: ShippedManagedImageAgent,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (agent !== "openclaw") return;
  await captureIssue4462FailureDiagnostics(sandbox, {
    env,
    redactionValues: [API_KEY],
    sandboxName,
  });
}

const SANDBOX_NAMES: Record<ShippedManagedImageAgent, string> = {
  openclaw: "mi-act-openclaw",
  hermes: "mi-act-hermes",
  "langchain-deepagents-code": "mi-act-dcode",
};
type RuntimeFixtures = {
  readonly artifacts: ArtifactSink;
  readonly cleanup: CleanupRegistry;
  readonly host: HostCliClient;
  readonly lifecycle: LifecyclePhaseFixture;
  readonly progress: TestProgress;
  readonly sandbox: SandboxClient;
};

export function managedActivationOnboardArgs(
  catalogPath: string,
  agent: ShippedManagedImageAgent,
  sandboxName: string,
): string[] {
  return [
    "onboard",
    "--temp-managed-runtime-catalog",
    catalogPath,
    "--fresh",
    "--recreate-sandbox",
    "--non-interactive",
    "--yes",
    "--no-gpu",
    "--agent",
    agent,
    "--name",
    sandboxName,
  ];
}

function requiredCatalogPath(): string {
  const value = process.env.NEMOCLAW_MANAGED_ACTIVATION_CATALOG;
  if (!value || !path.isAbsolute(value)) {
    throw new Error("NEMOCLAW_MANAGED_ACTIVATION_CATALOG must be an absolute path");
  }
  const metadata = fs.lstatSync(value);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("managed activation catalog must be a regular non-symlink file");
  }
  return value;
}

function exactCatalog(
  catalogPath: string,
): ReadonlyMap<ShippedManagedImageAgent, ManagedImageContractV1> {
  const document = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as ManagedImageContractCatalog;
  const platform = managedImagePlatformForNodeArchitecture(process.arch);
  expect(
    platform,
    `managed activation E2E does not support host architecture ${process.arch}`,
  ).not.toBeNull();
  const contracts = new Map<ShippedManagedImageAgent, ManagedImageContractV1>();
  let revision: string | null = null;
  let cohort: string | null = null;
  for (const agent of SHIPPED_MANAGED_IMAGE_AGENTS) {
    const contract = parseManagedImageContractV1(document[agent], agent, platform!);
    revision ??= contract.source.revision;
    cohort ??= contract.source.cohort;
    if (contract.source.revision !== revision || contract.source.cohort !== cohort) {
      throw new Error("managed activation catalog is not one exact all-agent publication cohort");
    }
    contracts.set(agent, contract);
  }
  if (
    Object.keys(document).sort().join("\n") !== [...SHIPPED_MANAGED_IMAGE_AGENTS].sort().join("\n")
  ) {
    throw new Error("managed activation catalog must contain exactly the shipped agents");
  }
  return contracts;
}

function commandEnv(
  guard: DockerBuildGuard,
  catalogPath: string,
  endpointUrl: string,
): NodeJS.ProcessEnv {
  return {
    ...guard.env,
    COMPATIBLE_API_KEY: API_KEY,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_COMPAT_MODEL: MODEL,
    NEMOCLAW_ENDPOINT_URL: endpointUrl,
    NEMOCLAW_IGNORE_RUNTIME_RESOURCES: "1",
    NEMOCLAW_MANAGED_ACTIVATION_CATALOG: catalogPath,
    NEMOCLAW_MODEL: MODEL,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    OPENSHELL_DRIVERS: "docker",
    OPENSHELL_GATEWAY: GATEWAY,
  };
}

function agentTurnCommand(agent: ShippedManagedImageAgent, sessionId: string): string[] {
  switch (agent) {
    case "openclaw":
      return [
        "openclaw",
        "agent",
        "--agent",
        "main",
        "--json",
        "--thinking",
        "off",
        "--session-id",
        sessionId,
        "-m",
        "Reply with exactly one word: PONG",
      ];
    case "hermes":
      return ["hermes", "-z", "Reply with exactly one word: PONG"];
    case "langchain-deepagents-code":
      return ["dcode", "-n", "Reply with exactly one word: PONG", "--json"];
  }
}

function registryDocument(): {
  sandboxes?: Record<string, { workload?: Record<string, unknown> }>;
} {
  const registryPath = path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
  if (!fs.existsSync(registryPath)) return {};
  return JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
    sandboxes?: Record<string, { workload?: Record<string, unknown> }>;
  };
}

function expectManagedReceipt(sandboxName: string, contract: ManagedImageContractV1): void {
  const workload = registryDocument().sandboxes?.[sandboxName]?.workload;
  expect(workload).toMatchObject({
    kind: "managed-image",
    reference: contract.reference,
    release: contract.source.release,
    sourceRevision: contract.source.revision,
    sourceCohort: contract.source.cohort,
    shared: true,
  });
}

async function runAgentTurn(
  sandbox: SandboxClient,
  agent: ShippedManagedImageAgent,
  sandboxName: string,
  phase: "before" | "after",
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await sandbox.exec(
    sandboxName,
    agentTurnCommand(agent, `managed-${agent}-${phase}-${Date.now()}`),
    {
      artifactName: `${agent}-agent-turn-${phase}-restart`,
      env,
      redactionValues: [API_KEY],
      timeoutMs: AGENT_TIMEOUT_MS,
    },
  );
  expect(result.exitCode, resultText(result)).toBe(0);
  expect(resultText(result)).toMatch(/\bPONG\b/iu);
}

async function preclean(
  host: HostCliClient,
  lifecycle: LifecyclePhaseFixture,
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await host.bestEffortCleanupSandbox(sandboxName, {
    artifactName: `pre-cleanup-nemoclaw-${sandboxName}`,
    env,
    timeoutMs: 3 * 60_000,
  });
  await sandbox.cleanupSandbox(sandboxName, {
    artifactName: `pre-cleanup-openshell-${sandboxName}`,
    env,
    timeoutMs: 60_000,
  });
  await lifecycle.stopGatewayRuntime();
  await host.cleanupGatewayRegistration(GATEWAY, {
    artifactName: `pre-cleanup-gateway-${sandboxName}`,
    env,
    timeoutMs: 60_000,
  });
}

async function verifyExactCleanup(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const list = await host.nemoclaw(["list"], {
    artifactName: `post-destroy-nemoclaw-list-${sandboxName}`,
    env,
    timeoutMs: 30_000,
  });
  assertExitZero(list, "list sandboxes after managed activation destroy");
  expect(outputContainsSandbox(list, sandboxName), resultText(list)).toBe(false);
  const openshellList = await sandbox.list({
    artifactName: `post-destroy-openshell-list-${sandboxName}`,
    env,
    timeoutMs: 30_000,
  });
  assertExitZero(openshellList, "list OpenShell sandboxes after managed activation destroy");
  expect(outputContainsSandbox(openshellList, sandboxName), resultText(openshellList)).toBe(false);
  const containers = await host.command(
    "docker",
    ["ps", "-aq", "--filter", `label=openshell.ai/sandbox-name=${sandboxName}`],
    {
      artifactName: `post-destroy-docker-inventory-${sandboxName}`,
      env,
      timeoutMs: 30_000,
    },
  );
  assertExitZero(containers, "inspect Docker inventory after managed activation destroy");
  expect(containers.stdout.trim(), resultText(containers)).toBe("");
  expect(registryDocument().sandboxes?.[sandboxName]).toBeUndefined();
}

function enterOnboardPhase(progress: TestProgress, agent: ShippedManagedImageAgent): void {
  switch (agent) {
    case "openclaw":
      progress.phase("onboard and exercise OpenClaw");
      return;
    case "hermes":
      progress.phase("onboard and exercise Hermes");
      return;
    case "langchain-deepagents-code":
      progress.phase("onboard and exercise Deep Agents Code");
      return;
  }
}

function enterRecoveryPhase(progress: TestProgress, agent: ShippedManagedImageAgent): void {
  switch (agent) {
    case "openclaw":
      progress.phase("restart and recover OpenClaw");
      return;
    case "hermes":
      progress.phase("restart and recover Hermes");
      return;
    case "langchain-deepagents-code":
      progress.phase("restart and recover Deep Agents Code");
      return;
  }
}

function enterCleanupPhase(progress: TestProgress, agent: ShippedManagedImageAgent): void {
  switch (agent) {
    case "openclaw":
      progress.phase("destroy and verify OpenClaw cleanup");
      return;
    case "hermes":
      progress.phase("destroy and verify Hermes cleanup");
      return;
    case "langchain-deepagents-code":
      progress.phase("destroy and verify Deep Agents Code cleanup");
      return;
  }
}

async function collectOnboardFailureDockerDiagnostics(
  artifacts: ArtifactSink,
  host: HostCliClient,
  agent: ShippedManagedImageAgent,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    const inventory = await host.command(
      "docker",
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        "label=openshell.ai/managed-by=openshell",
        "--filter",
        `label=openshell.ai/sandbox-name=${sandboxName}`,
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
      ],
      {
        artifactName: `managed-activation-onboard-failure-${agent}-container-inventory`,
        env,
        redactionValues: [API_KEY],
        timeoutMs: 30_000,
      },
    );
    const containerIds = inventory.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u)[0] ?? "")
      .filter((containerId) => /^[a-f0-9]{12,64}$/u.test(containerId));
    await Promise.allSettled(
      containerIds.map((containerId, index) =>
        host.command(
          "docker",
          [
            "inspect",
            "--format",
            "{{.State.Status}}\t{{.State.Running}}\t{{.State.Restarting}}\t{{.State.OOMKilled}}\t{{.State.Dead}}\t{{.State.ExitCode}}\t{{.State.StartedAt}}\t{{.State.FinishedAt}}",
            containerId,
          ],
          {
            artifactName: `managed-activation-onboard-failure-${agent}-container-${index + 1}-state`,
            env,
            redactionValues: [API_KEY],
            timeoutMs: 30_000,
          },
        ),
      ),
    );
    await Promise.allSettled(
      containerIds.map(async (containerId, index) => {
        const logs = await host.command("docker", ["logs", "--tail", "1000", containerId], {
          artifactName: `managed-activation-onboard-failure-${agent}-container-${index + 1}-logs`,
          captureLimitBytes: 2 * 1024 * 1024,
          env,
          persistArtifacts: false,
          redactionValues: [API_KEY],
          timeoutMs: 30_000,
        });
        if (logs.exitCode !== 0) return;
        const output = `${logs.stdout}\n${logs.stderr}`;
        await artifacts.writeJson(
          `managed-activation-onboard-failure-${agent}-container-${index + 1}-startup-signals.json`,
          summarizeOnboardFailureStartupSignals(output),
        );
      }),
    );
  } catch {
    // Preserve the onboarding failure as the primary error when diagnostics are unavailable.
  }
}

async function qualifyAgent(
  fixtures: RuntimeFixtures,
  guard: DockerBuildGuard,
  catalogPath: string,
  endpointUrl: string,
  agent: ShippedManagedImageAgent,
  contract: ManagedImageContractV1,
): Promise<void> {
  const { artifacts, cleanup, host, lifecycle, progress, sandbox } = fixtures;
  const sandboxName = SANDBOX_NAMES[agent];
  const env = commandEnv(guard, catalogPath, endpointUrl);
  cleanup.trackDisposable(`delete OpenShell sandbox ${sandboxName}`, () =>
    sandbox.cleanupSandbox(sandboxName, { env, timeoutMs: 60_000 }),
  );
  cleanup.trackSandbox(host, sandboxName, { env, timeoutMs: 3 * 60_000 });
  await preclean(host, lifecycle, sandbox, sandboxName, env);

  enterOnboardPhase(progress, agent);
  const onboard = await host.nemoclaw(
    managedActivationOnboardArgs(catalogPath, agent, sandboxName),
    {
      artifactName: `managed-activation-onboard-${agent}`,
      env,
      redactionValues: [API_KEY],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
  if (onboard.exitCode !== 0) {
    await captureManagedImageOnboardPairingDiagnostics(sandbox, agent, sandboxName, env);
    await collectOnboardFailureDockerDiagnostics(artifacts, host, agent, sandboxName, env);
  }
  expect(onboard.exitCode, resultText(onboard)).toBe(0);
  expectManagedReceipt(sandboxName, contract);
  await host.expectListed(sandboxName, { env });
  await host.expectStatus(sandboxName, { env, timeoutMs: 120_000 });
  await sandbox.expectListed(sandboxName, { env });
  await runAgentTurn(sandbox, agent, sandboxName, "before", env);
  const marker = `managed-activation-${agent}-${Date.now()}`;
  const writeMarker = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      `umask 077; printf '%s\\n' ${shellQuote(marker)} > /sandbox/.nemoclaw-managed-activation-marker; sync`,
    ),
    {
      artifactName: `${agent}-write-durable-marker`,
      env,
      timeoutMs: 30_000,
    },
  );
  expect(writeMarker.exitCode, resultText(writeMarker)).toBe(0);

  enterRecoveryPhase(progress, agent);
  await lifecycle.restartGatewayRuntime({ delayMs: 2_000, sandboxName });
  await lifecycle.waitForGatewayConnected({ attempts: 60, intervalMs: 5_000 });
  await lifecycle.assertSandboxReadyAfterGatewayRestart(sandboxName, {
    artifactNamePrefix: `${agent}-post-restart-ready`,
    env,
  });
  expectManagedReceipt(sandboxName, contract);
  const readMarker = await sandbox.exec(
    sandboxName,
    ["cat", "/sandbox/.nemoclaw-managed-activation-marker"],
    {
      artifactName: `${agent}-read-durable-marker`,
      env,
      timeoutMs: 30_000,
    },
  );
  expect(readMarker.exitCode, resultText(readMarker)).toBe(0);
  expect(readMarker.stdout.trim()).toBe(marker);
  await runAgentTurn(sandbox, agent, sandboxName, "after", env);

  enterCleanupPhase(progress, agent);
  const destroy = await host.nemoclaw([sandboxName, "destroy", "--yes", "--no-cleanup-gateway"], {
    artifactName: `managed-activation-destroy-${agent}`,
    env,
    timeoutMs: 5 * 60_000,
  });
  expect(destroy.exitCode, resultText(destroy)).toBe(0);
  await verifyExactCleanup(host, sandbox, sandboxName, env);
}

export async function qualifyManagedImageActivation(fixtures: RuntimeFixtures): Promise<void> {
  const { artifacts, cleanup, host, progress } = fixtures;
  progress.phase("validate exact candidate catalog and host runtime");
  const catalogPath = requiredCatalogPath();
  const contracts = exactCatalog(catalogPath);
  const guard = createDockerBuildGuard();
  cleanup.trackDisposable("remove managed activation Docker guard", guard.dispose);
  cleanup.trackGateway(host, GATEWAY, { env: guard.env, timeoutMs: 60_000 });
  const docker = await host.command("docker", ["info"], {
    artifactName: "managed-activation-docker-info",
    env: guard.env,
    timeoutMs: 30_000,
  });
  expect(docker.exitCode, resultText(docker)).toBe(0);
  const inference = await startFakeOpenAiCompatibleServer({
    apiKey: API_KEY,
    chatContent: "PONG",
    host: "0.0.0.0",
    model: MODEL,
    progress,
    publicHost: "host.openshell.internal",
    requireAuth: true,
    requireAuthModels: true,
  });
  cleanup.trackDisposable("close managed activation inference responder", async () => {
    await artifacts.writeJson("compatible-inference-requests.json", inference.requests());
    await inference.close();
  });

  for (const agent of SHIPPED_MANAGED_IMAGE_AGENTS) {
    await qualifyAgent(
      fixtures,
      guard,
      catalogPath,
      inference.baseUrl,
      agent,
      contracts.get(agent)!,
    );
  }

  progress.phase("prove buildless all-agent activation");
  const trace = fs.existsSync(guard.tracePath) ? fs.readFileSync(guard.tracePath, "utf8") : "";
  assertNoDockerfileBuild(trace);
  const chatRequests = inference
    .requests()
    .filter((request) => request.method === "POST" && request.path === "/v1/chat/completions");
  expect(chatRequests.length).toBeGreaterThanOrEqual(SHIPPED_MANAGED_IMAGE_AGENTS.length * 2);
  expect(chatRequests.every((request) => request.auth === "ok" && request.model === MODEL)).toBe(
    true,
  );
  await artifacts.writeText("docker-argv.log", trace);
  await artifacts.writeJson("managed-image-activation-summary.json", {
    agents: SHIPPED_MANAGED_IMAGE_AGENTS,
    agentTurns: chatRequests.length,
    buildCommands: 0,
    catalog: [...contracts.values()].map((contract) => ({
      agent: contract.agent,
      reference: contract.reference,
      revision: contract.source.revision,
      cohort: contract.source.cohort,
    })),
    lifecycle: ["onboard", "agent-turn", "gateway-restart", "reconcile", "agent-turn", "destroy"],
  });
  await artifacts.target.complete({
    id: "managed-image-activation",
    agents: SHIPPED_MANAGED_IMAGE_AGENTS,
    buildCommands: 0,
    exactPublishedDigests: [...contracts.values()].map((contract) => contract.reference),
  });
}
