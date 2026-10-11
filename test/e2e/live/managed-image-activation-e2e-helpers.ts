// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveSandboxHealthProbeUrl } from "../../../src/lib/actions/sandbox/forward-recovery.ts";
import { shellQuote } from "../../../src/lib/core/shell-quote.ts";
import { resolveGatewayLogPathForPort } from "../../../src/lib/onboard/gateway/state-dir.ts";
import {
  type ManagedImagePlatform,
  type ManagedImageContractCatalog,
  type ManagedImageContractV1,
  managedImagePlatformForNodeArchitecture,
  parseManagedImageContractV1,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import {
  EXTERNAL_IMAGE_AGENTS,
  type ExternalImageAgent,
} from "../../../src/lib/onboard/workload/source.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { approveOpenClawAdminScope } from "./openclaw-admin-scope.ts";
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
  type ContainerBuildGuard,
  assertNoLocalImageBuild,
  countLocalImageBuildCommands,
  createContainerBuildGuard,
} from "../fixtures/docker-build-guard.ts";
import { startFakeOpenAiCompatibleServer } from "../fixtures/fake-openai-compatible.ts";
import { captureIssue4462FailureDiagnostics } from "../fixtures/issue-4462-diagnostics.ts";
import { initializeGatewayForCleanup } from "../fixtures/gateway-runtime-start.ts";
import type { LifecyclePhaseFixture } from "../fixtures/phases/lifecycle.ts";
import { pollUntil } from "../fixtures/polling.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { createDockerRuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/docker.ts";
import { createCurrentPodmanRuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/podman.ts";
import { managedStartupStateRoots } from "../../../src/lib/onboard/managed-startup/state-roots.ts";
import {
  prepareManagedStateVolumes,
  preflightManagedStateVolumes,
} from "../../../src/lib/onboard/managed-workload/managed-state-volumes.ts";
import { type MigrationEngine } from "../../../src/lib/onboard/managed-workload/managed-state-volume-migration.ts";
import {
  MANAGED_STATE_COPY_IMAGE,
  managedStateVolumeMountArgs,
} from "../../../src/lib/onboard/managed-workload/managed-state-volume-copy.ts";

const API_KEY = "nemoclaw-managed-activation-e2e-key";

/** Real engine/provider evidence; deterministic identity and failure matrices stay in unit tests. */
export async function qualifyManagedVolumeMigration(
  { artifacts, cleanup }: Pick<RuntimeFixtures, "artifacts" | "cleanup">,
  phases: { copy: () => void; evidence: () => void },
): Promise<void> {
  const runtimeProvider =
    process.env.NEMOCLAW_GATEWAY_RUNTIME === "podman"
      ? createCurrentPodmanRuntimeProviderBundle()
      : createDockerRuntimeProviderBundle();
  // Both selected built-in factories expose the container engine; no provider registry input is used.
  const engine = runtimeProvider.containerEngine as Extract<
    typeof runtimeProvider.containerEngine,
    { supported: true }
  >;
  const volumes = new Set<string>();
  const helpers = new Set<string>();
  let unresolvedHelperCreation = false;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-volume-e2e-"));
  const run: MigrationEngine = (args, timeout) => {
    const previouslyUnresolved = unresolvedHelperCreation;
    if (args[0] === "create") unresolvedHelperCreation = true;
    if (args[0] === "volume" && args[1] === "create") volumes.add(args.at(-1)!);
    const result = engine.capture("workload-cleanup", args, Math.min(timeout ?? 30_000, 120_000));
    if (args[0] === "create") {
      const id = String(result.stdout ?? "").trim();
      if (result.status === 0 && /^[a-f0-9]{64}$/u.test(id)) {
        helpers.add(id);
        unresolvedHelperCreation = previouslyUnresolved;
      }
    }
    if (result.status === 0 && args[0] === "rm") helpers.delete(args.at(-1)!);
    return result;
  };
  const command = (args: readonly string[]) => {
    const result = run(args, 120_000);
    if (result.status !== 0 || result.error)
      throw new Error(
        `Volume qualification command ${args[0]} failed: ${String(result.stderr ?? result.error ?? "")}`,
      );
    return String(result.stdout ?? "").trim();
  };
  cleanup.add("remove only the volume qualification fixtures", () => {
    for (const helper of helpers) command(["rm", "--force", helper]);
    if (unresolvedHelperCreation)
      throw new Error("Fixture helper creation was ambiguous; cleanup is not established");
    for (const volume of volumes) command(["volume", "rm", volume]);
    const remaining = command(["volume", "ls", "--format", "{{.Name}}"]);
    expect(remaining.split(/\r?\n/u).filter((name) => volumes.has(name))).toEqual([]);
    fs.rmSync(stateDir, { recursive: true });
  });
  const root = managedStartupStateRoots({
    agent: "openclaw",
    sandboxName: `volume-e2e-${randomUUID()}`,
    agentIdentity: { uid: 1000, gid: 1000 },
  })[0]!;
  const input = { roots: [root] };
  const deps = { runtimeProvider, migrationStateDir: stateDir, runMigrationEngine: run };
  command(["pull", "--quiet", MANAGED_STATE_COPY_IMAGE]);
  command([
    "volume",
    "create",
    ...Object.entries(root.ownershipLabels).flatMap(([key, value]) => [
      "--label",
      `${key}=${value}`,
    ]),
    root.resourceIdentity,
  ]);
  const marker = randomUUID();
  const probe = (volume: string, program: string, readonly = true) => {
    const id = command([
      "create",
      "--name",
      `nemoclaw-volume-probe-${randomUUID()}`,
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      ...managedStateVolumeMountArgs(runtimeProvider.identity.id, volume, "/state", readonly),
      "--entrypoint",
      "/usr/local/bin/node",
      MANAGED_STATE_COPY_IMAGE,
      "-e",
      program,
    ]);
    try {
      return command(["start", "--attach", id]);
    } finally {
      command(["rm", "--force", id]);
    }
  };
  probe(
    root.resourceIdentity,
    `const fs=require("node:fs"); fs.writeFileSync("/state/marker", ${JSON.stringify(marker)}); fs.chownSync("/state/marker",1000,1000); fs.chmodSync("/state/marker",0o640); fs.symlinkSync("marker","/state/link");`,
    false,
  );
  const readback = `const fs=require("node:fs"); const s=fs.lstatSync("/state/marker"); process.stdout.write(JSON.stringify([fs.readFileSync("/state/marker","utf8"),s.uid,s.gid,s.mode,fs.readlinkSync("/state/link")]));`;
  const before = probe(root.resourceIdentity, readback);
  phases.copy();
  // The process really exits nonzero; no mocked success or synthetic filesystem is involved.
  const failCopy: MigrationEngine = (args, timeout) =>
    run(args[0] === "create" ? [...args.slice(0, -1), "process.exit(42)"] : args, timeout);
  expect(() =>
    prepareManagedStateVolumes(input, { ...deps, runMigrationEngine: failCopy }),
  ).toThrow("copy did not finish");
  preflightManagedStateVolumes(input, deps);
  const scope = prepareManagedStateVolumes(input, deps)!;
  scope.commit();
  const selected = scope.mounts[0]!.source;
  expect(selected).not.toBe(root.resourceIdentity);
  expect([probe(root.resourceIdentity, readback), probe(selected, readback)]).toEqual([
    before,
    before,
  ]);
  phases.evidence();
  await artifacts.writeJson("managed-volume-migration.json", {
    provider: runtimeProvider.identity.id,
    source: root.resourceIdentity,
    selected,
    failedCopyRejected: true,
    contentAndMetadataPreserved: true,
    originalRetained: true,
  });
}
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
const EXTERNAL_IMAGE_SANDBOX_NAMES: Record<ExternalImageAgent, string> = {
  openclaw: "ext-img-openclaw",
  hermes: "ext-img-hermes",
};
type ContainerEngine = "docker" | "podman";
type RuntimeFixtures = {
  readonly artifacts: ArtifactSink;
  readonly cleanup: CleanupRegistry;
  readonly host: HostCliClient;
  readonly lifecycle: LifecyclePhaseFixture;
  readonly progress: TestProgress;
  readonly sandbox: SandboxClient;
};
type ManagedActivationPhases = {
  readonly agents: Record<
    ShippedManagedImageAgent,
    { onboard: () => void; publicLifecycle: () => void; cleanup: () => void }
  >;
  readonly hermesSecretBoundary: () => void;
  readonly externalImages: () => void;
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

export function externalImageActivationAgents(
  _containerEngine: ContainerEngine,
): readonly ExternalImageAgent[] {
  return EXTERNAL_IMAGE_AGENTS;
}

export function externalImageActivationOnboardArgs(
  reference: string,
  agent: ExternalImageAgent,
  sandboxName: string,
): string[] {
  return [
    "onboard",
    "--from-image",
    reference,
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
  const contracts = new Map<ShippedManagedImageAgent, ManagedImageContractV1>();
  for (const agent of SHIPPED_MANAGED_IMAGE_AGENTS) {
    // The parser rejects a platform mismatch, including null on an unsupported host.
    const contract = parseManagedImageContractV1(document[agent], agent, platform!);
    contracts.set(agent, contract);
  }
  // Catalog shape and cohort rejection belong to the production loader's source tests.
  return contracts;
}

function commandEnv(
  guard: ContainerBuildGuard,
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
  healthProbeUrl = "http://127.0.0.1:18789/health",
): TrustedSandboxShellScript | null {
  if (agent !== "openclaw" || phase !== "after") return null;

  return trustedSandboxShellScript(`
deadline=$(( $(date +%s) + ${OPENCLAW_POST_RESTART_READY_TIMEOUT_SECONDS} ))
last_status=000
while [ "$(date +%s)" -lt "$deadline" ]; do
  last_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 2 ${shellQuote(healthProbeUrl)} || true)"
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

interface ExternalImageRegistryDocument {
  sandboxes?: Record<
    string,
    { toolDisclosure?: "progressive" | "direct"; workload?: Record<string, unknown> }
  >;
}

function externalImageRegistryPath(): string {
  return path.join(os.homedir(), ".nemoclaw", "sandboxes.json");
}

function registryDocument(): ExternalImageRegistryDocument {
  const registryPath = externalImageRegistryPath();
  if (!fs.existsSync(registryPath)) return {};
  return JSON.parse(fs.readFileSync(registryPath, "utf8")) as ExternalImageRegistryDocument;
}

function replaceExternalImageReceipt(sandboxName: string, workload: Record<string, unknown>): void {
  const registryPath = externalImageRegistryPath();
  const registry = registryDocument();
  const entry = registry.sandboxes?.[sandboxName];
  if (!entry) return;
  entry.workload = workload;
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

export function normalizeExternalImageRuntimeId(
  containerEngine: ContainerEngine,
  value: string,
): string {
  const normalized = value.trim();
  if (containerEngine === "podman" && /^[a-f0-9]{64}$/u.test(normalized)) {
    return `sha256:${normalized}`;
  }
  return normalized;
}

async function inspectRuntimeImageId(
  host: HostCliClient,
  containerEngine: ContainerEngine,
  reference: string,
  artifactName: string,
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<HostCliClient["command"]>>> {
  const result = await host.command(
    containerEngine,
    ["image", "inspect", "--format", "{{.Id}}", reference],
    {
      artifactName,
      env,
      timeoutMs: 30_000,
    },
  );
  return {
    ...result,
    stdout: normalizeExternalImageRuntimeId(containerEngine, result.stdout),
  };
}

export async function inspectRuntimeSandboxContainerId(
  host: HostCliClient,
  containerEngine: ContainerEngine,
  sandboxName: string,
  artifactName: string,
  env: NodeJS.ProcessEnv,
): Promise<Awaited<ReturnType<HostCliClient["command"]>>> {
  return await host.command(
    containerEngine,
    [
      "ps",
      "-aq",
      "--no-trunc",
      "--filter",
      `label=openshell.ai/sandbox-name=${sandboxName}`,
      "--filter",
      "label=openshell.ai/isolation-role=sandbox",
    ],
    { artifactName, env, timeoutMs: 30_000 },
  );
}

function expectManagedReceipt(sandboxName: string, contract: ManagedImageContractV1): void {
  const workload = registryDocument().sandboxes?.[sandboxName]?.workload;
  expect(workload).toMatchObject({
    kind: "managed-image",
    reference: contract.reference,
    release: contract.source.release,
    sourceRevision: contract.source.revision,
    sourceCohort: contract.source.cohort,
  });
}

export function externalImageActivationMatches(input: {
  readonly agent: ExternalImageAgent;
  readonly reference: string;
  readonly platform: ManagedImagePlatform;
  readonly onboardExitCode: number | null;
  readonly destroyExitCode: number | null;
  readonly beforeInspectExitCode: number | null;
  readonly afterInspectExitCode: number | null;
  readonly beforeImageId: string;
  readonly afterImageId: string;
  readonly toolDisclosure: unknown;
  readonly receipt: unknown;
}): boolean {
  const receipt = input.receipt;
  return (
    input.onboardExitCode === 0 &&
    input.destroyExitCode === 0 &&
    input.beforeInspectExitCode === 0 &&
    input.afterInspectExitCode === 0 &&
    /^sha256:[0-9a-f]{64}$/u.test(input.beforeImageId) &&
    input.afterImageId === input.beforeImageId &&
    input.toolDisclosure === "progressive" &&
    typeof receipt === "object" &&
    receipt !== null &&
    !Array.isArray(receipt) &&
    (receipt as Record<string, unknown>).schemaVersion === 1 &&
    (receipt as Record<string, unknown>).kind === "external-image" &&
    (receipt as Record<string, unknown>).reference === input.reference &&
    (receipt as Record<string, unknown>).platform === input.platform &&
    (receipt as Record<string, unknown>).runtimeImageContentId === input.beforeImageId &&
    (receipt as Record<string, unknown>).shared === true
  );
}

async function runAgentTurn(
  sandbox: SandboxClient,
  agent: ShippedManagedImageAgent,
  sandboxName: string,
  phase: "before" | "boundary" | "after",
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const command = agentTurnCommand(agent, `managed-${agent}-${phase}-${Date.now()}`);
  const postRestartScript = managedActivationPostRestartAgentTurnScript(
    agent,
    phase,
    command,
    agent === "openclaw" && phase === "after"
      ? resolveSandboxHealthProbeUrl(sandboxName)
      : undefined,
  );
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

export async function verifyExactCleanup(
  host: HostCliClient,
  sandbox: SandboxClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const containerEngine = env.NEMOCLAW_GATEWAY_RUNTIME === "podman" ? "podman" : "docker";
  await pollUntil({
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
}

export async function collectOnboardFailureRuntimeDiagnostics(
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
  guard: ContainerBuildGuard,
  catalogPath: string,
  endpointUrl: string,
  agent: ShippedManagedImageAgent,
  contract: ManagedImageContractV1,
  phases: ManagedActivationPhases,
): Promise<void> {
  const { artifacts, cleanup, host, lifecycle, sandbox } = fixtures;
  const sandboxName = SANDBOX_NAMES[agent];
  const env = commandEnv(guard, catalogPath, endpointUrl);
  cleanup.trackDisposable(`delete OpenShell sandbox ${sandboxName}`, () =>
    sandbox.cleanupSandbox(sandboxName, { env, timeoutMs: 60_000 }),
  );
  cleanup.trackSandbox(host, sandboxName, { env, timeoutMs: 3 * 60_000 });
  await preclean(host, lifecycle, sandbox, sandboxName, env);

  phases.agents[agent].onboard();
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
    await collectOnboardFailureRuntimeDiagnostics(artifacts, host, agent, sandboxName, env);
  }
  expect(onboard.exitCode, resultText(onboard)).toBe(0);
  if (agent === "openclaw") {
    await approveOpenClawAdminScope(host, sandbox, sandboxName, env, [API_KEY]);
  }
  await runAgentTurn(sandbox, agent, sandboxName, "before", env);
  if (agent === "openclaw") await runOpenClawSubagentTurn(sandbox, sandboxName, env);
  if (agent === "hermes") {
    phases.hermesSecretBoundary();
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

  phases.agents[agent].publicLifecycle();
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

  phases.agents[agent].cleanup();
  await sandbox.cleanupSandbox(sandboxName, {
    artifactName: `managed-activation-openshell-delete-${agent}`,
    env,
    timeoutMs: 120_000,
  });
  await verifyExactCleanup(host, sandbox, sandboxName, env);
}

async function qualifyExternalImage(
  fixtures: RuntimeFixtures,
  guard: ContainerBuildGuard,
  containerEngine: ContainerEngine,
  catalogPath: string,
  endpointUrl: string,
  agent: ExternalImageAgent,
  contract: ManagedImageContractV1,
): Promise<{
  readonly agent: ExternalImageAgent;
  readonly reference: string;
  readonly platform: ManagedImagePlatform;
  readonly runtimeImageContentId: string;
  readonly ready: true;
  readonly retainedAfterDestroy: boolean;
  readonly rebuilt: boolean;
  readonly verified: boolean;
}> {
  const { artifacts, cleanup, host, lifecycle, sandbox } = fixtures;
  const sandboxName = EXTERNAL_IMAGE_SANDBOX_NAMES[agent];
  const env = commandEnv(guard, catalogPath, endpointUrl);
  cleanup.trackDisposable(`delete external-image sandbox ${sandboxName}`, () =>
    sandbox.cleanupSandbox(sandboxName, { env, timeoutMs: 60_000 }),
  );
  cleanup.trackSandbox(host, sandboxName, { env, timeoutMs: 3 * 60_000 });
  await preclean(host, lifecycle, sandbox, sandboxName, env);

  const onboard = await host.nemoclaw(
    externalImageActivationOnboardArgs(contract.reference, agent, sandboxName),
    {
      artifactName: `external-image-onboard-${agent}`,
      env,
      redactionValues: [API_KEY],
      timeoutMs: ONBOARD_TIMEOUT_MS,
    },
  );
  if (onboard.exitCode !== 0) {
    await captureManagedImageOnboardPairingDiagnostics(sandbox, agent, sandboxName, env);
    await collectOnboardFailureRuntimeDiagnostics(artifacts, host, agent, sandboxName, env);
    return Promise.reject(
      new Error(`external image onboard ${agent} failed:\n${resultText(onboard)}`),
    );
  }
  await lifecycle.waitForSandboxReadyAfterGatewayRestart(sandboxName, {
    artifactNamePrefix: `external-image-${agent}-ready`,
    env,
  });
  await runAgentTurn(sandbox, agent, sandboxName, "before", env);

  const beforeInspection = await inspectRuntimeImageId(
    host,
    containerEngine,
    contract.reference,
    `external-image-${agent}-identity-before-lifecycle`,
    env,
  );
  let registryEntry = registryDocument().sandboxes?.[sandboxName];
  let receipt = registryEntry?.workload;
  let rebuilt = false;
  let identityDriftRejected = false;

  if (agent === "openclaw" && !receipt) {
    return Promise.reject(
      new Error("external-image OpenClaw receipt missing before identity drift validation"),
    );
  }
  if (agent === "openclaw" && receipt) {
    const sourceContainer = await inspectRuntimeSandboxContainerId(
      host,
      containerEngine,
      sandboxName,
      "external-image-openclaw-container-before-drifted-rebuild",
      env,
    );
    replaceExternalImageReceipt(sandboxName, {
      ...receipt,
      runtimeImageContentId: `sha256:${"0".repeat(64)}`,
    });
    try {
      const rejectedRebuild = await host.nemoclaw([sandboxName, "rebuild", "--yes"], {
        artifactName: "external-image-openclaw-rebuild-rejects-identity-drift",
        env,
        redactionValues: [API_KEY],
        timeoutMs: 10 * 60_000,
      });
      const retainedContainer = await inspectRuntimeSandboxContainerId(
        host,
        containerEngine,
        sandboxName,
        "external-image-openclaw-container-after-drifted-rebuild",
        env,
      );
      identityDriftRejected =
        rejectedRebuild.exitCode !== 0 &&
        resultText(rejectedRebuild).includes(
          "the inspected image identity does not match the durable external-image receipt",
        ) &&
        sourceContainer.exitCode === 0 &&
        retainedContainer.exitCode === 0 &&
        /^[a-f0-9]{12,64}$/u.test(sourceContainer.stdout.trim()) &&
        retainedContainer.stdout.trim() === sourceContainer.stdout.trim();
    } finally {
      replaceExternalImageReceipt(sandboxName, receipt);
    }
  }

  const rebuild = await host.nemoclaw([sandboxName, "rebuild", "--yes"], {
    artifactName: `external-image-${agent}-rebuild`,
    env,
    redactionValues: [API_KEY],
    timeoutMs: ONBOARD_TIMEOUT_MS,
  });
  if (rebuild.exitCode === 0) {
    await lifecycle.waitForSandboxReadyAfterGatewayRestart(sandboxName, {
      artifactNamePrefix: `external-image-${agent}-ready-after-rebuild`,
      env,
    });
    if (agent === "openclaw") {
      // Rebuild rotates the machine-local pairing authority instead of
      // restoring it. Explicitly approve the replacement's fresh admin scope
      // before exercising the same privileged CLI boundary again.
      await approveOpenClawAdminScope(host, sandbox, sandboxName, env, [API_KEY]);
    }
    await runAgentTurn(sandbox, agent, sandboxName, "after", env);
    rebuilt = true;
  }
  registryEntry = registryDocument().sandboxes?.[sandboxName];
  receipt = registryEntry?.workload;

  const destroy = await host.destroySandbox(sandboxName, {
    artifactName: `external-image-destroy-${agent}`,
    env,
    redactionValues: [API_KEY],
    timeoutMs: 15 * 60_000,
  });
  await verifyExactCleanup(host, sandbox, sandboxName, env);
  const afterInspection = await inspectRuntimeImageId(
    host,
    containerEngine,
    contract.reference,
    `external-image-${agent}-identity-after-destroy`,
    env,
  );
  const imageId = beforeInspection.stdout.trim();
  const retainedImageId = afterInspection.stdout.trim();
  const verified = externalImageActivationMatches({
    agent,
    reference: contract.reference,
    platform: contract.platform,
    onboardExitCode: onboard.exitCode,
    destroyExitCode: destroy.exitCode,
    beforeInspectExitCode: beforeInspection.exitCode,
    afterInspectExitCode: afterInspection.exitCode,
    beforeImageId: imageId,
    afterImageId: retainedImageId,
    toolDisclosure: registryEntry?.toolDisclosure,
    receipt,
  });

  return {
    agent,
    reference: contract.reference,
    platform: contract.platform,
    runtimeImageContentId: imageId,
    ready: true,
    retainedAfterDestroy:
      afterInspection.exitCode === 0 && retainedImageId !== "" && retainedImageId === imageId,
    rebuilt,
    verified: verified && rebuilt && (agent !== "openclaw" || identityDriftRejected),
  };
}

export async function qualifyManagedImageActivation(
  fixtures: RuntimeFixtures,
  phases: ManagedActivationPhases,
): Promise<void> {
  const { artifacts, cleanup, host, progress } = fixtures;
  const catalogPath = requiredCatalogPath();
  const contracts = exactCatalog(catalogPath);
  const containerEngine: ContainerEngine =
    process.env.NEMOCLAW_GATEWAY_RUNTIME === "podman" ? "podman" : "docker";
  const guard = createContainerBuildGuard(containerEngine);
  cleanup.trackDisposable(
    `remove managed activation ${containerEngine} build guard`,
    guard.dispose,
  );
  cleanup.trackGateway(host, GATEWAY, { env: guard.env, timeoutMs: 60_000 });
  await host.command(containerEngine, ["info"], {
    artifactName: `managed-activation-${containerEngine}-info`,
    env: guard.env,
    timeoutMs: 30_000,
  });
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
      phases,
    );
  }

  phases.externalImages();
  const externalImages = [];
  for (const agent of externalImageActivationAgents(containerEngine)) {
    externalImages.push(
      await qualifyExternalImage(
        fixtures,
        guard,
        containerEngine,
        catalogPath,
        inference.baseUrl,
        agent,
        contracts.get(agent)!,
      ),
    );
  }
  const trace = fs.existsSync(guard.tracePath) ? fs.readFileSync(guard.tracePath, "utf8") : "";
  const buildCommands = countLocalImageBuildCommands(trace);
  assertNoLocalImageBuild(trace, containerEngine);
  await artifacts.writeText(`${containerEngine}-argv.log`, trace);
  await artifacts.writeJson("external-image-activation-summary.json", {
    agents: externalImages,
    buildCommands,
    containerEngine,
  });
  const chatRequests = inference
    .requests()
    .filter((request) => request.method === "POST" && request.path === "/v1/chat/completions");
  expect(
    chatRequests.length >= SHIPPED_MANAGED_IMAGE_AGENTS.length * 2 &&
      chatRequests.every((request) => request.auth === "ok" && request.model === MODEL) &&
      chatRequests.some((request) => request.requestCanaryPresent === true) &&
      chatRequests.some((request) => request.toolResultPresent === true) &&
      externalImages.every((image) => image.verified),
  ).toBe(true);
  await artifacts.writeJson("managed-image-activation-summary.json", {
    agents: SHIPPED_MANAGED_IMAGE_AGENTS,
    agentTurns: chatRequests.length,
    buildCommands,
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
      "external-image-onboard",
      "external-image-identity-drift-rejection",
      "external-image-rebuild",
      "external-image-agent-turn",
      "external-image-destroy",
    ],
  });
  await artifacts.target.complete({
    id: "managed-image-activation",
    agents: SHIPPED_MANAGED_IMAGE_AGENTS,
    buildCommands,
    exactPublishedDigests: [...contracts.values()].map((contract) => contract.reference),
    externalImageDigests: externalImages.map((image) => image.reference),
  });
}
