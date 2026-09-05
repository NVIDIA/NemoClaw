// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAgent } from "../../src/lib/agent/onboard.ts";
import { parseOpenShellSandboxId } from "../../src/lib/adapters/openshell/sandbox-identity.ts";
import { createCliOpenShellSandboxObserverFromRunner } from "../../src/lib/adapters/openshell/sandbox-observer-cli.ts";
import { isValidName, NAME_ALLOWED_FORMAT } from "../../src/lib/name-validation.ts";
import {
  type StopHostGatewayResult,
  stopHostGatewayProcesses,
} from "../../src/lib/onboard/host-gateway-process.ts";
import {
  type InitialSandboxPolicy,
  prepareInitialSandboxCreatePolicy,
} from "../../src/lib/onboard/initial-policy.ts";
import {
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  type ManagedBootstrapAdapter,
  type ManagedBootstrapAuthorityStore,
  ManagedBootstrapOwnerCleanupRequiredError,
} from "../../src/lib/onboard/managed-bootstrap/adapter.ts";
import { createDockerManagedBootstrapAdapter } from "../../src/lib/onboard/managed-bootstrap/docker.ts";
import { createDockerManagedBootstrapSurface } from "../../src/lib/onboard/managed-bootstrap/docker-runtime.ts";
import {
  managedImageRuntimeIdentity,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "../../src/lib/onboard/managed-image/contract.ts";
import { encodeManagedStartupProfile } from "../../src/lib/onboard/managed-startup/profile.ts";
import { createManagedStartupRootApplyRequest } from "../../src/lib/onboard/managed-startup/root-apply.ts";
import type {
  RuntimeProviderBundle,
  RuntimeProviderManagedImageBootstrapSurface,
} from "../../src/lib/onboard/runtime-provider/contract.ts";
import { createDockerRuntimeProviderBundle } from "../../src/lib/onboard/runtime-provider/docker.ts";
import { parseLiveSandboxNames } from "../../src/lib/runtime-recovery.ts";
import {
  OPENSHELL_SANDBOX_SUPERVISOR_ARGV,
  prepareSandboxCreateLaunch,
} from "../../src/lib/onboard/sandbox-create-launch.ts";
import {
  resolveDockerStartupCommandPatch,
  runSandboxGpuCreateFlow,
  type SandboxGpuCreateFlowInput,
} from "../../src/lib/onboard/sandbox-gpu-create-flow.ts";
import { createDirectSandboxGpuVerifier } from "../../src/lib/onboard/sandbox-gpu-preflight.ts";
import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "./generate-managed-startup-profile-fixture.mts";
import {
  isManagedImageLocalInferenceKind,
  type ManagedImageLocalInferenceKind,
  resolveManagedImageLocalInferenceRoute,
  withManagedImageLocalInferenceProfile,
} from "./managed-image-protected-runtime-contract.ts";

// This executable owns one protected qualification transaction from sandbox
// creation through exact cleanup. Keep its stateful orchestration and cleanup
// together so no cross-module return path can bypass rollback; stateless route
// and profile policy remains in managed-image-protected-runtime-contract.ts.

const MANAGED_AGENTS = new Set<ShippedManagedImageAgent>(SHIPPED_MANAGED_IMAGE_AGENTS);
const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const GATEWAY_NAME = "nemoclaw";
const GATEWAY_PORT = 8080;
const IMMUTABLE_MANIFEST_REFERENCE_RE = /^([^\s@]+)@(sha256:[a-f0-9]{64})$/u;
const MANAGED_AGENT_BASE_POLICIES: Record<ShippedManagedImageAgent, readonly string[]> = {
  openclaw: ["nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"],
  hermes: ["agents", "hermes", "policy-additions.yaml"],
  "langchain-deepagents-code": ["agents", "langchain-deepagents-code", "policy-additions.yaml"],
};

export const MANAGED_IMAGE_OPENSHELL_SUPERVISOR_ARGV = OPENSHELL_SANDBOX_SUPERVISOR_ARGV;

type ProtectedManagedImageBootstrapInput = Omit<
  NonNullable<SandboxGpuCreateFlowInput["managedBootstrap"]>,
  "expectedSupervisorArgv"
>;

export function createProtectedManagedImageBootstrapInput(
  input: ProtectedManagedImageBootstrapInput,
): NonNullable<SandboxGpuCreateFlowInput["managedBootstrap"]> {
  return Object.freeze({
    ...input,
    expectedSupervisorArgv: MANAGED_IMAGE_OPENSHELL_SUPERVISOR_ARGV,
  });
}

export function protectedManagedStateRootDriverConfig(
  provider: Pick<RuntimeProviderBundle, "workload">,
  mounts: readonly ProtectedManagedStateVolumeMount[],
): string | null {
  if (mounts.length === 0) return null;
  const driverId = provider.workload.managedStateMountDriverId;
  if (!driverId) {
    throw new Error("Protected managed state roots require provider-owned mount projection.");
  }
  return JSON.stringify({ [driverId]: { mounts } });
}

function compactText(value = ""): string {
  return String(value).replace(/\s+/gu, " ").trim();
}

function redactProtectedGpuProof(value: string): string {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <REDACTED>")
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=([^\s]*)/giu, "$1=<REDACTED>");
}

export type ManagedImageOpenShellE2eInputs = {
  agent: ShippedManagedImageAgent;
  image: string;
  sandbox: string;
  gpu?: true;
  localProvider?: ManagedImageLocalInferenceKind;
  model?: string;
  failureInjection?: "bootstrap-completion";
};

export type ManagedImageOpenShellE2eProbeResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type ManagedImageOpenShellE2eProbeContext = {
  readonly input: Readonly<ManagedImageOpenShellE2eInputs>;
  readonly runSandbox: (
    argv: readonly string[],
    timeoutMilliseconds?: number,
  ) => ManagedImageOpenShellE2eProbeResult;
};

export type ManagedImageOpenShellE2eLocalInferenceEvidence = {
  readonly synchronousChat: true;
};

export type ManagedImageOpenShellE2eResult<
  T extends ManagedImageOpenShellE2eLocalInferenceEvidence = never,
> = {
  readonly cleanup: {
    readonly gatewayRemoved: true;
    readonly networkRemoved: true;
    readonly sandboxRemoved: true;
    readonly stateRemoved: true;
  };
  readonly probeEvidence?: T;
};

type Inputs = ManagedImageOpenShellE2eInputs;

type ProtectedManagedStateRoot = {
  readonly mountTarget: string;
  readonly resourceIdentity: string;
  readonly ownershipLabels: Readonly<Record<string, string>>;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly readWrite: boolean;
};

