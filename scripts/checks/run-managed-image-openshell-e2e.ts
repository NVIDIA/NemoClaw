// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reserveCreateSandboxHermesApiPort, resolveAgent } from "../../src/lib/agent/onboard.ts";
import type { OpenShellForwardPortObserver } from "../../src/lib/onboard/dashboard-port.ts";
import {
  isOpenShellSandboxId,
  NEMOCLAW_CREATE_ATTEMPT_LABEL,
  parseOpenShellSandboxId,
  parseStrictOpenShellSandboxListJson,
  resolveCreatedOpenShellSandboxId,
} from "../../src/lib/adapters/openshell/sandbox-identity.ts";
import { createCliOpenShellSandboxCommandExecutor } from "../../src/lib/adapters/openshell/sandbox-command-cli.ts";
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
  managedImageRuntimeIdentity,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ShippedManagedImageAgent,
} from "../../src/lib/onboard/managed-image/contract.ts";
import { encodeManagedStartupProfile } from "../../src/lib/onboard/managed-startup/profile.ts";
import { createManagedStartupRootApplyRequest } from "../../src/lib/onboard/managed-startup/root-apply.ts";
import type {
  completeProviderManagedStartup,
  RuntimeProviderBundle,
} from "../../src/lib/onboard/runtime-provider/access.ts";
import { createDockerRuntimeProviderBundle } from "../../src/lib/onboard/runtime-provider/docker.ts";
import { parseLiveSandboxNames } from "../../src/lib/runtime-recovery.ts";
import { prepareSandboxCreateLaunch } from "../../src/lib/onboard/sandbox-create-launch.ts";
import {
  type CreatedSandboxIdentity,
  resolveDockerStartupCommandPatch,
  runSandboxGpuCreateFlow,
  type SandboxGpuCreateFlowInput,
} from "../../src/lib/onboard/sandbox-gpu-create-flow.ts";
import { createDirectSandboxGpuVerifier } from "../../src/lib/onboard/sandbox-gpu-preflight.ts";
import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  MANAGED_STARTUP_E2E_OPENCLAW_HEARTBEAT_EVERY,
  managedStartupE2eProfile,
} from "./generate-managed-startup-profile-fixture.mts";
import {
  managedImageHarnessContainerListArgs,
  managedImageSandboxListLimitFlag,
  requireManagedImageHarnessOpenShellVersionFromOutput,
  configureLocalInferenceRoute,
  assertLocalInferenceAgentResponse,
  waitForLocalInferenceAgentPairing,
  localInferenceAgentCommand,
  localInferenceProbe,
  verifyManagedImageLocalInferenceRoute,
  type ManagedImageOpenShellE2eInputs,
  createManagedImageSandboxWithDiagnostics,
  isManagedImageHarnessWorkload,
  isManagedImageLocalInferenceKind,
  managedImageFailureDetail,
  type ManagedImageLocalInferenceKind,
  resolveManagedImageLocalInferenceRoute,
  withManagedImageLocalInferenceProfile,
} from "./managed-image-protected-runtime-contract.ts";

// This executable owns one protected qualification transaction from sandbox
// creation through exact cleanup. Keep its stateful orchestration and cleanup
// together so no cross-module return path can bypass rollback. Native inference
// preparation and diagnostics use managed-image-protected-runtime-contract.ts.

const MANAGED_AGENTS = new Set<ShippedManagedImageAgent>(SHIPPED_MANAGED_IMAGE_AGENTS);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const GATEWAY_NAME = "nemoclaw";
const GATEWAY_PORT = 8080;
const IMMUTABLE_MANIFEST_REFERENCE_RE = /^([^\s@]+)@(sha256:[a-f0-9]{64})$/u;
const MANAGED_AGENT_BASE_POLICIES: Record<ShippedManagedImageAgent, readonly string[]> = {
  openclaw: ["nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"],
  hermes: ["agents", "hermes", "policy-additions.yaml"],
  "langchain-deepagents-code": ["agents", "langchain-deepagents-code", "policy-additions.yaml"],
};

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

export type { ManagedImageOpenShellE2eInputs } from "./managed-image-protected-runtime-contract.ts";

export type ManagedImageOpenShellRecoveryScope = {
  readonly owner: string;
  readonly stateDir: string;
  readonly networkName: string;
};

function recoveryIdentity(input: Inputs, scope: ManagedImageOpenShellRecoveryScope): string {
  if (
    !/^llama-cpp-dgx-spark-[1-9][0-9]*-[1-9][0-9]*$/u.test(scope.owner) ||
    scope.networkName !== `nemoclaw-managed-${scope.owner}` ||
    !path.isAbsolute(scope.stateDir) ||
    path.basename(scope.stateDir) !== "managed-openshell" ||
    path.basename(path.dirname(scope.stateDir)) !== scope.owner ||
    fs.realpathSync(path.dirname(scope.stateDir)) !== path.dirname(scope.stateDir)
  )
    throw new Error("invalid managed qualification recovery scope");
  return JSON.stringify({
    kind: "managed-qualification-owner-v2",
    input: {
      agent: input.agent,
      image: input.image,
      sandbox: input.sandbox,
      localProvider: input.localProvider,
      model: input.model,
      gpu: input.gpu,
    },
    scope,
  });
}

export function prepareManagedImageOpenShellState(
  input: Inputs,
  scope?: ManagedImageOpenShellRecoveryScope,
): { stateDir: string; networkName: string } {
  if (!scope)
    return {
      stateDir: fs.mkdtempSync(
        path.join(process.env.RUNNER_TEMP || os.tmpdir(), "nemoclaw-managed-openshell-"),
      ),
      networkName: `nemoclaw-managed-pr-${process.pid}-${Date.now().toString(36)}`,
    };
  const marker = recoveryIdentity(input, scope);
  fs.mkdirSync(scope.stateDir, { mode: 0o700 });
  fs.writeFileSync(path.join(scope.stateDir, "qualification-owner.json"), marker, {
    flag: "wx",
    mode: 0o600,
  });
  return { stateDir: scope.stateDir, networkName: scope.networkName };
}

