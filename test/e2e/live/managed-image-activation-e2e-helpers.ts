// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import { resolveGatewayLogPathForPort } from "../../../src/lib/onboard/gateway/state-dir.ts";
import {
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
  managedImagePlatformForNodeArchitecture,
  parseManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import {
  assertExitZero,
  type HostCliClient,
  outputContainsSandbox,
  resultText,
  type SandboxClient,
  type TrustedSandboxShellScript,
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
import { initializeGatewayForCleanup } from "../fixtures/gateway-runtime-start.ts";
import type { LifecyclePhaseFixture } from "../fixtures/phases/lifecycle.ts";
import { pollUntil } from "../fixtures/polling.ts";
import type { TestProgress } from "../fixtures/progress.ts";

const API_KEY = "nemoclaw-managed-activation-e2e-key";
const MODEL = "nemoclaw-managed-activation-model";
const GATEWAY = "nemoclaw";
const AGENT_TIMEOUT_MS = 3 * 60_000;
const ONBOARD_TIMEOUT_MS = 20 * 60_000;
const OPENCLAW_POST_RESTART_READY_TIMEOUT_SECONDS = 60;
const OPENCLAW_POST_RESTART_READY_TIMEOUT_MS =
  (OPENCLAW_POST_RESTART_READY_TIMEOUT_SECONDS + 10) * 1_000;
const HERMES_BOUNDARY_SENTINEL = "SENTINEL_MANAGED_RESTART_RAW_SECRET";
const HERMES_BOUNDARY_BACKUP = "/tmp/nemoclaw-hermes-env-before-restart-refusal";
const MANAGED_ACTIVATION_DELETE_SETTLEMENT_DELAYS_MS = [1_000, 1_000, 1_000] as const;
const ONBOARD_FAILURE_STARTUP_SIGNALS = {
  setupStarted: "Setting up NemoClaw",
} as const;
export const ONBOARD_FAILURE_LOG_ARTIFACT_OPTIONS = Object.freeze({
  persistArtifacts: true as const,
});
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
  const gatewayRuntime = process.env.NEMOCLAW_GATEWAY_RUNTIME === "podman" ? "podman" : "docker";
  return {
    ...guard.env,
    COMPATIBLE_API_KEY: API_KEY,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_COMPAT_MODEL: MODEL,
    NEMOCLAW_ENDPOINT_URL: endpointUrl,
    NEMOCLAW_IGNORE_RUNTIME_RESOURCES: "1",
    NEMOCLAW_GATEWAY_RUNTIME: gatewayRuntime,
    NEMOCLAW_MANAGED_ACTIVATION_CATALOG: catalogPath,
    NEMOCLAW_MODEL: MODEL,
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_PREFERRED_API: "openai-completions",
    NEMOCLAW_PROVIDER: "custom",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    OPENSHELL_DRIVERS: gatewayRuntime,
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

export function managedActivationPostRestartAgentTurnScript(
  agent: ShippedManagedImageAgent,
  phase: "before" | "boundary" | "after",
  command: readonly string[],
): TrustedSandboxShellScript | null {
  if (agent !== "openclaw" || phase !== "after") return null;

  return trustedSandboxShellScript(`
deadline=$(( $(date +%s) + ${OPENCLAW_POST_RESTART_READY_TIMEOUT_SECONDS} ))
last_status=000
while [ "$(date +%s)" -lt "$deadline" ]; do
  last_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 2 http://127.0.0.1:18789/health || true)"
  case "$last_status" in
    200|401) break ;;
  esac
  sleep 2
done
case "$last_status" in
  200|401) ;;
  *)
    printf 'OpenClaw gateway did not become ready after OpenShell restart (last HTTP status: %s)\n' "$last_status" >&2
    exit 1
    ;;
esac
exec ${command.map((argument) => shellQuote(argument)).join(" ")}
`);
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
  phase: "before" | "boundary" | "after",
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const command = agentTurnCommand(agent, `managed-${agent}-${phase}-${Date.now()}`);
  const postRestartScript = managedActivationPostRestartAgentTurnScript(agent, phase, command);
  const options = {
    artifactName: `${agent}-agent-turn-${phase}-restart`,
    env,
    redactionValues: [API_KEY],
    timeoutMs:
      AGENT_TIMEOUT_MS + (postRestartScript === null ? 0 : OPENCLAW_POST_RESTART_READY_TIMEOUT_MS),
  };
  const result =
    postRestartScript === null
      ? await sandbox.exec(sandboxName, command, options)
      : await sandbox.execShell(sandboxName, postRestartScript, options);
  expect(result.exitCode === 0 && /\bPONG\b/iu.test(resultText(result)), resultText(result)).toBe(
    true,
  );
}

export function managedOpenClawSubagentCommand(sessionId: string): string[] {
  return agentTurnCommand("openclaw", sessionId).map((value) =>
    value === "Reply with exactly one word: PONG"
      ? "NEMOCLAW_MANAGED_SUBAGENT: use sessions_spawn once with task 'Reply with exactly one word: PONG', wait for its result, then reply PONG"
      : value,
  );
}

async function runOpenClawSubagentTurn(
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await sandbox.exec(
    sandboxName,
    managedOpenClawSubagentCommand(`managed-openclaw-subagent-${Date.now()}`),
    {
      artifactName: "openclaw-native-loopback-subagent",
      env,
      redactionValues: [API_KEY],
      timeoutMs: AGENT_TIMEOUT_MS,
    },
  );
  expect(result.exitCode === 0 && /\bPONG\b/iu.test(resultText(result)), resultText(result)).toBe(
    true,
  );
}

export function managedActivationOpenClawPluginScript(): string {
  const packageJson = JSON.stringify({
    name: "@nemoclaw/managed-activation-native-plugin",
    version: "1.0.0",
    type: "module",
    main: "index.js",
    files: ["index.js", "openclaw.plugin.json"],
    openclaw: { extensions: ["./index.js"] },
    peerDependencies: { openclaw: ">=2026.7.1" },
  });
  const manifest = JSON.stringify({
    id: "managed-activation-native",
    name: "Managed Activation Native Plugin",
    version: "1.0.0",
    description: "Managed-image native plugin fixture",
    configSchema: { type: "object", properties: {}, additionalProperties: false },
  });
  const entrypoint =
    'export default { id: "managed-activation-native", name: "Managed Activation Native Plugin", version: "1.0.0", register() {} };\n';
  return [
    "source_dir=/sandbox/managed-activation-native-plugin",
    'rm -rf -- "$source_dir"',
    'mkdir -p -- "$source_dir"',
    `printf '%s' ${shellQuote(packageJson)} > "$source_dir/package.json"`,
    `printf '%s' ${shellQuote(manifest)} > "$source_dir/openclaw.plugin.json"`,
    `printf '%s' ${shellQuote(entrypoint)} > "$source_dir/index.js"`,
    'HOME=/sandbox openclaw plugins install --force --accept-capabilities "$source_dir"',
  ].join("\n");
}

function managedActivationNativeStateScript(agent: ShippedManagedImageAgent): string {
  if (agent === "langchain-deepagents-code") return "";
  return agent === "openclaw"
    ? managedActivationOpenClawPluginScript()
    : [
        "plugin=/sandbox/.hermes/plugins/managed-activation-native",
        "package=/sandbox/.hermes/lazy-packages/managed_activation_native",
        'mkdir -p "$plugin" "$package"',
        "printf '%s\\n' 'name: managed-activation-native' 'version: 1.0.0' > \"$plugin/plugin.yaml\"",
        "printf '%s\\n' 'MANAGED_ACTIVATION_NATIVE = \"present\"' 'def register(ctx): pass' > \"$plugin/__init__.py\"",
        "printf '%s\\n' 'MANAGED_ACTIVATION_NATIVE = \"present\"' > \"$package/__init__.py\"",
      ].join("\n");
}

function managedActivationNativeStateReadbackScript(agent: ShippedManagedImageAgent): string {
  if (agent === "langchain-deepagents-code") return "";
  return agent === "openclaw"
    ? "HOME=/sandbox openclaw plugins inspect managed-activation-native --runtime --json >/dev/null"
    : [
        "HERMES_HOME=/sandbox/.hermes hermes plugins list --plain --user >/tmp/managed-activation-native-plugins",
        "grep -Fq 'managed-activation-native' /tmp/managed-activation-native-plugins",
        "/opt/hermes/.venv/bin/python -I /sandbox/.hermes/plugins/managed-activation-native/__init__.py",
        "HERMES_LAZY_INSTALL_TARGET=/sandbox/.hermes/lazy-packages /opt/hermes/.venv/bin/python -I -c 'import hermes_bootstrap, managed_activation_native'",
      ].join("\n");
}

export function managedHermesBoundaryPoisonCommand(): string {
  return `set -eu; cp /sandbox/.hermes/.env ${shellQuote(HERMES_BOUNDARY_BACKUP)}; printf '%s\\n' ${shellQuote(`DEVTEST_API_TOKEN=${HERMES_BOUNDARY_SENTINEL}`)} >> /sandbox/.hermes/.env`;
}

async function proveHermesRestartSecretBoundary(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const poison = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(managedHermesBoundaryPoisonCommand()),
    {
      artifactName: "hermes-poison-env-before-native-restart",
      env,
      redactionValues: [API_KEY, HERMES_BOUNDARY_SENTINEL],
      timeoutMs: 30_000,
    },
  );
  assertExitZero(poison, "prepare Hermes secret-boundary restart refusal");

  const restart = await host.nemoclaw([sandboxName, "gateway", "restart", "--quiet"], {
    artifactName: "hermes-native-restart-secret-boundary-refusal",
    env,
    redactionValues: [API_KEY, HERMES_BOUNDARY_SENTINEL],
    timeoutMs: 60_000,
  });

  const restore = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      `set -eu; cp ${shellQuote(HERMES_BOUNDARY_BACKUP)} /sandbox/.hermes/.env; rm -f ${shellQuote(HERMES_BOUNDARY_BACKUP)}`,
    ),
    {
      artifactName: "hermes-restore-env-after-native-restart-refusal",
      env,
      redactionValues: [API_KEY, HERMES_BOUNDARY_SENTINEL],
      timeoutMs: 30_000,
    },
  );
  assertExitZero(restore, "restore Hermes environment after restart refusal");

  const output = resultText(restart);
  expect(
    restart.exitCode !== 0 &&
      output.includes("secret-boundary") &&
      !output.includes(HERMES_BOUNDARY_SENTINEL),
    output,
  ).toBe(true);
  await runAgentTurn(sandbox, "hermes", sandboxName, "boundary", env);
}