type ProtectedManagedStateVolumeMount = {
  readonly type: "volume";
  readonly source: string;
  readonly target: string;
  readonly read_only: boolean;
};

type ProtectedManagedStateVolumeCleanupResult =
  | { readonly status: "not-applicable" | "absent" | "removed" }
  | {
      readonly status: "not-owned" | "failed";
      readonly detail: string;
      readonly volumeName: string;
    };

type ProtectedManagedStateVolumeScope = {
  readonly mounts: readonly ProtectedManagedStateVolumeMount[];
  cleanupIncompleteCreate(): readonly ProtectedManagedStateVolumeCleanupResult[];
  commit(): void;
};

const MANAGED_IMAGE_E2E_ENVIRONMENT_KEYS = [
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR",
  "NEMOCLAW_GATEWAY_PORT",
  "NEMOCLAW_DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT",
  "OPENSHELL_DOCKER_NETWORK_NAME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "PATH",
] as const;

type OnboardModule = {
  managedWorkloadOnboard: {
    managedStartupStateRoots(input: {
      readonly agent: ShippedManagedImageAgent;
      readonly sandboxName: string;
      readonly agentIdentity: { readonly uid: number; readonly gid: number };
    }): readonly ProtectedManagedStateRoot[];
    managedStartupWorkspaceRoot(input: {
      readonly agent: ShippedManagedImageAgent;
      readonly agentIdentity: { readonly uid: number; readonly gid: number };
    }): { readonly uid: number; readonly gid: number; readonly mode: 0o755 | 0o1775 };
    prepareManagedStateVolumes(
      input: { readonly roots: readonly ProtectedManagedStateRoot[] },
      deps: { readonly runtimeProvider: RuntimeProviderBundle },
    ): ProtectedManagedStateVolumeScope | null;
    removeManagedStateVolumes(
      input: { readonly roots: readonly ProtectedManagedStateRoot[] },
      deps: { readonly runtimeProvider: RuntimeProviderBundle },
    ): readonly ProtectedManagedStateVolumeCleanupResult[];
  };
  openshellArgv(args: string[]): string[];
  runOpenshell(args: string[], opts?: Record<string, unknown>): ReturnType<typeof commandResult>;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string;
  sleepSeconds(seconds: number): void;
  startGatewayForRecovery(options: { gatewayName: string; gatewayPort: number }): Promise<void>;
};

const REQUIRED_ONBOARD_OPERATIONS = [
  "openshellArgv",
  "runOpenshell",
  "runCaptureOpenshell",
  "sleepSeconds",
  "startGatewayForRecovery",
] as const satisfies readonly (keyof OnboardModule)[];

export function resolveManagedImageOnboardModule(onboardImport: unknown): OnboardModule {
  const importRecord =
    typeof onboardImport === "object" && onboardImport !== null
      ? (onboardImport as Record<string, unknown>)
      : null;
  const candidate =
    importRecord && "default" in importRecord ? importRecord.default : onboardImport;
  const candidateRecord =
    typeof candidate === "object" && candidate !== null
      ? (candidate as Record<string, unknown>)
      : null;
  const missing = REQUIRED_ONBOARD_OPERATIONS.filter(
    (operation) => typeof candidateRecord?.[operation] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `managed-image onboard module is missing required operation(s): ${missing.join(", ")}`,
    );
  }
  const managedWorkload = candidateRecord?.managedWorkloadOnboard as
    | Record<string, unknown>
    | undefined;
  if (
    typeof managedWorkload?.managedStartupStateRoots !== "function" ||
    typeof managedWorkload.managedStartupWorkspaceRoot !== "function" ||
    typeof managedWorkload?.prepareManagedStateVolumes !== "function" ||
    typeof managedWorkload.removeManagedStateVolumes !== "function"
  ) {
    throw new Error(
      "managed-image onboard module is missing required managed state-volume operations",
    );
  }
  return candidate as OnboardModule;
}