function readManagedRecoveryRecord(file: string): string {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const marker = fs.fstatSync(descriptor);
    if (!marker.isFile() || marker.size > 8192)
      throw new Error("managed recovery identity mismatch");
    const buffer = Buffer.alloc(8193);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, bytes);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > 8192) throw new Error("managed recovery identity mismatch");
    return buffer.subarray(0, bytes).toString("utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function requireManagedRecoveryOwner(
  input: Inputs,
  scope: ManagedImageOpenShellRecoveryScope,
): void {
  if (
    readManagedRecoveryRecord(path.join(scope.stateDir, "qualification-owner.json")) !==
    recoveryIdentity(input, scope)
  )
    throw new Error("managed recovery identity mismatch");
}

function optionalManagedRecoveryRecord(file: string): string | null {
  try {
    return readManagedRecoveryRecord(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function recordManagedRecoverySandbox(
  input: Inputs,
  scope: ManagedImageOpenShellRecoveryScope,
  nonce: string,
  sandboxId: string,
): void {
  fs.writeFileSync(
    path.join(scope.stateDir, "qualification-sandbox.json"),
    JSON.stringify({
      kind: "managed-qualification-sandbox-v1",
      owner: scope.owner,
      sandbox: input.sandbox,
      sandboxId,
      createAttemptNonce: nonce,
    }),
    { flag: "wx", mode: 0o600 },
  );
}

function managedSandboxDeletedIdentity(
  input: Inputs,
  scope: ManagedImageOpenShellRecoveryScope,
  nonce: string,
  sandboxId: string,
): string {
  return JSON.stringify({
    kind: "managed-qualification-sandbox-deleted-v1",
    owner: scope.owner,
    sandbox: input.sandbox,
    sandboxId,
    createAttemptNonce: nonce,
  });
}

function confirmManagedSandboxAbsent(
  onboard: Pick<OnboardModule, "runCaptureOpenshell">,
  nonce: string,
): void {
  const versionOutput = onboard.runCaptureOpenshell(["--version"], {
    ignoreError: false,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  const runtimeVersion = requireManagedImageHarnessOpenShellVersionFromOutput(versionOutput);
  const output = onboard.runCaptureOpenshell(
    [
      "sandbox",
      "list",
      "-g",
      GATEWAY_NAME,
      "--selector",
      `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${nonce}`,
      "--output",
      "json",
      managedImageSandboxListLimitFlag(runtimeVersion),
      "2",
    ],
    { ignoreError: false, timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  const rows = parseStrictOpenShellSandboxListJson(output);
  if (!rows || rows.length !== 0) throw new Error("managed recovery sandbox absence is unproven");
}

export function createManagedImageSandboxWithRecovery(
  input: Inputs,
  scope: ManagedImageOpenShellRecoveryScope | undefined,
  onboard: Pick<OnboardModule, "runCaptureOpenshell">,
  create: ReturnType<typeof createManagedImageSandboxWithDiagnostics>,
): ReturnType<typeof createManagedImageSandboxWithDiagnostics> {
  if (!scope) return create;
  let submitted = false;
  return async (request, options) => {
    requireManagedRecoveryOwner(input, scope);
    if (
      submitted ||
      request.sandboxName !== input.sandbox ||
      request.target.kind !== "named" ||
      request.target.gatewayName !== GATEWAY_NAME ||
      request.source.reference !== input.image
    )
      throw new Error("managed recovery create authority mismatch");
    const nonce =
      request.labels?.[NEMOCLAW_CREATE_ATTEMPT_LABEL] ?? randomBytes(31).toString("hex");
    if (!/^[a-f0-9]{62}$/u.test(nonce))
      throw new Error("managed recovery create identity mismatch");
    submitted = true;
    fs.writeFileSync(
      path.join(scope.stateDir, "qualification-attempt.json"),
      JSON.stringify({
        kind: "managed-qualification-attempt-v1",
        owner: scope.owner,
        sandbox: input.sandbox,
        createAttemptNonce: nonce,
      }),
      { flag: "wx", mode: 0o600 },
    );
    const result = await create(
      {
        ...request,
        labels: { ...request.labels, [NEMOCLAW_CREATE_ATTEMPT_LABEL]: nonce },
      },
      options,
    );
    if (result.status === 0 && !result.ambiguous) {
      const sandboxId = resolveCreatedOpenShellSandboxId({
        sandboxName: input.sandbox,
        gatewayName: GATEWAY_NAME,
        createAttemptNonce: nonce,
        runCaptureOpenshell: (args, captureOptions) =>
          onboard.runCaptureOpenshell(args, {
            ...captureOptions,
            env: request.environment,
          }),
      });
      recordManagedRecoverySandbox(input, scope, nonce, sandboxId);
    }
    return result;
  };
}

function removeManagedImageSandbox(
  input: Inputs,
  onboard: Pick<OnboardModule, "runOpenshell" | "runCaptureOpenshell" | "openshellArgv">,
  scope?: ManagedImageOpenShellRecoveryScope,
): string[] {
  try {
    let deletionIdentity: { nonce: string; sandboxId: string } | null = null;
    if (scope) {
      requireManagedRecoveryOwner(input, scope);
      const attemptSource = optionalManagedRecoveryRecord(
        path.join(scope.stateDir, "qualification-attempt.json"),
      );
      const source = optionalManagedRecoveryRecord(
        path.join(scope.stateDir, "qualification-sandbox.json"),
      );
      const deletedSource = optionalManagedRecoveryRecord(
        path.join(scope.stateDir, "qualification-sandbox-deleted.json"),
      );
      if (attemptSource === null) {
        if (source !== null || deletedSource !== null)
          throw new Error("managed recovery attempt authority is missing");
        return [];
      }
      const attempt = JSON.parse(attemptSource) as Record<string, unknown>;
      if (
        attempt.kind !== "managed-qualification-attempt-v1" ||
        attempt.owner !== scope.owner ||
        attempt.sandbox !== input.sandbox ||
        typeof attempt.createAttemptNonce !== "string" ||
        !/^[a-f0-9]{62}$/u.test(attempt.createAttemptNonce) ||
        attemptSource !==
          JSON.stringify({
            kind: attempt.kind,
            owner: attempt.owner,
            sandbox: attempt.sandbox,
            createAttemptNonce: attempt.createAttemptNonce,
          })
      )
        throw new Error("managed recovery attempt authority is unproven");
      const record = source === null ? null : (JSON.parse(source) as Record<string, unknown>);
      if (
        source !== null &&
        (!record ||
          record.kind !== "managed-qualification-sandbox-v1" ||
          record.owner !== scope.owner ||
          record.sandbox !== input.sandbox ||
          !isOpenShellSandboxId(record.sandboxId) ||
          record.createAttemptNonce !== attempt.createAttemptNonce ||
          source !==
            JSON.stringify({
              kind: record.kind,
              owner: record.owner,
              sandbox: record.sandbox,
              sandboxId: record.sandboxId,
              createAttemptNonce: record.createAttemptNonce,
            }))
      )
        throw new Error("managed recovery sandbox identity is unproven");
      if (deletedSource !== null) {
        if (
          source === null ||
          deletedSource !==
            managedSandboxDeletedIdentity(
              input,
              scope,
              attempt.createAttemptNonce,
              record!.sandboxId as string,
            )
        )
          throw new Error("managed recovery deleted sandbox identity is unproven");
        return [];
      }
      const currentId = resolveCreatedOpenShellSandboxId({
        sandboxName: input.sandbox,
        gatewayName: GATEWAY_NAME,
        createAttemptNonce: attempt.createAttemptNonce,
        runCaptureOpenshell: onboard.runCaptureOpenshell,
      });
      const expectedId = record?.sandboxId ?? currentId;
      if (source === null)
        recordManagedRecoverySandbox(input, scope, attempt.createAttemptNonce, currentId);
      deletionIdentity = { nonce: attempt.createAttemptNonce, sandboxId: expectedId as string };
      const named = onboard.runOpenshell(["sandbox", "get", "-g", GATEWAY_NAME, input.sandbox], {
        ignoreError: true,
        env: process.env,
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (
        currentId !== expectedId ||
        named.status !== 0 ||
        parseOpenShellSandboxId(String(named.stdout ?? "")) !== expectedId
      )
        throw new Error("managed recovery sandbox identity changed; inspection is required");
    }
    const deletion = commandResult(
      onboard.openshellArgv([
        "sandbox",
        "delete",
        ...(scope ? ["-g", GATEWAY_NAME] : []),
        input.sandbox,
      ]),
      process.env,
      15000,
    );
    if (scope) {
      if (deletion.status !== 0 || deletion.error)
        throw new Error("managed-image recovery could not verify sandbox deletion");
      if (!deletionIdentity) throw new Error("managed recovery sandbox identity is unproven");
      confirmManagedSandboxAbsent(onboard, deletionIdentity.nonce);
      fs.writeFileSync(
        path.join(scope.stateDir, "qualification-sandbox-deleted.json"),
        managedSandboxDeletedIdentity(
          input,
          scope,
          deletionIdentity.nonce,
          deletionIdentity.sandboxId,
        ),
        { flag: "wx", mode: 0o600 },
      );
    }
    return [];
  } catch {
    return ["managed recovery sandbox identity or deletion is unproven; inspection is required"];
  }
}

export async function cleanupInterruptedManagedImageOpenShellE2e(
  input: Inputs,
  scope: ManagedImageOpenShellRecoveryScope,
): Promise<void> {
  recoveryIdentity(input, scope);
  if (!fs.existsSync(scope.stateDir)) return;
  const state = fs.lstatSync(scope.stateDir);
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    fs.realpathSync(scope.stateDir) !== scope.stateDir
  )
    throw new Error("managed recovery state directory is not owned");
  requireManagedRecoveryOwner(input, scope);
  const previousEnvironment = { ...process.env };
  Object.assign(process.env, {
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: path.join(scope.stateDir, "gateway-state"),
    NEMOCLAW_GATEWAY_PORT: String(GATEWAY_PORT),
    OPENSHELL_DOCKER_NETWORK_NAME: scope.networkName,
    XDG_CONFIG_HOME: path.join(scope.stateDir, "xdg-config"),
    XDG_DATA_HOME: path.join(scope.stateDir, "xdg-data"),
    XDG_STATE_HOME: path.join(scope.stateDir, "xdg-state"),
    PATH: `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH ?? ""}`,
  });
  try {
    const onboard = resolveManagedImageOnboardModule(await import("../../src/lib/onboard.ts"));
    const sandboxFailures = removeManagedImageSandbox(input, onboard, scope);
    if (sandboxFailures.length) throw new Error(sandboxFailures.join("; "));
    const gatewayStop = stopHostGatewayProcesses(
      {},
      {
        clearRuntimeFiles: false,
        openShellGatewayName: GATEWAY_NAME,
        openShellGatewayPort: GATEWAY_PORT,
        scopedGatewayStop: true,
        stateDir: path.join(scope.stateDir, "gateway-state"),
        usePgrepFallback: false,
      },
    );
    if (gatewayStop.failed.length || gatewayStop.ownershipFailures?.length)
      throw new Error("managed recovery gateway ownership or termination is unproven");
    const removeGateway = commandResult(
      onboard.openshellArgv(["gateway", "remove", GATEWAY_NAME]),
      process.env,
      15000,
    );
    const gatewayAlreadyAbsent =
      removeGateway.status === 1 &&
      !removeGateway.error &&
      (/(?:^|\n)\s*(?:Error:\s*)?(?:×\s*)?No gateway metadata found for 'nemoclaw'\./iu.test(
        String(removeGateway.stderr ?? ""),
      ) ||
        /^(?:Error:\s*)?(?:gateway ["']?nemoclaw["']? (?:not found|does not exist)|no such gateway:?[\s"']*nemoclaw)$/iu.test(
          String(removeGateway.stderr ?? "").trim(),
        ));
    if (removeGateway.status !== 0 && !gatewayAlreadyAbsent)
      throw new Error("managed recovery gateway removal failed");
    const gatewayStateDir = path.join(scope.stateDir, "gateway-state");
    const containers = exactHarnessContainerIds(input, gatewayStateDir, process.env);
    if (containers.exactIds.length > 1)
      throw new Error("managed recovery container identity is ambiguous");
    if (containers.exactIds.length === 1) {
      commandResult(["docker", "rm", "--force", containers.exactIds[0]!], process.env, 15000);
      if (exactHarnessContainerIds(input, gatewayStateDir, process.env).exactIds.length !== 0)
        throw new Error("managed recovery container cleanup is unproven");
    }
    const provider = createDockerRuntimeProviderBundle();
    const roots = qualificationManagedStateRoots(
      onboard.managedWorkloadOnboard.managedStartupStateRoots({
        agent: input.agent,
        sandboxName: input.sandbox,
        agentIdentity: managedImageRuntimeIdentity(input.agent),
      }),
      scope.owner,
    );
    const failures = cleanupProtectedManagedStateVolumes({
      onboard,
      runtimeProvider: provider,
      roots,
      prepared: true,
    });
    if (failures.length) throw new Error("managed recovery volume cleanup is unproven");
    commandResult(["docker", "network", "rm", scope.networkName], process.env, 15000);
    const network = commandResult(
      ["docker", "network", "inspect", scope.networkName],
      process.env,
      15000,
    );
    const escapedNetwork = scope.networkName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const absentNetwork = new RegExp(
      `^(?:Error(?: response from daemon)?:\\s*)?(?:No such (?:network|object): ${escapedNetwork}|network ${escapedNetwork} not found)$`,
      "iu",
    );
    if (
      network.error ||
      network.status !== 1 ||
      !absentNetwork.test(String(network.stderr ?? "").trim())
    )
      throw new Error("managed recovery network cleanup is unproven");
    if (
      !removeManagedImageGatewayStateIfSafe(
        scope.stateDir,
        gatewayStop,
        gatewayAlreadyAbsent ? 0 : removeGateway.status,
      )
    )
      throw new Error("managed recovery state removal is unproven");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!Object.hasOwn(previousEnvironment, key)) delete process.env[key];
    }
    Object.assign(process.env, previousEnvironment);
  }
}

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

function qualificationManagedStateRoots(
  roots: readonly ProtectedManagedStateRoot[],
  owner?: string,
): readonly ProtectedManagedStateRoot[] {
  return owner
    ? roots.map((root) => ({
        ...root,
        ownershipLabels: {
          ...root.ownershipLabels,
          "io.nvidia.nemoclaw.qualification-owner": owner,
        },
      }))
    : roots;
}

type ProtectedManagedStateVolumeMount = {
  readonly type: "volume";
  readonly source: string;
  readonly target: string;
  readonly read_only: boolean;
};

type ProtectedManagedStateVolumeCleanupResult =
  | { readonly status: "not-applicable" | "absent" | "removed" }
  | {
      readonly status: "not-owned" | "failed" | "retained";
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
    completeProviderManagedStartup: typeof completeProviderManagedStartup;
    managedStartupStateRoots(input: {
      readonly agent: ShippedManagedImageAgent;
      readonly sandboxName: string;
      readonly agentIdentity: { readonly uid: number; readonly gid: number };
    }): readonly ProtectedManagedStateRoot[];
    managedStartupWorkspaceRoot(input: {
      readonly agent: ShippedManagedImageAgent;
      readonly agentIdentity: { readonly uid: number; readonly gid: number };
    }): {
      readonly uid: number;
      readonly gid: number;
      readonly mode: 0o755 | 0o1775;
    };
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
  createForwardPortObserver(sandboxName: string, kind: "loopback"): OpenShellForwardPortObserver;
};

const REQUIRED_ONBOARD_OPERATIONS = [
  "openshellArgv",
  "runOpenshell",
  "runCaptureOpenshell",
  "sleepSeconds",
  "startGatewayForRecovery",
  "createForwardPortObserver",
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
    typeof managedWorkload.removeManagedStateVolumes !== "function" ||
    typeof managedWorkload.completeProviderManagedStartup !== "function"
  ) {
    throw new Error("managed-image onboard module is missing required managed workload operations");
  }
  return candidate as OnboardModule;
}

export function cleanupProtectedManagedStateVolumes(input: {
  readonly onboard: OnboardModule | null;
  readonly runtimeProvider: RuntimeProviderBundle | null;
  readonly roots: readonly ProtectedManagedStateRoot[];
  readonly prepared: boolean;
}): string[] {
  try {
    let results: readonly ProtectedManagedStateVolumeCleanupResult[] = [];
    // This is the fixture owner's explicit teardown after sandbox/container
    // cleanup, including injected bootstrap failures. Automatic create rollback
    // preserves named volumes and cannot establish an empty fixture inventory.
    if (input.prepared && input.onboard && input.runtimeProvider) {
      results = input.onboard.managedWorkloadOnboard.removeManagedStateVolumes(
        { roots: input.roots },
        { runtimeProvider: input.runtimeProvider },
      );
    }
    return results.flatMap((result) =>
      result.status === "not-owned" || result.status === "failed" || result.status === "retained"
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
  return path.resolve(REPOSITORY_ROOT, ...MANAGED_AGENT_BASE_POLICIES[agent]);
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

export function printExactContainerFailureState(
  containerId: string | null,
  env: NodeJS.ProcessEnv,
  runCommand: ManagedImageCommandRunner = commandResult,
): void {
  if (!containerId || !/^[a-f0-9]{64}$/u.test(containerId)) return;
  const state = runCommand(
    [
      "docker",
      "container",
      "inspect",
      "--format",
      "{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}",
      containerId,
    ],
    env,
    5_000,
  );
  console.error(
    `Managed-image exact container state: ${managedImageFailureDetail(commandDetail(state))}`,
  );
  const processState = runCommand(
    [
      "docker",
      "exec",
      "--user",
      "sandbox",
      containerId,
      "/bin/sh",
      "-c",
      "printf 'pid1='; cat /proc/1/comm; printf 'processes='; ps -eo comm= | head -n 60; printf 'memory-events='; cat /sys/fs/cgroup/memory.events",
    ],
    env,
    5_000,
  );
  console.error(
    `Managed-image exact container processes: ${managedImageFailureDetail(commandDetail(processState))}`,
  );
  // The canonical process can exit while OpenShell PID 1 stays alive. Read only
  // its fixed diagnostic logs as the sandbox owner before fixture cleanup.
  const startupLogs = runCommand(
    [
      "docker",
      "exec",
      "--user",
      "sandbox",
      containerId,
      "/usr/local/bin/node",
      "-e",
      `const fs = require("node:fs");
for (const file of ["/tmp/nemoclaw-start.log", "/tmp/gateway.log", "/tmp/dashboard.log"]) {
  let fd;
  process.stdout.write(file + "\\n");
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 262144) throw new Error("unsafe or oversized log");
    const bytes = Buffer.alloc(Math.min(stat.size, 262144));
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    process.stdout.write(bytes.subarray(0, count));
  } catch { process.stdout.write("diagnostic log unavailable\\n"); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}`,
    ],
    env,
    5_000,
  );
  console.error(
    `Managed-image startup logs (bounded): ${managedImageFailureDetail(`${startupLogs.error?.message ?? ""}\n${startupLogs.stdout ?? ""}\n${startupLogs.stderr ?? ""}`, env)}`,
  );
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
  cleanupErrors: readonly string[] = [],
  retainRecoveryErrors = true,
): boolean {
  if (
    (retainRecoveryErrors && cleanupErrors.length > 0) ||
    gatewayStop.failed.length > 0 ||
    (gatewayStop.ownershipFailures?.length ?? 0) > 0 ||
    gatewayRemovalStatus !== 0
  ) {
    return false;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
  return true;
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

export function managedOpenClawHeartbeatLogProbe(): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
let operation = "discover";
try {
  let interval;
  const roots = ["/tmp/openclaw", "/tmp/openclaw-" + process.getuid()];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    if (!fs.lstatSync(root).isDirectory()) throw new Error();
    operation = "list";
    // OpenClaw falls back to its uid directory when the preferred directory is inaccessible.
    let names;
    try { names = fs.readdirSync(root); }
    catch (error) { if (error?.code === "EACCES") continue; throw error; }
    for (const name of names.filter(name => /^openclaw(?:-\\d{4}-\\d{2}-\\d{2})?\\.log$/.test(name)).sort()) {
      operation = "open";
      const fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error();
        operation = "parse";
        for (const line of fs.readFileSync(fd, "utf8").split("\\n").filter(Boolean)) {
          const record = JSON.parse(line);
          if (record["2"] !== "heartbeat: started") continue;
          const subsystem = JSON.parse(record["0"]);
          if (subsystem.subsystem !== "gateway/heartbeat") continue;
          const value = record["1"]?.intervalMs;
          if (!Number.isSafeInteger(value) || value <= 0) throw new Error();
          if (interval !== undefined && interval !== value) throw new Error();
          interval = value;
        }
      } finally { fs.closeSync(fd); }
    }
  }
  if (interval === undefined) {
    process.stderr.write("heartbeat-not-started");
    process.exitCode = 2;
  } else {
    process.stdout.write("heartbeat-interval-ms=" + interval);
  }
} catch (error) {
  const code = ["EACCES", "EPERM", "ENOENT", "ELOOP", "SyntaxError"].find(value => value === error?.code || value === error?.name) ?? "invalid";
  process.stderr.write("heartbeat-evidence-unavailable:" + operation + ":" + code);
  process.exitCode = 1;
}
`;
}

export async function assertOpenClawHeartbeatStart(
  containerId: string,
  env: NodeJS.ProcessEnv,
  runCommand: ManagedImageCommandRunner = commandResult,
  deadline = Date.now() + 15_000,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(containerId)) {
    throw new Error("OpenClaw heartbeat check requires one exact container ID");
  }
  while (Date.now() < deadline) {
    const result = runCommand(
      [
        "docker",
        "exec",
        "--user",
        "sandbox",
        containerId,
        "node",
        "-e",
        managedOpenClawHeartbeatLogProbe(),
      ],
      env,
      Math.max(1, Math.min(15_000, deadline - Date.now())),
    );
    if (
      result.status === 2 &&
      !result.error &&
      result.stdout === "" &&
      result.stderr === "heartbeat-not-started"
    ) {
      // HTTP liveness precedes heartbeat activation. Only absence may be polled;
      // malformed, conflicting, inaccessible, or incorrect evidence still fails immediately.
      const sleepMs = Math.min(2_000, Math.max(0, deadline - Date.now()));
      if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
      continue;
    }
    if (result.status !== 0 || result.error) {
      const detail =
        /^heartbeat-evidence-unavailable:(discover|list|open|parse):(EACCES|EPERM|ENOENT|ELOOP|SyntaxError|invalid)$/u.exec(
          String(result.stderr ?? ""),
        );
      throw new Error(
        `managed OpenClaw structured heartbeat evidence unavailable${detail ? ` (${detail[1]}: ${detail[2]})` : ""}`,
      );
    }
    const heartbeatStart = String(result.stdout ?? "").trim();
    const configuredInterval = /^(\d+)([smh])$/u.exec(MANAGED_STARTUP_E2E_OPENCLAW_HEARTBEAT_EVERY);
    const intervalUnitMs = { s: 1_000, m: 60_000, h: 3_600_000 }[
      configuredInterval?.[2] as "s" | "m" | "h"
    ];
    const expectedIntervalMs = configuredInterval
      ? Number(configuredInterval[1]) * intervalUnitMs
      : Number.NaN;
    const observedIntervalMs = /^heartbeat-interval-ms=(\d+)$/u.exec(heartbeatStart)?.[1];
    if (
      !Number.isSafeInteger(expectedIntervalMs) ||
      observedIntervalMs !== String(expectedIntervalMs)
    ) {
      throw new Error(
        `managed OpenClaw did not start with the requested ${expectedIntervalMs} ms heartbeat`,
      );
    }
    return;
  }
  throw new Error("managed OpenClaw heartbeat did not start within the managed-startup deadline");
}

export function managedOpenClawHeartbeatProbe(
  configPath: string = managedConfigPath("openclaw"),
  nodeExecutable = "/usr/local/bin/node",
): string {
  const shellQuote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;
  const configProbe = [
    shellQuote(nodeExecutable),
    "-e",
    shellQuote(
      "const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const h=c?.agents?.defaults?.heartbeat;if(h?.every!==process.argv[2]||h?.isolatedSession!==true)process.exit(1);",
    ),
    shellQuote(configPath),
    shellQuote(MANAGED_STARTUP_E2E_OPENCLAW_HEARTBEAT_EVERY),
  ].join(" ");
  return configProbe;
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
    ...(agent === "openclaw"
      ? [probeStep("OpenClaw managed isolated heartbeat", managedOpenClawHeartbeatProbe())]
      : []),
    probeStep(
      "managed runtime environment must not be a symbolic link",
      "test ! -L /tmp/nemoclaw-managed-startup-runtime.env",
    ),
    probeStep(
      "managed runtime environment owner, group, and mode must equal 0:0:444",
      'test "$(stat -c "%u:%g:%a" /tmp/nemoclaw-managed-startup-runtime.env)" = "0:0:444"',
    ),
    probeStep(
      "managed startup completion must not be a symbolic link",
      "test ! -L /tmp/nemoclaw-managed-startup-complete.json",
    ),
    probeStep(
      "managed startup completion owner, group, and mode must equal 0:0:444",
      'test "$(stat -c "%u:%g:%a" /tmp/nemoclaw-managed-startup-complete.json)" = "0:0:444"',
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
      "test -s /tmp/nemoclaw-managed-startup-ca-bundle.pem",
    ),
    probeStep(
      "managed startup CA bundle owner, group, and mode must equal 0:0:444",
      'test "$(stat -c "%u:%g:%a" /tmp/nemoclaw-managed-startup-ca-bundle.pem)" = "0:0:444"',
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
  deadline = Date.now() + 240_000,
): Promise<void> {
  const healthProbe = managedImageOpenShellProbe(input.agent, input.model ?? MODEL);
  const committedProbe = managedImageOpenShellCommittedProbe();
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

async function assertProtectedLocalInference(
  onboard: OnboardModule,
  input: Inputs,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const result = commandResult(
    onboard.openshellArgv([
      "sandbox",
      "exec",
      "--name",
      input.sandbox,
      "--",
      ...localInferenceProbe(input),
    ]),
    env,
    210_000,
  );
  if (result.status !== 0) {
    throw new Error(`sandbox native local completion failed: ${commandDetail(result)}`);
  }
  // The fresh sandbox has one verified provider attachment. Use the generated
  // agent configuration without endpoint, credential, or model overrides.
  const agentResult = await waitForLocalInferenceAgentPairing(input.agent, () =>
    commandResult(
      onboard.openshellArgv([
        "sandbox",
        "exec",
        "--name",
        input.sandbox,
        "--",
        ...localInferenceAgentCommand(input),
      ]),
      env,
      210_000,
    ),
  );
  if (agentResult.status !== 0) {
    throw new Error(`sandbox native agent completion failed: ${commandDetail(agentResult)}`);
  }
  assertLocalInferenceAgentResponse(input, String(agentResult.stdout ?? ""), env);
}

export { managedImageHarnessContainerListArgs } from "./managed-image-protected-runtime-contract.ts";

function exactHarnessContainerIds(
  input: Inputs,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  includeStopped = true,
  runCommand: ManagedImageCommandRunner = commandResult,
): { candidateCount: number; exactIds: string[] } {
  const expectedContentId = resolveLocalImageContentId(input.image, env, runCommand);
  const version = runCommand(["openshell", "--version"], env);
  if (version.status !== 0) {
    throw new Error(`could not resolve the protected OpenShell version: ${commandDetail(version)}`);
  }
  const runtimeVersion = requireManagedImageHarnessOpenShellVersionFromOutput(
    String(version.stdout ?? ""),
  );
  const list = runCommand(
    managedImageHarnessContainerListArgs(input.sandbox, includeStopped, runtimeVersion),
    env,
  );
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
        HostConfig?: { NetworkMode?: string };
      }>;
      const record = records.length === 1 ? records[0] : undefined;
      if (
        isManagedImageHarnessWorkload(record, {
          sandbox: input.sandbox,
          stateDir,
          imageContentId: expectedContentId,
          runtimeVersion,
          networkName: env.OPENSHELL_DOCKER_NETWORK_NAME,
        })
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
  stateDir: string,
  env: NodeJS.ProcessEnv,
  runCommand: ManagedImageCommandRunner = commandResult,
): string {
  // A managed-bootstrap transaction keeps its stopped rollback backup until
  // commit. Qualify the one running replacement here; rollback cleanup below
  // continues to inspect every stopped and running container.
  // OpenShell 0.1.2 separates supervisor and workload containers and puts the
  // workload on network=none. Bind ownership to our private gateway namespace.
  const resolved = exactHarnessContainerIds(input, stateDir, env, false, runCommand);
  if (resolved.candidateCount !== 1 || resolved.exactIds.length !== 1) {
    throw new Error(
      `OpenShell did not launch exactly one running harness-owned PR image container: found ${resolved.candidateCount} running labeled and ${resolved.exactIds.length} running exact`,
    );
  }
  return resolved.exactIds[0] ?? "";
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

export function createBootstrapCompletionFailureInjection(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly managedImage: Inputs;
  readonly onboard: OnboardModule;
  readonly onQualified: () => void;
  readonly write?: (message: string) => void;
}): {
  readonly expectedError: Error;
  readonly flowInput: Pick<
    SandboxGpuCreateFlowInput,
    | "persistRetainedSandboxRecovery"
    | "revalidateVerifiedSandboxBeforeEffect"
    | "verifyCreatedSandboxBeforeEffects"
  >;
} {
  const expectedError = new Error("injected managed bootstrap completion failure");
  return {
    expectedError,
    flowInput: {
      persistRetainedSandboxRecovery: () => true,
      revalidateVerifiedSandboxBeforeEffect: () => undefined,
      verifyCreatedSandboxBeforeEffects: (identity: CreatedSandboxIdentity) => {
        assertFailedSandboxOwnerCleanupRetention(
          input.onboard,
          input.managedImage,
          identity.sandboxId,
          input.env,
        );
        input.onQualified();
        (input.write ?? ((message) => process.stdout.write(message)))(
          `Managed-bootstrap completion failure retained one exact quiescent ${input.managedImage.agent} sandbox for owner cleanup.\n`,
        );
        throw expectedError;
      },
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

async function run<T extends ManagedImageOpenShellE2eLocalInferenceEvidence = never>(
  input: Inputs,
  afterLocalInference?: (context: ManagedImageOpenShellE2eProbeContext) => Promise<T> | T,
  recoveryScope?: ManagedImageOpenShellRecoveryScope,
  maximumOutputTokens?: number,
): Promise<ManagedImageOpenShellE2eResult<T>> {
  const { stateDir, networkName } = prepareManagedImageOpenShellState(input, recoveryScope);
  // Qualification ownership records live in stateDir. OpenShell needs an empty
  // child directory so it can establish its own managed gateway ownership marker.
  const gatewayStateDir = path.join(stateDir, "gateway-state");
  const previousEnvironment = Object.fromEntries(
    MANAGED_IMAGE_E2E_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof MANAGED_IMAGE_E2E_ENVIRONMENT_KEYS)[number], string | undefined>;
  process.env.NEMOCLAW_NON_INTERACTIVE = "1";
  process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR = gatewayStateDir;
  process.env.NEMOCLAW_GATEWAY_PORT = String(GATEWAY_PORT);
  process.env.NEMOCLAW_DOCKER_GPU_SUPERVISOR_RECONNECT_TIMEOUT = "240";
  process.env.OPENSHELL_DOCKER_NETWORK_NAME = networkName;
  process.env.XDG_CONFIG_HOME = path.join(stateDir, "xdg-config");
  process.env.XDG_DATA_HOME = path.join(stateDir, "xdg-data");
  process.env.XDG_STATE_HOME = path.join(stateDir, "xdg-state");
  process.env.PATH = `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH ?? ""}`;

  let onboard: OnboardModule | null = null;
  let hermesApiPort: Awaited<ReturnType<typeof reserveCreateSandboxHermesApiPort>> | null = null;
  let ownedContainerId: string | null = null;
  let initialSandboxPolicy: InitialSandboxPolicy | null = null;
  let runtimeProvider: RuntimeProviderBundle | null = null;
  let managedStateRoots: readonly ProtectedManagedStateRoot[] = [];
  let managedStateVolumeScope: ProtectedManagedStateVolumeScope | null = null;
  let failureInjectionQualified = false;
  let probeEvidence: T | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: string[] = [];
  const exit = process.exit;
  try {
    // Imported CLI failure paths must unwind this fixture's diagnostics and cleanup.
    process.exit = (code) => {
      throw new Error(`Managed-image onboarding called process.exit(${String(code)})`);
    };
    await assertGatewayPortAvailable();
    parseImmutableManifestReference(input.image);
    resolveLocalImageContentId(input.image, process.env);

    onboard = resolveManagedImageOnboardModule(await import("../../src/lib/onboard.ts"));
    await onboard.startGatewayForRecovery({
      gatewayName: GATEWAY_NAME,
      gatewayPort: GATEWAY_PORT,
    });
    const localAttachment = await configureLocalInferenceRoute(onboard, input, process.env);
    if (input.agent === "hermes") {
      // Reserve the fixed API port used by this fixture's in-sandbox health probe.
      hermesApiPort = await reserveCreateSandboxHermesApiPort({
        sandboxName: input.sandbox,
        env: { NEMOCLAW_HERMES_API_PORT: "8642" },
        observeForwardPorts: onboard.createForwardPortObserver(input.sandbox, "loopback"),
      });
    }

    const baseProfile = managedStartupE2eProfile(input.agent, false, true, true);
    const protectedProfile =
      input.localProvider && input.model
        ? withManagedImageLocalInferenceProfile(
            baseProfile,
            {
              ...resolveManagedImageLocalInferenceRoute(input.localProvider),
              defaultBaseUrl: localAttachment!.endpointUrl,
            },
            input.model,
            maximumOutputTokens,
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
      },
    );
    const selectedRuntimeProvider = createDockerRuntimeProviderBundle();
    runtimeProvider = selectedRuntimeProvider;
    const agentIdentity = managedImageRuntimeIdentity(input.agent);
    managedStateRoots = qualificationManagedStateRoots(
      onboard.managedWorkloadOnboard.managedStartupStateRoots({
        agent: input.agent,
        sandboxName: input.sandbox,
        agentIdentity,
      }),
      recoveryScope?.owner,
    );
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
      // The host CLI must find the isolated gateway without changing fixture configuration.
      buildEnv: () =>
        Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      extraPlaceholderKeys: [],
      getDashboardForwardPort: () => "0",
      hermesDashboardState: { config: null, enabled: false },
      hermesApiPort: hermesApiPort?.effectivePort,
      manageDashboard: false,
      openshellShellCommand: (args: string[]) => args.map((arg) => JSON.stringify(arg)).join(" "),
      openshellArgv: onboard.openshellArgv,
      managedStartupRootApplyRequest: rootApplyRequest,
    });
    const prebuild = {
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
    if (!launch.intendedSandboxStartupCommand) {
      throw new Error("managed-image launch did not retain its native startup command");
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
          redact: managedImageFailureDetail,
        })
      : () => ({
          status: "unverified" as const,
          cudaVerified: false,
          label: "disabled",
          detail: null,
          at: new Date().toISOString(),
        });
    const commandExecutor = createCliOpenShellSandboxCommandExecutor({
      hostCwd: REPOSITORY_ROOT,
    });
    const failureInjection = input.failureInjection
      ? createBootstrapCompletionFailureInjection({
          env: launch.sandboxEnv,
          managedImage: input,
          onboard,
          onQualified: () => {
            failureInjectionQualified = true;
          },
        })
      : null;
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
          createRequest: {
            sandboxName: input.sandbox,
            target: { kind: "named", gatewayName: GATEWAY_NAME },
            source: { reference: input.image },
            ...(localAttachment ? { providers: [localAttachment.providerName] } : {}),
            policyPath: initialSandboxPolicy.policyPath,
            ...(managedStateDriverConfig ? { driverConfigJson: managedStateDriverConfig } : {}),
            ...(input.gpu ? { gpu: {} } : {}),
            startupCommand: launch.sandboxStartupCommand,
            environment: launch.sandboxEnv,
          },
          sandboxEnv: launch.sandboxEnv,
          sandboxStartupCommand: launch.sandboxStartupCommand,
          prebuild,
          restoreBackupPath: null,
          terminalAgent: input.agent === "langchain-deepagents-code",
          managedImage: true,
          ...startupPlan,
          ...(failureInjection?.flowInput ?? {}),
        },
        {
          commandExecutor,
          createSandbox: createManagedImageSandboxWithRecovery(
            input,
            recoveryScope,
            onboard,
            createManagedImageSandboxWithDiagnostics(
              onboard.runOpenshell,
              () => onboard!.openshellArgv([])[0],
            ),
          ),
          runOpenshell: onboard.runOpenshell,
          runCaptureOpenshell: onboard.runCaptureOpenshell,
          sandboxObserver: createCliOpenShellSandboxObserverFromRunner(onboard.runOpenshell),
          sleep: onboard.sleepSeconds,
          openshellArgv: onboard.openshellArgv,
          verifyDirectSandboxGpu,
        },
      );
    } catch (error) {
      if (error !== failureInjection?.expectedError || !failureInjectionQualified) throw error;
    }

    if (!failureInjectionQualified) {
      if (!flow) {
        throw new Error("production managed-image flow returned no result");
      }
      if (flow.origin !== "created") {
        throw new Error("production managed-image flow unexpectedly resumed an existing sandbox");
      }
      const expectedRoute = gpuEnabled ? "native" : "none";
      if (flow.route !== expectedRoute || flow.createResult.status !== 0) {
        throw new Error(
          `production managed-image flow did not complete the exact PR image create: route=${flow.route} status=${flow.createResult.status}`,
        );
      }

      ownedContainerId = assertExactSandboxImage(input, gatewayStateDir, launch.sandboxEnv);
      if (localAttachment) {
        await verifyManagedImageLocalInferenceRoute(
          onboard.runOpenshell,
          input.sandbox,
          localAttachment,
        );
      }
      const sandbox = onboard.runOpenshell(["sandbox", "get", input.sandbox], {
        ignoreError: true,
        env: launch.sandboxEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const sandboxId = parseOpenShellSandboxId(String(sandbox.stdout ?? ""));
      if (sandbox.status !== 0 || !sandboxId || !launch.managedBootstrapIdentity) {
        throw new Error("Managed startup requires the exact sandbox and bootstrap identities.");
      }
      onboard.managedWorkloadOnboard.completeProviderManagedStartup({
        runtimeProvider: selectedRuntimeProvider,
        sandboxName: input.sandbox,
        sandboxId,
        bootstrapIdentity: launch.managedBootstrapIdentity,
        request: rootApplyRequest,
        expectedContainerId: ownedContainerId,
      });
      const startupDeadline = Date.now() + 240_000;
      await waitForCommittedSandboxProbe(
        onboard,
        input,
        launch.sandboxEnv,
        !gpuEnabled,
        startupDeadline,
      );
      if (input.agent === "openclaw") {
        await assertOpenClawHeartbeatStart(
          ownedContainerId,
          launch.sandboxEnv,
          commandResult,
          startupDeadline,
        );
      }
      if (input.localProvider && !afterLocalInference) {
        await assertProtectedLocalInference(onboard, input, launch.sandboxEnv);
      }
      if (gpuEnabled) {
        await flow.runtimePatch.commitAfterReady();
        await waitForCommittedSandboxProbe(onboard, input, launch.sandboxEnv);
      }
      managedStateVolumeScope?.commit();
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
        `OpenShell launched exact ${input.agent} PR image ${input.image} through the production managed-bootstrap sequence${input.localProvider ? ` with ${gpuEnabled ? "real NVIDIA GPU access and " : ""}${input.localProvider} native local completion` : ""}.\n`,
      );
    }
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
    const diagnostics = [
      ...(onboard ? [onboard.openshellArgv(["sandbox", "get", input.sandbox])] : []),
      ["tail", "-n", "80", path.join(gatewayStateDir, "openshell-gateway.log")],
    ];
    for (const argv of diagnostics) {
      const result = commandResult(argv, process.env, 5_000);
      console.error(
        `Managed-image failure evidence: ${managedImageFailureDetail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)}`,
      );
    }
    printExactContainerFailureState(ownedContainerId, process.env);
  } finally {
    process.exit = exit;
    try {
      await hermesApiPort?.reservation?.release();
    } catch (error) {
      cleanupErrors.push(
        `Hermes API port reservation cleanup failed: ${managedImageFailureDetail(error)}`,
      );
    }
    const cleanupManagedRuntime = async () => {
      if (recoveryScope) {
        initialSandboxPolicy?.cleanup?.();
        await cleanupInterruptedManagedImageOpenShellE2e(input, recoveryScope);
        return;
      }
      if (onboard) {
        cleanupErrors.push(...removeManagedImageSandbox(input, onboard));
      }
      const gatewayStop = stopHostGatewayProcesses(
        {},
        {
          clearRuntimeFiles: false,
          openShellGatewayName: "nemoclaw",
          openShellGatewayPort: GATEWAY_PORT,
          scopedGatewayStop: true,
          stateDir: gatewayStateDir,
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
        const resolved = exactHarnessContainerIds(input, gatewayStateDir, process.env);
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
          prepared: managedStateVolumeScope !== null,
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
        if (
          !removeManagedImageGatewayStateIfSafe(
            stateDir,
            gatewayStop,
            gatewayRemovalStatus,
            cleanupErrors,
            false,
          )
        ) {
          cleanupErrors.push(
            `OpenShell gateway ownership evidence remains at ${stateDir} because gateway cleanup did not complete`,
          );
        }
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    };
    try {
      await cleanupManagedRuntime();
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
  run(parseManagedImageOpenShellE2eInputs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(`Managed-image OpenShell E2E failed: ${managedImageFailureDetail(error)}`);
    process.exitCode = 1;
  });
}

export { run as runManagedImageOpenShellE2e };