export async function preclean(
  host: HostCliClient,
  lifecycle: LifecyclePhaseFixture,
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await initializeGatewayForCleanup(host, GATEWAY, {
    artifactName: `pre-cleanup-initialize-gateway-${sandboxName}`,
    env,
    timeoutMs: 3 * 60_000,
  });
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

function outputContainsDeletingSandbox(
  result: Parameters<typeof outputContainsSandbox>[0],
  sandboxName: string,
): boolean {
  return resultText(result)
    .replace(/\u001b\[[0-9;]*m/gu, "")
    .split(/\r?\n/u)
    .some((line) => {
      const fields = line.trim().split(/\s+/u);
      return fields[0] === sandboxName && fields.at(-1) === "Deleting";
    });
}

/** Wait only for OpenShell's accepted delete to leave its read-only Deleting phase. */
export async function waitForManagedActivationSandboxDeletion(
  sandbox: Pick<SandboxClient, "list">,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  options: { readonly sleep?: (delayMs: number) => Promise<void> } = {},
): Promise<Awaited<ReturnType<SandboxClient["list"]>>> {
  const wait = options.sleep ?? (async (delayMs: number) => await sleep(delayMs));
  for (let attempt = 1; ; attempt += 1) {
    const observation = await sandbox.list({
      artifactName: `post-destroy-openshell-list-${sandboxName}-attempt-${attempt}`,
      env,
      timeoutMs: 30_000,
    });
    if (observation.exitCode !== 0) return observation;
    if (!outputContainsSandbox(observation, sandboxName)) return observation;
    const delayMs = MANAGED_ACTIVATION_DELETE_SETTLEMENT_DELAYS_MS[attempt - 1];
    if (delayMs === undefined || !outputContainsDeletingSandbox(observation, sandboxName)) {
      return observation;
    }
    await wait(delayMs);
  }
}

export async function waitForManagedActivationSandboxAbsence(
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await pollUntil({
    artifactPrefix: `post-destroy-openshell-list-${sandboxName}`,
    deadlineMs: 30_000,
    delayMs: 1_000,
    probe: async (_attempt, artifactName) => sandbox.list({ artifactName, env, timeoutMs: 10_000 }),
    terminal: (result) =>
      result.exitCode === 0
        ? undefined
        : `list OpenShell sandboxes after managed activation destroy failed: ${resultText(result)}`,
    accept: (result) => !outputContainsSandbox(result, sandboxName),
  });
}

async function verifyExactCleanup(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const containerEngine = env.NEMOCLAW_GATEWAY_RUNTIME === "podman" ? "podman" : "docker";
  const settled = await pollUntil({
    artifactPrefix: `post-destroy-absence-${sandboxName}`,
    deadlineMs: 60_000,
    delayMs: 1_000,
    probe: async (_attempt, artifactName) => {
      const openshellList = await sandbox.list({
        artifactName: `${artifactName}-openshell-list`,
        env,
        timeoutMs: 30_000,
      });
      const containers = await host.command(
        containerEngine,
        ["ps", "-aq", "--filter", `label=openshell.ai/sandbox-name=${sandboxName}`],
        {
          artifactName: `${artifactName}-${containerEngine}-inventory`,
          env,
          timeoutMs: 30_000,
        },
      );
      return { containers, openshellList };
    },
    terminal: ({ containers, openshellList }) => {
      if (openshellList.exitCode !== 0) {
        return `list OpenShell sandboxes after managed activation destroy failed: ${resultText(openshellList)}`;
      }
      if (containers.exitCode !== 0) {
        return `inspect ${containerEngine} inventory after managed activation destroy failed: ${resultText(containers)}`;
      }
      return undefined;
    },
    accept: ({ containers, openshellList }) =>
      !outputContainsSandbox(openshellList, sandboxName) && containers.stdout.trim() === "",
  });
  const { containers, openshellList } = settled.value;
  assertExitZero(openshellList, "list OpenShell sandboxes after managed activation destroy");
  expect(outputContainsSandbox(openshellList, sandboxName), resultText(openshellList)).toBe(false);
  assertExitZero(
    containers,
    `inspect ${containerEngine} inventory after managed activation destroy`,
  );
  expect(containers.stdout.trim(), resultText(containers)).toBe("");
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

function enterPublicLifecyclePhase(progress: TestProgress, agent: ShippedManagedImageAgent): void {
  switch (agent) {
    case "openclaw":
      progress.phase("stop and start OpenClaw through public NemoClaw lifecycle");
      return;
    case "hermes":
      progress.phase("stop and start Hermes through public NemoClaw lifecycle");
      return;
    case "langchain-deepagents-code":
      progress.phase("stop and start Deep Agents Code through public NemoClaw lifecycle");
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

export async function collectOnboardFailureDockerDiagnostics(
  artifacts: ArtifactSink,
  host: HostCliClient,
  agent: ShippedManagedImageAgent,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  artifactRedactionValues: readonly string[] = [API_KEY],
): Promise<void> {
  artifacts.addRedactionValues(artifactRedactionValues);
  const containerEngine = env.NEMOCLAW_GATEWAY_RUNTIME === "podman" ? "podman" : "docker";
  const managedLabel =
    containerEngine === "podman" ? "openshell.managed=true" : "openshell.ai/managed-by=openshell";
  try {
    await host.command(
      "tail",
      [
        "-c",
        "65536",
        resolveGatewayLogPathForPort({
          configured: env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR,
          home: os.homedir(),
          port: 8080,
        }),
      ],
      {
        artifactName: `managed-activation-onboard-failure-${agent}-gateway-log`,
        captureLimitBytes: 65536,
        env,
        redactionValues: [API_KEY],
        timeoutMs: 5_000,
      },
    );
    const inventory = await host.command(
      containerEngine,
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `label=${managedLabel}`,
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
          containerEngine,
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
        const logs = await host.command(containerEngine, ["logs", "--tail", "1000", containerId], {
          artifactName: `managed-activation-onboard-failure-${agent}-container-${index + 1}-logs`,
          captureLimitBytes: 2 * 1024 * 1024,
          env,
          ...ONBOARD_FAILURE_LOG_ARTIFACT_OPTIONS,
          redactionValues: [API_KEY],
          timeoutMs: 30_000,
        });
        if (logs.exitCode !== 0) return;
        const output = `${logs.stdout}\n${logs.stderr}`;
        await artifacts.writeJson(
          `managed-activation-onboard-failure-${agent}-container-${index + 1}-startup-signals.json`,
          summarizeOnboardFailureStartupSignals(output),
        );
        const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-managed-startup-log-"));
        const copiedLog = path.join(copyRoot, "nemoclaw-start.log");
        try {
          const copy = await host.command(
            containerEngine,
            ["cp", `${containerId}:/tmp/nemoclaw-start.log`, copiedLog],
            {
              artifactName: `managed-activation-onboard-failure-${agent}-container-${index + 1}-startup-log-copy`,
              env,
              redactionValues: [API_KEY],
              timeoutMs: 30_000,
            },
          );
          if (copy.exitCode !== 0) return;
          const stat = fs.lstatSync(copiedLog);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return;
          await artifacts.writeText(
            `managed-activation-onboard-failure-${agent}-container-${index + 1}-nemoclaw-start.log`,
            fs.readFileSync(copiedLog, "utf8"),
          );
        } finally {
          fs.rmSync(copyRoot, { recursive: true, force: true });
        }
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
  await runAgentTurn(sandbox, agent, sandboxName, "before", env);
  if (agent === "openclaw") await runOpenClawSubagentTurn(sandbox, sandboxName, env);
  if (agent === "hermes") {
    progress.phase("prove Hermes secret-boundary refusal before native restart");
    await proveHermesRestartSecretBoundary(host, sandbox, sandboxName, env);
  }
  const marker = `managed-activation-${agent}-${Date.now()}`;
  await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      [
        "set -eu",
        `umask 077; printf '%s\\n' ${shellQuote(marker)} > /sandbox/.nemoclaw-managed-activation-marker; sync`,
        managedActivationNativeStateScript(agent),
      ]
        .filter((line) => line !== "")
        .join("\n"),
    ),
    {
      artifactName: `${agent}-write-durable-marker`,
      env,
      timeoutMs: 30_000,
    },
  );

  enterPublicLifecyclePhase(progress, agent);
  const stop = await host.nemoclaw([sandboxName, "stop"], {
    artifactName: `${agent}-public-stop`,
    env,
    redactionValues: [API_KEY],
    timeoutMs: 120_000,
  });
  const start = await host.nemoclaw([sandboxName, "start"], {
    artifactName: `${agent}-public-start`,
    env,
    redactionValues: [API_KEY],
    timeoutMs: 10 * 60_000,
  });
  expect(
    stop.exitCode === 0 && start.exitCode === 0,
    `${resultText(stop)}\n${resultText(start)}`,
  ).toBe(true);
  await lifecycle.waitForSandboxReadyAfterGatewayRestart(sandboxName, {
    artifactNamePrefix: `${agent}-post-public-start-ready`,
    env,
  });
  expectManagedReceipt(sandboxName, contract);
  const readMarker = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      [
        "set -eu",
        'marker="$(cat /sandbox/.nemoclaw-managed-activation-marker)"',
        managedActivationNativeStateReadbackScript(agent),
        'printf "%s\\n" "$marker"',
      ]
        .filter((line) => line !== "")
        .join("\n"),
    ),
    {
      artifactName: `${agent}-read-durable-marker-after-public-lifecycle`,
      env,
      timeoutMs: 30_000,
    },
  );
  expect(
    readMarker.exitCode === 0 && readMarker.stdout.trim() === marker,
    resultText(readMarker),
  ).toBe(true);
  await runAgentTurn(sandbox, agent, sandboxName, "after", env);

  enterCleanupPhase(progress, agent);
  await sandbox.cleanupSandbox(sandboxName, {
    artifactName: `managed-activation-openshell-delete-${agent}`,
    env,
    timeoutMs: 120_000,
  });
  await verifyExactCleanup(host, sandbox, sandboxName, env);
}

export async function qualifyManagedImageActivation(fixtures: RuntimeFixtures): Promise<void> {
  const { artifacts, cleanup, host, progress } = fixtures;
  progress.phase("validate exact candidate catalog and host runtime");
  const catalogPath = requiredCatalogPath();
  const contracts = exactCatalog(catalogPath);
  const containerEngine = process.env.NEMOCLAW_GATEWAY_RUNTIME === "podman" ? "podman" : "docker";
  const guard: DockerBuildGuard =
    containerEngine === "docker"
      ? createDockerBuildGuard()
      : { env: buildAvailabilityProbeEnv(), tracePath: "", dispose: () => undefined };
  cleanup.trackDisposable("remove managed activation build guard", guard.dispose);
  cleanup.trackGateway(host, GATEWAY, { env: guard.env, timeoutMs: 60_000 });
  const runtimeInfo = await host.command(containerEngine, ["info"], {
    artifactName: `managed-activation-${containerEngine}-info`,
    env: guard.env,
    timeoutMs: 30_000,
  });
  expect(runtimeInfo.exitCode, resultText(runtimeInfo)).toBe(0);
  const inference = await startFakeOpenAiCompatibleServer({
    apiKey: API_KEY,
    chatContent: "PONG",
    host: "0.0.0.0",
    model: MODEL,
    progress,
    publicHost: "host.openshell.internal",
    requireAuth: true,
    requireAuthModels: true,
    requestCanaryMarker: "NEMOCLAW_MANAGED_SUBAGENT",
    toolCallOnCanary: {
      name: "sessions_spawn",
      arguments: JSON.stringify({
        task: "Reply with exactly one word: PONG",
        mode: "run",
        cleanup: "delete",
      }),
    },
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
  expect(
    chatRequests.every((request) => request.auth === "ok" && request.model === MODEL) &&
      chatRequests.some((request) => request.requestCanaryPresent === true) &&
      chatRequests.some((request) => request.toolResultPresent === true),
  ).toBe(true);
  await artifacts.writeText("docker-argv.log", trace);
  await artifacts.writeJson("managed-image-activation-summary.json", {
    agents: SHIPPED_MANAGED_IMAGE_AGENTS,
    agentTurns: chatRequests.length,
    buildCommands: 0,
    containerEngine,
    catalog: [...contracts.values()].map((contract) => ({
      agent: contract.agent,
      reference: contract.reference,
      revision: contract.source.revision,
      cohort: contract.source.cohort,
    })),
    lifecycle: [
      "onboard",
      "agent-turn",
      "nemoclaw-stop",
      "nemoclaw-start",
      "native-readiness",
      "durable-marker",
      "agent-turn",
      "openshell-delete",
    ],
  });
  await artifacts.target.complete({
    id: "managed-image-activation",
    agents: SHIPPED_MANAGED_IMAGE_AGENTS,
    buildCommands: 0,
    exactPublishedDigests: [...contracts.values()].map((contract) => contract.reference),
  });
}