function cleanupProtectedManagedStateVolumes(input: {
  readonly onboard: OnboardModule | null;
  readonly runtimeProvider: RuntimeProviderBundle | null;
  readonly roots: readonly ProtectedManagedStateRoot[];
  readonly scope: ProtectedManagedStateVolumeScope | null;
  readonly committed: boolean;
}): string[] {
  try {
    let results: readonly ProtectedManagedStateVolumeCleanupResult[] = [];
    if (input.committed && input.onboard && input.runtimeProvider) {
      results = input.onboard.managedWorkloadOnboard.removeManagedStateVolumes(
        { roots: input.roots },
        { runtimeProvider: input.runtimeProvider },
      );
    } else if (!input.committed) {
      results = input.scope?.cleanupIncompleteCreate() ?? [];
    }
    return results.flatMap((result) =>
      result.status === "not-owned" || result.status === "failed"
        ? [`managed state volume ${result.volumeName} cleanup ${result.status}: ${result.detail}`]
        : [],
    );
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

function requiredValue(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${flag} is required`);
  return value;
}

export function parseManagedImageOpenShellE2eInputs(argv: readonly string[]): Inputs {
  const valueFlags = new Set(["--agent", "--image", "--sandbox", "--local-provider", "--model"]);
  const booleanFlags = new Set(["--gpu", "--inject-bootstrap-completion-failure"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] ?? "";
    if (booleanFlags.has(value)) continue;
    if (!valueFlags.has(value)) throw new Error(`unsupported arguments: ${value}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${value} is required`);
    index += 1;
  }
  const agentValue = requiredValue(argv, "--agent");
  if (!MANAGED_AGENTS.has(agentValue as ShippedManagedImageAgent)) {
    throw new Error("--agent must identify a shipped managed-image agent");
  }
  const image = requiredValue(argv, "--image");
  if (!IMMUTABLE_MANIFEST_REFERENCE_RE.test(image)) {
    throw new Error("--image must be an immutable repository@sha256 manifest reference");
  }
  const sandbox = requiredValue(argv, "--sandbox");
  if (!isValidName(sandbox)) {
    throw new Error(`--sandbox must use ${NAME_ALLOWED_FORMAT}`);
  }
  const gpu = argv.includes("--gpu");
  const localProviderValue = argv.includes("--local-provider")
    ? requiredValue(argv, "--local-provider")
    : null;
  if (localProviderValue && !isManagedImageLocalInferenceKind(localProviderValue)) {
    throw new Error("--local-provider must be one of: llama-cpp, ollama, nim, vllm");
  }
  const model = argv.includes("--model") ? requiredValue(argv, "--model") : null;
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u.test(model)) {
    throw new Error("--model must be one bounded model identifier");
  }
  const failureInjection = argv.includes("--inject-bootstrap-completion-failure");
  if (gpu && (!localProviderValue || !model)) {
    throw new Error("--gpu requires --local-provider and --model");
  }
  if (!gpu && (localProviderValue || model) && localProviderValue !== "llama-cpp") {
    throw new Error("--local-provider and --model require --gpu except for llama-cpp");
  }
  if (localProviderValue === "llama-cpp" && (!model || gpu)) {
    throw new Error("llama-cpp requires --model and must not grant direct sandbox GPU access");
  }
  if (failureInjection && (gpu || localProviderValue)) {
    throw new Error(
      "bootstrap failure injection cannot be combined with local-inference qualification",
    );
  }
  return {
    agent: agentValue as ShippedManagedImageAgent,
    image,
    sandbox,
    ...(gpu ? { gpu: true as const } : {}),
    ...(localProviderValue
      ? { localProvider: localProviderValue as ManagedImageLocalInferenceKind }
      : {}),
    ...(model ? { model } : {}),
    ...(failureInjection ? { failureInjection: "bootstrap-completion" as const } : {}),
  };
}

export function managedImageOpenShellBasePolicyPath(agent: ShippedManagedImageAgent): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    ...MANAGED_AGENT_BASE_POLICIES[agent],
  );
}

export interface ManagedImageCommandResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
}

export type ManagedImageCommandRunner = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout?: number,
) => ManagedImageCommandResult;

function commandResult(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout = 20_000,
): ManagedImageCommandResult {
  const [command, ...args] = argv;
  if (!command) throw new Error("command argv must not be empty");
  return spawnSync(command, args, {
    encoding: "utf8",
    env,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
}

function commandDetail(result: ManagedImageCommandResult): string {
  return `${result.error?.message ?? ""}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .trim()
    .slice(-8_000);
}

function isDockerNotFound(result: ManagedImageCommandResult): boolean {
  return (
    result.status !== 0 &&
    /(?:no such (?:container|network|object)|not found)/iu.test(commandDetail(result))
  );
}

export function removeManagedImageGatewayStateIfSafe(
  stateDir: string,
  gatewayStop: Pick<StopHostGatewayResult, "failed" | "ownershipFailures">,
  gatewayRemovalStatus: number | null,
): boolean {
  if (
    gatewayStop.failed.length > 0 ||
    (gatewayStop.ownershipFailures?.length ?? 0) > 0 ||
    gatewayRemovalStatus !== 0
  ) {
    return false;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  return true;
}

function createProtectedAuthorityStore(stateDir: string): ManagedBootstrapAuthorityStore {
  const authorityDir = path.join(stateDir, "managed-bootstrap-authority");
  fs.mkdirSync(authorityDir, { mode: 0o700, recursive: true });
  return {
    async recordPreparedAuthority(authority) {
      const finalPath = path.join(authorityDir, `${authority.bootstrapIdentity}.json`);
      const temporaryPath = `${finalPath}.tmp-${process.pid}`;
      const serialized = `${JSON.stringify(authority)}\n`;
      const file = fs.openSync(temporaryPath, "wx", 0o600);
      try {
        fs.writeFileSync(file, serialized, "utf8");
        fs.fsyncSync(file);
      } finally {
        fs.closeSync(file);
      }
      fs.renameSync(temporaryPath, finalPath);
      const directory = fs.openSync(authorityDir, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
      if (fs.readFileSync(finalPath, "utf8") !== serialized) {
        throw new Error("protected managed-bootstrap authority was not durably re-readable");
      }
      return {
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: authority.sandbox,
        bootstrapIdentity: authority.bootstrapIdentity,
        authorityFingerprint: authority.authorityFingerprint,
        recordId: `protected-${authority.bootstrapIdentity}`,
        recordedAt: new Date().toISOString(),
      };
    },
  };
}

async function assertGatewayPortAvailable(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => {
      reject(
        new Error(
          `refusing to disturb an existing listener on the managed-image E2E gateway port ${GATEWAY_PORT}`,
        ),
      );
    });
    server.listen(GATEWAY_PORT, "127.0.0.1", () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

function managedConfigPath(agent: ShippedManagedImageAgent): string {
  switch (agent) {
    case "openclaw":
      return "/sandbox/.openclaw/openclaw.json";
    case "hermes":
      return "/sandbox/.hermes/config.yaml";
    case "langchain-deepagents-code":
      return "/sandbox/.deepagents/config.toml";
  }
}

export function managedImageOpenShellProbe(
  agent: ShippedManagedImageAgent,
  model: string = MODEL,
): string {
  const healthProbe =
    agent === "openclaw"
      ? [
          "openclaw_health_code=\"$(/usr/bin/curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:18789/health || true)\"",
          'case "$openclaw_health_code" in',
          "  200 | 401) ;;",
          "  *) printf 'OpenClaw /health returned HTTP %s\\n' \"${openclaw_health_code:-000}\" >&2; exit 1 ;;",
          "esac",
        ].join("\n")
      : agent === "hermes"
        ? "/usr/bin/curl -fsS --max-time 5 http://127.0.0.1:8642/health >/dev/null"
        : "/usr/local/bin/dcode --version >/dev/null";
  const readinessLabel =
    agent === "openclaw"
      ? "OpenClaw health endpoint"
      : agent === "hermes"
        ? "Hermes health endpoint"
        : "LangChain Deep Agents Code version command";
  const probeStep = (label: string, command: string) =>
    `if ! {\n${command}\n}; then\n  printf '%s\\n' ${JSON.stringify(
      `managed-image startup probe failed: ${label}`,
    )} >&2\n  exit 1\nfi`;
  return [
    "set -u",
    probeStep(
      `${agent} executable`,
      `test -x ${
        agent === "openclaw"
          ? "/usr/local/bin/openclaw"
          : agent === "hermes"
            ? "/usr/local/bin/hermes"
            : "/usr/local/bin/dcode"
      }`,
    ),
    probeStep(
      `${agent} managed model configuration`,
      `grep -F ${JSON.stringify(model)} ${JSON.stringify(managedConfigPath(agent))} >/dev/null`,
    ),
    probeStep(
      "managed runtime environment must not be a symbolic link",
      "test ! -L /run/nemoclaw/managed-startup-runtime.env",
    ),
    probeStep(
      "managed runtime environment owner, group, and mode must equal 0:0:444",
      'test "$(stat -c "%u:%g:%a" /run/nemoclaw/managed-startup-runtime.env)" = "0:0:444"',
    ),
    probeStep(
      "managed startup completion must not be a symbolic link",
      "test ! -L /run/nemoclaw/managed-startup-complete.json",
    ),
    probeStep(
      "managed startup completion owner, group, and mode must equal 0:0:444",
      'test "$(stat -c "%u:%g:%a" /run/nemoclaw/managed-startup-complete.json)" = "0:0:444"',
    ),
    probeStep(
      "corporate CA file must exist and be nonempty",
      "test -s /usr/local/share/nemoclaw/corporate-ca.pem",
    ),
    probeStep(
      "corporate CA owner, group, and mode must equal 0:0:444",
      'test "$(stat -c "%u:%g:%a" /usr/local/share/nemoclaw/corporate-ca.pem)" = "0:0:444"',
    ),
    probeStep(
      "corporate CA system anchor must match the managed material",
      "cmp -s /usr/local/share/nemoclaw/corporate-ca.pem /usr/local/share/ca-certificates/nemoclaw-corporate-ca-01.crt",
    ),
    probeStep(
      "corporate CA system anchor owner, group, and mode must equal 0:0:444",
      'test "$(stat -c "%u:%g:%a" /usr/local/share/ca-certificates/nemoclaw-corporate-ca-01.crt)" = "0:0:444"',
    ),
    probeStep(
      "system trust must verify the managed corporate CA",
      "openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt /usr/local/share/nemoclaw/corporate-ca.pem >/dev/null",
    ),
    probeStep(
      "managed startup CA bundle must exist and be nonempty",
      "test -s /run/nemoclaw/managed-startup-ca-bundle.pem",
    ),
    probeStep(
      "managed startup CA bundle owner, group, and mode must equal 0:0:444",
      'test "$(stat -c "%u:%g:%a" /run/nemoclaw/managed-startup-ca-bundle.pem)" = "0:0:444"',
    ),
    probeStep(readinessLabel, healthProbe),
  ].join("\n");
}

export function managedImageOpenShellCommittedProbe(): string {
  return [
    "set -eu",
    "test ! -e /var/lib/nemoclaw/managed-startup-shared-state-transaction-v1",
  ].join("\n");
}

async function waitForCommittedSandboxProbe(
  onboard: OnboardModule,
  input: Inputs,
  env: NodeJS.ProcessEnv,
  requireCommitted = true,
): Promise<void> {
  const healthProbe = managedImageOpenShellProbe(input.agent, input.model ?? MODEL);
  const committedProbe = managedImageOpenShellCommittedProbe();
  const deadline = Date.now() + 240_000;
  const runProbe = (probe: string, timeoutMs: number) =>
    commandResult(
      onboard.openshellArgv([
        "sandbox",
        "exec",
        "--name",
        input.sandbox,
        "--",
        "/bin/sh",
        "-eu",
        "-c",
        probe,
      ]),
      env,
      timeoutMs,
    );
  let lastHealthDetail = "";
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const health = runProbe(healthProbe, Math.max(1, Math.min(15_000, remainingMs)));
    if (health.status === 0) {
      if (!requireCommitted) return;
      const committed = runProbe(
        committedProbe,
        Math.max(1, Math.min(15_000, deadline - Date.now())),
      );
      if (committed.status !== 0) {
        throw new Error(
          `managed bootstrap committed, but transaction cleanup was not observable through the exact sandbox: ${commandDetail(committed)}`,
        );
      }
      return;
    }
    lastHealthDetail = commandDetail(health);
    const sleepMs = Math.min(2_000, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
  throw new Error(
    `OpenShell sandbox did not pass the exact-image managed-bootstrap probe within 240s: ${lastHealthDetail}`,
  );
}

export function managedImageLocalInferenceBaseUrl(
  localProvider: ManagedImageLocalInferenceKind,
  configuredValue = process.env.NEMOCLAW_E2E_LOCAL_INFERENCE_BASE_URL,
): string {
  const route = resolveManagedImageLocalInferenceRoute(localProvider);
  const configured = String(configuredValue ?? "").trim();
  const value = configured || route.defaultBaseUrl;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("protected local inference base URL is invalid");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "host.openshell.internal" ||
    !/^[1-9][0-9]{0,4}$/u.test(parsed.port) ||
    parsed.pathname.replace(/\/+$/u, "") !== "/v1" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("protected local inference must use http://host.openshell.internal:<port>/v1");
  }
  return value.replace(/\/+$/u, "");
}

function localInferenceBaseUrl(input: Inputs): string {
  if (!input.localProvider) throw new Error("local provider is required");
  return managedImageLocalInferenceBaseUrl(input.localProvider);
}

function configureLocalInferenceRoute(
  onboard: OnboardModule,
  input: Inputs,
  env: NodeJS.ProcessEnv,
): void {
  if (!input.localProvider || !input.model) return;
  const route = resolveManagedImageLocalInferenceRoute(input.localProvider);
  const credential = String(env[route.credentialEnv] ?? "").trim();
  if (!credential || /[\0\r\n]/u.test(credential)) {
    throw new Error(`${route.credentialEnv} is required for protected local inference`);
  }
  const commandEnv = { ...env, [route.credentialEnv]: credential };
  const create = onboard.runOpenshell(
    [
      "provider",
      "create",
      "--name",
      route.providerName,
      "--type",
      "openai",
      "--credential",
      route.credentialEnv,
      "--config",
      `OPENAI_BASE_URL=${localInferenceBaseUrl(input)}`,
    ],
    { ignoreError: true, env: commandEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (create.status !== 0) {
    throw new Error(`protected local inference provider creation failed: ${commandDetail(create)}`);
  }
  const setRoute = onboard.runOpenshell(
    [
      "inference",
      "set",
      "--no-verify",
      "--provider",
      route.providerName,
      "--model",
      input.model,
      "--timeout",
      "120",
    ],
    { ignoreError: true, env: commandEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (setRoute.status !== 0) {
    throw new Error(`protected local inference route failed: ${commandDetail(setRoute)}`);
  }
}

function localInferenceProbe(input: Inputs): string {
  if (!input.model) throw new Error("local inference model is required");
  const payload = JSON.stringify({
    model: input.model,
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    reasoning_effort: "none",
    max_tokens: 32,
  });
  return [
    "set -eu",
    "response=/tmp/nemoclaw-managed-image-inference.json",
    `curl -fsS --max-time 180 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' --data ${JSON.stringify(payload)} > "$response"`,
    "node - \"$response\" <<'NODE'",
    'const fs = require("node:fs");',
    'const body = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));',
    "const choice = Array.isArray(body.choices) ? body.choices[0] : null;",
    'const text = choice && choice.message && typeof choice.message.content === "string"',
    "  ? choice.message.content",
    '  : choice && typeof choice.text === "string" ? choice.text : "";',
    'if (!/pong/i.test(text)) throw new Error("local inference did not return PONG");',
    "NODE",
    'rm -f "$response"',
  ].join("\n");
}

function assertProtectedLocalInference(
  onboard: OnboardModule,
  input: Inputs,
  env: NodeJS.ProcessEnv,
): void {
  const result = commandResult(
    onboard.openshellArgv([
      "sandbox",
      "exec",
      "--name",
      input.sandbox,
      "--",
      "/bin/sh",
      "-eu",
      "-c",
      localInferenceProbe(input),
    ]),
    env,
    210_000,
  );
  if (result.status !== 0) {
    throw new Error(`sandbox inference.local completion failed: ${commandDetail(result)}`);
  }
}

export function failureInjectingAdapter(
  onboard: OnboardModule,
  stateRoot: string,
): ManagedBootstrapAdapter {
  const adapter = createDockerManagedBootstrapAdapter({
    runCaptureOpenshell: onboard.runCaptureOpenshell,
    runOpenshell: onboard.runOpenshell,
    sleep: onboard.sleepSeconds,
    stateRoot,
  });
  return {
    ...adapter,
    async awaitBootstrap(input) {
      await adapter.awaitBootstrap(input);
      throw new Error("protected-e2e-injected-bootstrap-completion-failure");
    },
  };
}

function parseImmutableManifestReference(image: string): {
  repository: string;
  manifestDigest: `sha256:${string}`;
} {
  const match = IMMUTABLE_MANIFEST_REFERENCE_RE.exec(image);
  if (!match?.[1] || !match[2]) {
    throw new Error("--image must be an immutable repository@sha256 manifest reference");
  }
  return {
    repository: match[1],
    manifestDigest: match[2] as `sha256:${string}`,
  };
}

function resolveLocalImageContentId(
  image: string,
  env: NodeJS.ProcessEnv,
  runCommand: ManagedImageCommandRunner = commandResult,
): string {
  const inspect = runCommand(["docker", "image", "inspect", "--format", "{{.Id}}", image], env);
  const contentId = String(inspect.stdout ?? "").trim();
  if (inspect.status !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(contentId)) {
    throw new Error(
      `--image does not resolve to one immutable local image content ID: ${commandDetail(inspect)}`,
    );
  }
  return contentId;
}

export function managedImageHarnessContainerListArgs(
  sandbox: string,
  includeStopped: boolean,
): string[] {
  return [
    "docker",
    "ps",
    includeStopped ? "-aq" : "-q",
    "--no-trunc",
    "--filter",
    "label=openshell.ai/managed-by=openshell",
    "--filter",
    `label=openshell.ai/sandbox-name=${sandbox}`,
  ];
}

function exactHarnessContainerIds(
  input: Inputs,
  networkName: string,
  env: NodeJS.ProcessEnv,
  includeStopped = true,
  runCommand: ManagedImageCommandRunner = commandResult,
): { candidateCount: number; exactIds: string[] } {
  const expectedContentId = resolveLocalImageContentId(input.image, env, runCommand);
  const list = runCommand(managedImageHarnessContainerListArgs(input.sandbox, includeStopped), env);
  if (list.status !== 0) {
    throw new Error(`could not resolve the OpenShell sandbox container: ${commandDetail(list)}`);
  }
  const candidates = String(list.stdout ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const exactIds: string[] = [];
  for (const candidate of candidates) {
    const inspect = runCommand(["docker", "inspect", candidate], env);
    if (inspect.status !== 0) continue;
    try {
      const records = JSON.parse(String(inspect.stdout ?? "")) as Array<{
        Config?: { Labels?: Record<string, string> };
        Image?: string;
        NetworkSettings?: { Networks?: Record<string, unknown> };
      }>;
      const record = records.length === 1 ? records[0] : undefined;
      if (
        record?.Config?.Labels?.["openshell.ai/managed-by"] === "openshell" &&
        record.Config.Labels["openshell.ai/sandbox-name"] === input.sandbox &&
        record.Image === expectedContentId &&
        Object.hasOwn(record.NetworkSettings?.Networks ?? {}, networkName)
      ) {
        exactIds.push(candidate);
      }
    } catch {
      // An unparseable inspection result cannot establish cleanup ownership.
    }
  }
  return { candidateCount: candidates.length, exactIds };
}

export function assertExactSandboxImage(
  input: Inputs,
  networkName: string,
  env: NodeJS.ProcessEnv,
  runCommand: ManagedImageCommandRunner = commandResult,
): string {
  // A managed-bootstrap transaction keeps its stopped rollback backup until
  // commit. Qualify the one running replacement here; rollback cleanup below
  // continues to inspect every stopped and running container.
  const resolved = exactHarnessContainerIds(input, networkName, env, false, runCommand);
  if (resolved.candidateCount !== 1 || resolved.exactIds.length !== 1) {
    throw new Error(
      `OpenShell did not launch exactly one running harness-owned PR image container: found ${resolved.candidateCount} running labeled and ${resolved.exactIds.length} running exact`,
    );
  }
  return resolved.exactIds[0] ?? "";
}

export function assertFailedBootstrapOwnerCleanupRetention(
  input: Inputs,
  networkName: string,
  expectedRuntimeId: string,
  env: NodeJS.ProcessEnv,
  runCommand: ManagedImageCommandRunner = commandResult,
): void {
  const resolved = exactHarnessContainerIds(input, networkName, env, true, runCommand);
  if (
    resolved.candidateCount !== 1 ||
    resolved.exactIds.length !== 1 ||
    resolved.exactIds[0] !== expectedRuntimeId
  ) {
    throw new Error(
      `managed-bootstrap rollback did not retain its one exact owner-cleanup runtime: found ${resolved.candidateCount} labeled and ${resolved.exactIds.length} exact containers`,
    );
  }
  const inspect = runCommand(["docker", "inspect", expectedRuntimeId], env);
  if (inspect.status !== 0) {
    throw new Error(
      `managed-bootstrap rollback could not inspect its retained owner-cleanup runtime: ${commandDetail(inspect)}`,
    );
  }
  try {
    const records = JSON.parse(String(inspect.stdout ?? "")) as Array<{
      State?: { Paused?: boolean; Restarting?: boolean; Running?: boolean };
    }>;
    const state = records.length === 1 ? records[0]?.State : undefined;
    if (state?.Running !== false || state.Paused !== false || state.Restarting !== false) {
      throw new Error("retained runtime is not explicitly quiescent");
    }
  } catch (error) {
    throw new Error(
      `managed-bootstrap rollback did not prove a quiescent owner-cleanup runtime: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function assertFailedSandboxOwnerCleanupRetention(
  onboard: OnboardModule,
  input: Inputs,
  expectedSandboxId: string,
  env: NodeJS.ProcessEnv,
): void {
  const get = onboard.runOpenshell(["sandbox", "get", input.sandbox], {
    ignoreError: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const list = onboard.runOpenshell(["sandbox", "list"], {
    ignoreError: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (
    get.status !== 0 ||
    parseOpenShellSandboxId(String(get.stdout ?? "")) !== expectedSandboxId ||
    list.status !== 0 ||
    !parseLiveSandboxNames(String(list.stdout ?? "")).has(input.sandbox)
  ) {
    throw new Error(
      `managed-bootstrap rollback did not retain its exact OpenShell owner-cleanup state: get=${commandDetail(get)} list=${commandDetail(list)}`,
    );
  }
}

async function run<T extends ManagedImageOpenShellE2eLocalInferenceEvidence = never>(
  input: Inputs,
  afterLocalInference?: (context: ManagedImageOpenShellE2eProbeContext) => Promise<T> | T,
): Promise<ManagedImageOpenShellE2eResult<T>> {
  const stateParent = process.env.RUNNER_TEMP || os.tmpdir();
  const stateDir = fs.mkdtempSync(path.join(stateParent, "nemoclaw-managed-openshell-"));
  const networkName = `nemoclaw-managed-pr-${process.pid}-${Date.now().toString(36)}`;
  const previousEnvironment = Object.fromEntries(
    MANAGED_IMAGE_E2E_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof MANAGED_IMAGE_E2E_ENVIRONMENT_KEYS)[number], string | undefined>;
  process.env.NEMOCLAW_NON_INTERACTIVE = "1";
  process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = stateDir;
  process.env.NEMOCLAW_GATEWAY_PORT = String(GATEWAY_PORT);
  process.env.NEMOCLAW_DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT = "240";
  process.env.OPENSHELL_DOCKER_NETWORK_NAME = networkName;
  process.env.XDG_CONFIG_HOME = path.join(stateDir, "xdg-config");
  process.env.XDG_DATA_HOME = path.join(stateDir, "xdg-data");
  process.env.XDG_STATE_HOME = path.join(stateDir, "xdg-state");
  process.env.PATH = `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH ?? ""}`;

  let onboard: OnboardModule | null = null;
  let ownedContainerId: string | null = null;
  let initialSandboxPolicy: InitialSandboxPolicy | null = null;
  let runtimeProvider:
    | (RuntimeProviderBundle & {
        readonly bootstrap: RuntimeProviderManagedImageBootstrapSurface;
      })
    | null = null;
  let managedStateRoots: readonly ProtectedManagedStateRoot[] = [];
  let managedStateVolumeScope: ProtectedManagedStateVolumeScope | null = null;
  let managedStateVolumesCommitted = false;
  let failureInjectionQualified = false;
  let probeEvidence: T | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: string[] = [];
  try {
    await assertGatewayPortAvailable();
    const image = parseImmutableManifestReference(input.image);
    resolveLocalImageContentId(input.image, process.env);

    onboard = resolveManagedImageOnboardModule(await import("../../src/lib/onboard.ts"));
    await onboard.startGatewayForRecovery({
      gatewayName: GATEWAY_NAME,
      gatewayPort: GATEWAY_PORT,
    });
    configureLocalInferenceRoute(onboard, input, process.env);

    const baseProfile = managedStartupE2eProfile(input.agent, false, true, true);
    const protectedProfile =
      input.localProvider && input.model
        ? withManagedImageLocalInferenceProfile(
            baseProfile,
            resolveManagedImageLocalInferenceRoute(input.localProvider),
            input.model,
          )
        : baseProfile;
    const profile = encodeManagedStartupProfile(protectedProfile);
    const rootApplyRequest = createManagedStartupRootApplyRequest({
      agent: input.agent,
      encodedProfile: profile,
      corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString("base64"),
    });
    initialSandboxPolicy = prepareInitialSandboxCreatePolicy(
      managedImageOpenShellBasePolicyPath(input.agent),
      [],
      {
        agentName: input.agent,
        directGpu: input.gpu === true,
        hostGpuAvailable: input.gpu === true,
        additionalPresets: input.localProvider ? ["local-inference"] : [],
      },
    );
    const selectedRuntimeProvider = {
      ...createDockerRuntimeProviderBundle(),
      bootstrap: createDockerManagedBootstrapSurface("docker"),
    } as RuntimeProviderBundle & {
      readonly bootstrap: RuntimeProviderManagedImageBootstrapSurface;
    };
    runtimeProvider = selectedRuntimeProvider;
    const agentIdentity = managedImageRuntimeIdentity(input.agent);
    managedStateRoots = onboard.managedWorkloadOnboard.managedStartupStateRoots({
      agent: input.agent,
      sandboxName: input.sandbox,
      agentIdentity,
    });
    managedStateVolumeScope = onboard.managedWorkloadOnboard.prepareManagedStateVolumes(
      { roots: managedStateRoots },
      { runtimeProvider: selectedRuntimeProvider },
    );
    const managedStateDriverConfig = protectedManagedStateRootDriverConfig(
      selectedRuntimeProvider,
      managedStateVolumeScope?.mounts ?? [],
    );
    const createArgs = [
      "--from",
      input.image,
      "--name",
      input.sandbox,
      "--policy",
      initialSandboxPolicy.policyPath,
      ...(managedStateDriverConfig ? ["--driver-config-json", managedStateDriverConfig] : []),
      ...(input.gpu ? ["--gpu"] : []),
    ];
    const launch = prepareSandboxCreateLaunch({
      agent: resolveAgent({ agentFlag: input.agent }),
      sandboxName: input.sandbox,
      chatUiUrl: "",
      createArgs,
      env: {},
      extraPlaceholderKeys: [],
      getDashboardForwardPort: () => "0",
      hermesDashboardState: { config: null, enabled: false },
      manageDashboard: false,
      openshellShellCommand: (args: string[]) => args.map((arg) => JSON.stringify(arg)).join(" "),
      openshellArgv: onboard.openshellArgv,
      managedStartupRootApplyRequest: rootApplyRequest,
    });
    const prebuild = {
      createArgs: [...createArgs],
      imageRef: null,
      imageId: null,
    };
    if (
      launch.createArgv.filter((value) => value === "--from").length !== 1 ||
      launch.createArgv[launch.createArgv.indexOf("--from") + 1] !== input.image ||
      launch.createArgv.filter((value) => value === "--policy").length !== 1 ||
      launch.createArgv[launch.createArgv.indexOf("--policy") + 1] !==
        initialSandboxPolicy.policyPath
    ) {
      throw new Error("managed-image launch renderer altered the exact PR image identity");
    }
    const startupPlan = resolveDockerStartupCommandPatch(
      { name: input.agent } as Parameters<typeof resolveDockerStartupCommandPatch>[0],
      true,
    );
    if (
      !launch.managedStartupRootApplyRequest ||
      !launch.managedBootstrapIdentity ||
      !launch.intendedSandboxStartupCommand
    ) {
      throw new Error("managed-image launch did not retain its identity-bound bootstrap contract");
    }

    const gpuEnabled = input.gpu === true;
    const gpuConfig = {
      mode: gpuEnabled ? ("1" as const) : ("0" as const),
      hostGpuDetected: gpuEnabled,
      hostGpuPlatform: gpuEnabled ? ("linux" as const) : null,
      sandboxGpuEnabled: gpuEnabled,
      sandboxGpuDevice: null,
      errors: [],
    };
    const verifyDirectSandboxGpu = gpuEnabled
      ? createDirectSandboxGpuVerifier({
          runOpenshell: onboard.runOpenshell,
          compactText,
          redact: redactProtectedGpuProof,
        })
      : () => ({
          status: "unverified" as const,
          cudaVerified: false,
          label: "disabled",
          detail: null,
          at: new Date().toISOString(),
        });
    let flow: Awaited<ReturnType<typeof runSandboxGpuCreateFlow>> | null = null;
    try {
      flow = await runSandboxGpuCreateFlow(
        {
          sandboxName: input.sandbox,
          provider: input.localProvider
            ? resolveManagedImageLocalInferenceRoute(input.localProvider).providerName
            : "nvidia",
          sandboxGpuConfig: gpuConfig,
          gpuRoutePlan: gpuEnabled ? "native-only" : "none",
          initialGpuRoute: gpuEnabled ? "native" : "none",
          compatibilityPolicyPath: null,
          dockerDriverGateway: true,
          gatewayName: GATEWAY_NAME,
          gatewayPort: GATEWAY_PORT,
          sandboxReadyTimeoutSecs: 240,
          createArgv: launch.createArgv,
          sandboxEnv: launch.sandboxEnv,
          sandboxStartupCommand: launch.sandboxStartupCommand,
          prebuild,
          restoreBackupPath: null,
          terminalAgent: input.agent === "langchain-deepagents-code",
          managedBootstrap: createProtectedManagedImageBootstrapInput({
            bootstrapIdentity: launch.managedBootstrapIdentity,
            stateRoot: stateDir,
            runtimeProvider: selectedRuntimeProvider,
            authorityStore: createProtectedAuthorityStore(stateDir),
            request: launch.managedStartupRootApplyRequest,
            image,
            agentIdentity,
            workspaceRoot: onboard.managedWorkloadOnboard.managedStartupWorkspaceRoot({
              agent: input.agent,
              agentIdentity,
            }),
            managedStateRoots,
            intendedWorkloadArgv: launch.intendedSandboxStartupCommand,
          }),
          ...startupPlan,
        },
        {
          runOpenshell: onboard.runOpenshell,
          runCaptureOpenshell: onboard.runCaptureOpenshell,
          sandboxObserver: createCliOpenShellSandboxObserverFromRunner(onboard.runOpenshell),
          sleep: onboard.sleepSeconds,
          openshellArgv: onboard.openshellArgv,
          verifyDirectSandboxGpu,
          ...(input.failureInjection
            ? {
                createManagedBootstrapAdapter: (stateRoot: string) =>
                  failureInjectingAdapter(onboard!, stateRoot),
              }
            : {}),
        },
      );
    } catch (error) {
      if (
        input.failureInjection === "bootstrap-completion" &&
        error instanceof Error &&
        error.message.includes("protected-e2e-injected-bootstrap-completion-failure")
      ) {
        const rollbackError = (error as Error & { managedBootstrapRollbackError?: unknown })
          .managedBootstrapRollbackError;
        if (
          !(rollbackError instanceof ManagedBootstrapOwnerCleanupRequiredError) ||
          rollbackError.sandboxName !== input.sandbox
        ) {
          throw error;
        }
        assertFailedBootstrapOwnerCleanupRetention(
          input,
          networkName,
          rollbackError.runtimeId,
          launch.sandboxEnv,
        );
        assertFailedSandboxOwnerCleanupRetention(
          onboard,
          input,
          rollbackError.sandboxId,
          launch.sandboxEnv,
        );
        failureInjectionQualified = true;
        process.stdout.write(
          `Injected managed-bootstrap completion failure retained one exact quiescent ${input.agent} sandbox for owner cleanup.\n`,
        );
      } else {
        throw error;
      }
    }

    if (!failureInjectionQualified) {
      if (!flow) {
        throw new Error("production managed-bootstrap flow returned no result");
      }
      if (flow.origin !== "created") {
        throw new Error(
          "production managed-bootstrap flow unexpectedly resumed an existing sandbox",
        );
      }
      const expectedRoute = gpuEnabled ? "native" : "none";
      if (flow.route !== expectedRoute || flow.createResult.status !== 0) {
        throw new Error(
          `production managed-bootstrap flow did not complete the exact PR image create: route=${flow.route} status=${flow.createResult.status}`,
        );
      }

      await waitForCommittedSandboxProbe(onboard, input, launch.sandboxEnv, !gpuEnabled);
      ownedContainerId = assertExactSandboxImage(input, networkName, launch.sandboxEnv);
      if (input.localProvider && !afterLocalInference) {
        assertProtectedLocalInference(onboard, input, launch.sandboxEnv);
      }
      if (gpuEnabled) {
        await flow.runtimePatch.commitAfterReady();
        await waitForCommittedSandboxProbe(onboard, input, launch.sandboxEnv);
      }
      managedStateVolumeScope?.commit();
      managedStateVolumesCommitted = managedStateVolumeScope !== null;
      if (afterLocalInference) {
        if (!input.localProvider) {
          throw new Error("managed-image post-route probe requires protected local inference");
        }
        probeEvidence = await afterLocalInference({
          input,
          runSandbox(argv, timeoutMilliseconds = 210_000) {
            const result = commandResult(
              onboard!.openshellArgv(["sandbox", "exec", "--name", input.sandbox, "--", ...argv]),
              launch.sandboxEnv,
              timeoutMilliseconds,
            );
            return {
              status: result.status,
              stdout: String(result.stdout ?? ""),
              stderr: String(result.stderr ?? ""),
            };
          },
        });
        if (!probeEvidence || probeEvidence.synchronousChat !== true) {
          throw new Error(
            "managed-image post-route probe did not prove protected synchronous inference",
          );
        }
      }
      process.stdout.write(
        `OpenShell launched exact ${input.agent} PR image ${input.image} through the production managed-bootstrap sequence${input.localProvider ? ` with ${gpuEnabled ? "real NVIDIA GPU access and " : ""}${input.localProvider} inference.local completion` : ""}.\n`,
      );
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
  } finally {
    if (onboard) {
      commandResult(
        onboard.openshellArgv(["sandbox", "delete", input.sandbox]),
        process.env,
        15_000,
      );
    }
    const gatewayStop = stopHostGatewayProcesses(
      {},
      {
        clearRuntimeFiles: false,
        openShellGatewayName: "nemoclaw",
        openShellGatewayPort: GATEWAY_PORT,
        scopedGatewayStop: true,
        stateDir,
        usePgrepFallback: false,
      },
    );
    if (gatewayStop.failed.length > 0 || (gatewayStop.ownershipFailures?.length ?? 0) > 0) {
      cleanupErrors.push(
        `OpenShell gateway cleanup failed: ${[
          ...gatewayStop.failed.map((pid) => `process ${String(pid)} did not stop`),
          ...(gatewayStop.ownershipFailures ?? []),
        ].join("; ")}`,
      );
    }
    let gatewayRemovalStatus: number | null = null;
    if (onboard) {
      const removeGateway = commandResult(
        onboard.openshellArgv(["gateway", "remove", "nemoclaw"]),
        process.env,
        15_000,
      );
      gatewayRemovalStatus = removeGateway.status;
      if (removeGateway.status !== 0) {
        cleanupErrors.push(`OpenShell gateway removal failed: ${commandDetail(removeGateway)}`);
      }
    }
    try {
      const resolved = exactHarnessContainerIds(input, networkName, process.env);
      const cleanupContainerId =
        resolved.exactIds.length === 1 ? (resolved.exactIds[0] ?? null) : null;
      if (cleanupContainerId) {
        const remove = commandResult(
          ["docker", "rm", "-f", cleanupContainerId],
          process.env,
          15_000,
        );
        const verify = commandResult(
          ["docker", "container", "inspect", cleanupContainerId],
          process.env,
          15_000,
        );
        if (verify.status === 0 || !isDockerNotFound(verify)) {
          cleanupErrors.push(
            `exact harness container ${cleanupContainerId} was not removed: ${commandDetail(remove)} ${commandDetail(verify)}`.trim(),
          );
        }
      } else if (resolved.exactIds.length > 1) {
        cleanupErrors.push(
          `refusing ambiguous exact harness container cleanup: ${resolved.exactIds.length} matches`,
        );
      } else if (ownedContainerId) {
        const verify = commandResult(
          ["docker", "container", "inspect", ownedContainerId],
          process.env,
          15_000,
        );
        if (verify.status === 0 || !isDockerNotFound(verify)) {
          cleanupErrors.push(
            `could not prove exact harness container ${ownedContainerId} was removed: ${commandDetail(verify)}`,
          );
        }
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    cleanupErrors.push(
      ...cleanupProtectedManagedStateVolumes({
        onboard,
        runtimeProvider,
        roots: managedStateRoots,
        scope: managedStateVolumeScope,
        committed: managedStateVolumesCommitted,
      }),
    );
    const removeNetwork = commandResult(
      ["docker", "network", "rm", networkName],
      process.env,
      15_000,
    );
    const verifyNetwork = commandResult(
      ["docker", "network", "inspect", networkName],
      process.env,
      15_000,
    );
    if (verifyNetwork.status === 0 || !isDockerNotFound(verifyNetwork)) {
      cleanupErrors.push(
        `harness network ${networkName} was not removed: ${commandDetail(removeNetwork)} ${commandDetail(verifyNetwork)}`.trim(),
      );
    }
    const remainingSandboxContainers = commandResult(
      [
        "docker",
        "ps",
        "-aq",
        "--filter",
        "label=openshell.ai/managed-by=openshell",
        "--filter",
        `label=openshell.ai/sandbox-name=${input.sandbox}`,
      ],
      process.env,
      15_000,
    );
    if (
      remainingSandboxContainers.status !== 0 ||
      String(remainingSandboxContainers.stdout ?? "").trim() !== ""
    ) {
      cleanupErrors.push(
        `managed-image sandbox/container orphan remained after cleanup: ${commandDetail(remainingSandboxContainers)}`,
      );
    }
    try {
      initialSandboxPolicy?.cleanup?.();
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      if (!removeManagedImageGatewayStateIfSafe(stateDir, gatewayStop, gatewayRemovalStatus)) {
        cleanupErrors.push(
          `OpenShell gateway ownership evidence remains at ${stateDir} because gateway cleanup did not complete`,
        );
      }
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error.message : String(error));
    }
    for (const key of MANAGED_IMAGE_E2E_ENVIRONMENT_KEYS) {
      const previousValue = previousEnvironment[key];
      if (previousValue === undefined) delete process.env[key];
      else process.env[key] = previousValue;
    }
  }

  const cleanupDetail =
    cleanupErrors.length > 0
      ? `managed-image OpenShell cleanup failed: ${cleanupErrors.join("; ")}`
      : null;
  if (hasPrimaryError) {
    if (cleanupDetail) {
      const primaryDetail =
        primaryError instanceof Error ? primaryError.message : String(primaryError);
      throw new Error(`${primaryDetail}; ${cleanupDetail}`, {
        cause: primaryError,
      });
    }
    throw primaryError;
  }
  if (cleanupDetail) {
    throw new Error(cleanupDetail);
  }
  if (failureInjectionQualified) {
    process.stdout.write(
      `Managed-bootstrap failure injection retained only its exact quiescent sandbox until harness owner cleanup and left no sandbox, container, network, or harness state orphan for ${input.agent}.\n`,
    );
  }
  return {
    cleanup: {
      gatewayRemoved: true,
      networkRemoved: true,
      sandboxRemoved: true,
      stateRemoved: true,
    },
    ...(probeEvidence === undefined ? {} : { probeEvidence }),
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  run(parseManagedImageOpenShellE2eInputs(process.argv.slice(2))).catch(() => {
    console.error("Managed-image OpenShell E2E failed; inspect the redacted evidence artifacts.");
    process.exitCode = 1;
  });
}

export { run as runManagedImageOpenShellE2e };
