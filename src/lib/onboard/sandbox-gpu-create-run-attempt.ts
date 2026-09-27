// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

import {
  mergeIsolatedDockerClientEnv,
  prepareDockerBuildEnvironment,
  warnIfDockerBuildEnvironmentCleanupFailed,
} from "../adapters/docker/client-isolation";
import {
  NEMOCLAW_CREATE_ATTEMPT_LABEL,
  NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH,
  parseOpenShellSandboxId,
  observeCreatedOpenShellSandboxId,
  resolveCreatedOpenShellSandboxId,
  settleCreatedOpenShellSandboxId,
} from "../adapters/openshell/sandbox-identity";
import { namedOpenShellGateway } from "../adapters/openshell/sandbox-observer";
import { printSandboxCreateRecoveryHints } from "../build-context";
import type { StreamSandboxCreateResult } from "../sandbox/create-stream";
import { getReadyCheckOutputPatternsForAgent } from "../sandbox/create-stream-ready-gate";
import type { SandboxGpuProofResult } from "../state/registry";
import { classifySandboxCreateFailure } from "../validation";
import {
  createSandboxRecoveryContext,
  formatRetainedSandboxRecoveryMessage,
  reportSandboxCreateFailure,
} from "./created-sandbox-failure";
import * as dockerGpuLocalInference from "./docker-gpu-local-inference";
import type { SandboxCreateRuntimePatch } from "./docker-gpu-patch-types";
import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import { verifySandboxBridgeGatewayReachableOrExit } from "./gateway-sandbox-reachability";
import { createDockerGpuSandboxCreatePatch } from "./docker-gpu-sandbox-create";
import { installPortableDemoSandboxLifecycle } from "./experimental/portable-demo-lifecycle";
import {
  isExactOpenShellDockerSandboxReplacement,
  queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot,
} from "./openshell-docker-sandbox-containers";
import { printSandboxCreateFailureDiagnostics } from "./sandbox-create-failure";
import * as sandboxGpuCreateAttempt from "./sandbox-gpu-create-attempt";
import type {
  SandboxGpuCreateFlowDeps,
  SandboxGpuCreateFlowInput,
} from "./sandbox-gpu-create-flow";
import { fingerprintSandboxRecreateValue } from "./sandbox-recreate-transaction";
import * as sandboxGpuPreflight from "./sandbox-gpu-preflight";
import { SANDBOX_RECREATE_PROBE_TIMEOUT_MS } from "./sandbox-recreate-probe";
import type { CreatedSandboxReadyIdentityCheck } from "./sandbox-readiness-tracing";
import * as sandboxReadinessTracing from "./sandbox-readiness-tracing";
import { addTraceEvent } from "./tracing";

type NativeRuntimeSnapshot = Readonly<{
  imageId: string | null;
  bookkeepingImageRef: string | null;
  stateError: string;
  nativeGpuAttachmentState: "present" | "absent" | "unknown";
}>;

export type SandboxGpuCreateAttemptState = {
  firstCreateOutput: string;
  compatibilityRequest: NonNullable<SandboxGpuCreateFlowInput["createRequest"]> | null;
  allowUnbuiltCompatibilitySource: boolean;
  nativeRuntimeSnapshot: NativeRuntimeSnapshot | null;
  portableLifecycleGeneration: string | null;
};

function withCreateAttemptLabel(
  request: NonNullable<SandboxGpuCreateFlowInput["createRequest"]>,
  value: string,
): NonNullable<SandboxGpuCreateFlowInput["createRequest"]> {
  return Object.freeze({
    ...request,
    labels: Object.freeze({ ...request.labels, [NEMOCLAW_CREATE_ATTEMPT_LABEL]: value }),
  });
}

// A runtime-managed container replacement can briefly observe the original
// container's stale Ready row. Require one confirmation poll before advancing
// to live validation or the GPU proof.
const REPLACEMENT_STABLE_READY_POLLS = 2;
const SANDBOX_READY_PROBE_TIMEOUT_MS = 5_000;
const CREATED_SANDBOX_PUBLICATION_POLL_INTERVAL_SECONDS = 1;

async function streamSandboxCreateWithPublicImageCredentialIsolation<
  T extends StreamSandboxCreateResult,
>(
  isolate: boolean,
  sandboxName: string,
  sandboxEnv: NodeJS.ProcessEnv,
  run: (env: NodeJS.ProcessEnv, dockerClientConfigDirectory: string | null) => Promise<T>,
): Promise<T> {
  if (!isolate) return run(sandboxEnv, null);
  // Detect against the same environment the create command runs with. The
  // sandbox env drops DOCKER_CONFIG and DOCKER_CONTEXT, so process.env can
  // report a credential store or a context the create never uses.
  const prepared = prepareDockerBuildEnvironment({
    env: sandboxEnv,
    allowCredentialIsolation: true,
  });
  try {
    if (prepared.isolatedCredentialConfig) {
      console.log(
        "  Docker Desktop credential helper is unavailable in this WSL session; using an isolated credential-free config for the managed sandbox image pull.",
      );
    }
    return await run(
      mergeIsolatedDockerClientEnv(sandboxEnv, prepared),
      prepared.isolatedCredentialConfig ? (prepared.env.DOCKER_CONFIG ?? null) : null,
    );
  } finally {
    warnIfDockerBuildEnvironmentCleanupFailed(
      prepared.cleanup(),
      `managed sandbox create '${sandboxName}'`,
    );
  }
}

const ANSI_RE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-_])/gu;
const OPENSHELL_SANDBOX_NOT_READY =
  /^Error: code: 'The system is not in a state required for the operation's execution', message: "sandbox is not ready"$/iu;

function createPortableRuntimePatch(
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
  recordLifecycleGeneration: (generation: string) => void,
): SandboxCreateRuntimePatch {
  let applied = false;
  return {
    maybeApplyDuringCreate() {},
    createFailureMessage: () => null,
    exitOnPatchError() {},
    rollbackManagedStartupAfterCreateFailure() {},
    ensureApplied() {
      if (applied) return;
      const generation = (deps.installPortableDemoLifecycle ?? installPortableDemoSandboxLifecycle)(
        input.sandboxName,
        input.sandboxStartupCommand,
        input.hostEnv ?? process.env,
        {
          ...(input.lifecycleGeneration ? { registryGeneration: input.lifecycleGeneration } : {}),
          runtimeAuthority: input.portableRuntimeAuthority ?? null,
        },
      );
      if (!generation) {
        throw new Error(`Portable lifecycle setup did not record sandbox '${input.sandboxName}'.`);
      }
      recordLifecycleGeneration(generation);
      applied = true;
    },
    waitForSupervisorReconnectIfNeeded() {},
    commitAfterReady() {},
    selectedMode: () => null,
    printReadinessFailureIfEnabled() {},
    async verifyGpuOrExit(verifyDirectSandboxGpu) {
      return verifyDirectSandboxGpu(input.sandboxName);
    },
  };
}

async function rollbackNativeGpuFailureForFallback(
  runtimePatch: SandboxCreateRuntimePatch,
): Promise<void> {
  await runtimePatch.rollbackManagedStartupAfterCreateFailure();
}

function normalizedOpenShellCommandOutput(result: { stdout?: unknown; stderr?: unknown }): string {
  return `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`
    .replace(ANSI_RE, "")
    .replace(/[×│]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

type OpenShellSandboxIdentityProbe =
  | { state: "identified"; sandboxId: string }
  | { state: "not_ready" }
  | { state: "failed" };

function remainingReadinessProbeTimeout(getRemainingMs: () => number): number | null {
  const remainingMs = Math.floor(getRemainingMs());
  return remainingMs > 0 ? Math.min(SANDBOX_RECREATE_PROBE_TIMEOUT_MS, remainingMs) : null;
}

function probeExactOpenShellSandboxId(
  sandboxName: string,
  gatewayName: string,
  deps: SandboxGpuCreateFlowDeps,
  getRemainingMs: () => number = () => SANDBOX_RECREATE_PROBE_TIMEOUT_MS,
): OpenShellSandboxIdentityProbe {
  const timeout = remainingReadinessProbeTimeout(getRemainingMs);
  if (timeout === null) return { state: "not_ready" };
  const result = deps.runOpenshell(["sandbox", "get", "-g", gatewayName, sandboxName], {
    ignoreError: true,
    suppressOutput: true,
    timeout,
    killSignal: "SIGKILL",
    killProcessTreeOnTimeout: true,
  });
  if (result.status === 0 && !result.error) {
    const sandboxId = parseOpenShellSandboxId(String(result.stdout ?? ""));
    return sandboxId ? { state: "identified", sandboxId } : { state: "failed" };
  }
  if (result.error || result.status === null || ("signal" in result && result.signal)) {
    return { state: "failed" };
  }
  return OPENSHELL_SANDBOX_NOT_READY.test(normalizedOpenShellCommandOutput(result))
    ? { state: "not_ready" }
    : { state: "failed" };
}

async function verifyCreatedSandboxBeforeEffects(
  sandboxId: string,
  createAttemptNonce: string | undefined,
  route: SelectedDockerGpuRoute,
  input: SandboxGpuCreateFlowInput,
  beforeEffects?: () => unknown | Promise<unknown>,
  afterEffects?: () => void | Promise<void>,
): Promise<void> {
  if (!input.verifyCreatedSandboxBeforeEffects) return;
  await input.verifyCreatedSandboxBeforeEffects(
    {
      sandboxId,
      liveIdentityFingerprint: fingerprintSandboxRecreateValue(sandboxId),
      createAttemptNonce,
      route,
    },
    beforeEffects,
    afterEffects,
  );
}

function requireCompatibilityLifecycleCommand(
  action: "start" | "stop",
  sandboxName: string,
  gatewayName: string,
  deps: SandboxGpuCreateFlowDeps,
): void {
  const result = deps.runOpenshell(["sandbox", action, "-g", gatewayName, sandboxName], {
    ignoreError: true,
    killProcessTreeOnTimeout: true,
    killSignal: "SIGKILL",
    suppressOutput: true,
    timeout: SANDBOX_READY_PROBE_TIMEOUT_MS,
  });
  if (Number(result.status ?? 1) !== 0 || result.error || ("signal" in result && result.signal)) {
    throw new Error(
      `OpenShell could not ${action} sandbox '${sandboxName}' for the exact compatibility cutover.`,
    );
  }
}

function resolveCreateAttemptNonce(
  input: SandboxGpuCreateFlowInput,
  deferPostCreateEffects: boolean,
): string | null {
  const resumedCreateAttemptNonce = input.resumeVerifiedCreate?.createAttemptNonce;
  if (!input.resumeVerifiedCreate) {
    return deferPostCreateEffects
      ? randomBytes(NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH / 2).toString("hex")
      : null;
  }
  if (
    !resumedCreateAttemptNonce &&
    input.resumeVerifiedCreate.route === "compatibility" &&
    input.resumeVerifiedCreate.finalHandoffCommitStarted === true &&
    /^[0-9a-f]{64}$/u.test(input.resumeVerifiedCreate.finalHandoffRuntimeId ?? "")
  ) {
    return null;
  }
  if (
    !resumedCreateAttemptNonce ||
    resumedCreateAttemptNonce.length !== NEMOCLAW_CREATE_ATTEMPT_NONCE_HEX_LENGTH ||
    !/^[0-9a-f]+$/u.test(resumedCreateAttemptNonce)
  ) {
    throw new Error(
      "Verified sandbox recovery has no durable create-attempt authority; refusing continuation.",
    );
  }
  return resumedCreateAttemptNonce;
}

function waitForCreatedOpenShellSandboxPublication(
  sandboxId: string,
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
): void {
  const timeoutMs = Math.max(1, Math.round(input.sandboxReadyTimeoutSecs * 1_000));
  const deadlineMs = Date.now() + timeoutMs;
  const maxPolls =
    Math.ceil(timeoutMs / (CREATED_SANDBOX_PUBLICATION_POLL_INTERVAL_SECONDS * 1_000)) + 1;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const remainingMs = Math.max(1, deadlineMs - Date.now());
    const result = deps.runOpenshell(
      ["sandbox", "get", "-g", input.gatewayName, input.sandboxName],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: Math.min(SANDBOX_READY_PROBE_TIMEOUT_MS, remainingMs),
        killSignal: "SIGKILL",
      },
    );
    if (result.status === 0 && !result.error) {
      const publishedSandboxId = parseOpenShellSandboxId(String(result.stdout ?? ""));
      if (!publishedSandboxId) {
        throw new Error(
          `OpenShell returned no exact durable ID for created sandbox '${input.sandboxName}'.`,
        );
      }
      if (publishedSandboxId !== sandboxId) {
        throw new Error(
          `Created sandbox '${input.sandboxName}' changed identity before identity verification completed.`,
        );
      }
      return;
    }
    if (poll + 1 >= maxPolls || Date.now() >= deadlineMs) break;
    deps.sleep(
      Math.min(
        CREATED_SANDBOX_PUBLICATION_POLL_INTERVAL_SECONDS,
        Math.max(0, (deadlineMs - Date.now()) / 1_000),
      ),
    );
  }
  throw new Error(
    `Created sandbox '${input.sandboxName}' did not become visible through its owning gateway before identity verification completed.`,
  );
}

async function checkRecreatedSandboxReadyIdentity(
  sandboxName: string,
  gatewayName: string,
  expectedSandboxId: string,
  deps: SandboxGpuCreateFlowDeps,
  getRemainingMs: () => number,
): ReturnType<CreatedSandboxReadyIdentityCheck> {
  const identity = probeExactOpenShellSandboxId(sandboxName, gatewayName, deps, getRemainingMs);
  if (identity.state === "not_ready") return "not_ready";
  if (identity.state === "failed") return "probe_failed";
  if (identity.sandboxId !== expectedSandboxId) return "identity_changed";
  return await checkSandboxExecutableReadiness(sandboxName, gatewayName, deps, getRemainingMs);
}

async function checkCreatedSandboxReadyIdentity(
  sandboxName: string,
  gatewayName: string,
  deps: SandboxGpuCreateFlowDeps,
  getRemainingMs: () => number,
): ReturnType<CreatedSandboxReadyIdentityCheck> {
  const identity = probeExactOpenShellSandboxId(sandboxName, gatewayName, deps, getRemainingMs);
  if (identity.state === "not_ready") return "not_ready";
  if (identity.state === "failed") return "probe_failed";
  return await checkSandboxExecutableReadiness(sandboxName, gatewayName, deps, getRemainingMs);
}

async function checkSandboxExecutableReadiness(
  sandboxName: string,
  gatewayName: string,
  deps: SandboxGpuCreateFlowDeps,
  getRemainingMs: () => number,
): ReturnType<CreatedSandboxReadyIdentityCheck> {
  const timeout = remainingReadinessProbeTimeout(getRemainingMs);
  if (timeout === null) return "not_ready";
  const result = await deps.commandExecutor.runBuffered({
    sandboxName,
    target: namedOpenShellGateway(gatewayName),
    command: ["true"],
    timeoutMilliseconds: timeout,
    timeoutKillSignal: "SIGKILL",
  });
  if (result.outcome.kind === "failed") {
    return "probe_failed";
  }
  if (result.outcome.exitCode === 0) return "ready";
  return OPENSHELL_SANDBOX_NOT_READY.test(normalizedOpenShellCommandOutput(result))
    ? "not_ready"
    : "probe_failed";
}

export async function verifySelectedSandboxBridgeReachability(
  input: SandboxGpuCreateFlowInput,
): Promise<void> {
  await verifySandboxBridgeGatewayReachableOrExit(true, {
    skip: false,
    port: input.gatewayPort,
  });
}

function restartInterruptedFinalHandoff(
  input: Pick<SandboxGpuCreateFlowInput, "gatewayName" | "resumeVerifiedCreate" | "sandboxName">,
  deps: Pick<SandboxGpuCreateFlowDeps, "runOpenshell" | "verifyExactFinalHandoffRuntime">,
): void {
  if (input.resumeVerifiedCreate?.finalHandoffCommitStarted !== true) return;
  const replacementRuntimeId = input.resumeVerifiedCreate.finalHandoffRuntimeId;
  if (!replacementRuntimeId) {
    throw new Error(
      "Interrupted Docker final handoff has no durable replacement runtime authority.",
    );
  }
  const verifyExactRuntime =
    deps.verifyExactFinalHandoffRuntime ?? isExactOpenShellDockerSandboxReplacement;
  if (!verifyExactRuntime(input.sandboxName, replacementRuntimeId, false)) {
    throw new Error(
      "Interrupted Docker final handoff could not prove the exact replacement as the sole Docker runtime before restart.",
    );
  }
  deps.runOpenshell(["sandbox", "start", "-g", input.gatewayName, input.sandboxName], {
    ignoreError: true,
    timeout: SANDBOX_RECREATE_PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    killProcessTreeOnTimeout: true,
  });
}

function acknowledgeInterruptedFinalHandoff(
  input: Pick<
    SandboxGpuCreateFlowInput,
    "persistResumedFinalHandoffAcknowledgement" | "resumeVerifiedCreate" | "sandboxName"
  >,
  deps: Pick<SandboxGpuCreateFlowDeps, "verifyExactFinalHandoffRuntime">,
): void {
  if (input.resumeVerifiedCreate?.finalHandoffCommitStarted !== true) return;
  const replacementRuntimeId = input.resumeVerifiedCreate.finalHandoffRuntimeId;
  if (!replacementRuntimeId) {
    throw new Error(
      "Interrupted Docker final handoff has no durable replacement runtime authority.",
    );
  }
  const verifyExactRuntime =
    deps.verifyExactFinalHandoffRuntime ?? isExactOpenShellDockerSandboxReplacement;
  if (!verifyExactRuntime(input.sandboxName, replacementRuntimeId, true)) {
    throw new Error(
      "Interrupted Docker final handoff did not prove the exact replacement as the sole running Docker runtime.",
    );
  }
  input.persistResumedFinalHandoffAcknowledgement?.();
}

function requiresRuntimePatchApplication(input: {
  readonly portableLifecycle: boolean;
  readonly resumedFinalHandoff: boolean;
}): boolean {
  if (input.resumedFinalHandoff) return false;
  return !input.portableLifecycle;
}

export function createSandboxGpuCreateAttemptRunner(
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps & {
    createSandbox: NonNullable<SandboxGpuCreateFlowDeps["createSandbox"]>;
  },
) {
  const portableLifecycle = input.portableLifecycle === true;
  const printCreateFailureDiagnostics =
    deps.printCreateFailureDiagnostics ??
    (input.hermesPortableLifecycle
      ? (sandboxName: string) =>
          console.error(
            `  Hermes portable sandbox '${sandboxName}' did not complete receipt-owned creation. Preserve its lifecycle receipt and resume onboarding after correcting the reported failure.`,
          )
      : printSandboxCreateFailureDiagnostics);
  if (
    portableLifecycle &&
    (input.gpuRoutePlan === "compatibility-only" ||
      input.gpuRoutePlan === "native-with-fallback" ||
      input.initialGpuRoute === "compatibility")
  ) {
    throw new Error(
      "Portable sandbox creation requires native OpenShell GPU injection; Docker GPU compatibility is unavailable.",
    );
  }
  const state: SandboxGpuCreateAttemptState = {
    firstCreateOutput: "",
    compatibilityRequest: null,
    allowUnbuiltCompatibilitySource: false,
    nativeRuntimeSnapshot: null,
    portableLifecycleGeneration: null,
  };
  const revalidatePostCreateEffect = (operation: string): void => {
    if (!input.verifyCreatedSandboxBeforeEffects) return;
    const revalidate = input.revalidateVerifiedSandboxBeforeEffect;
    if (!revalidate) {
      throw new Error("Verified sandbox creation has no post-create effect revalidation.");
    }
    revalidate(operation);
  };
  const captureSandboxReadiness: SandboxGpuCreateFlowDeps["runCaptureOpenshell"] = (
    args,
    options = {},
  ) =>
    deps.runCaptureOpenshell(args, {
      ...options,
      killProcessTreeOnTimeout: true,
      timeout: SANDBOX_READY_PROBE_TIMEOUT_MS,
    });
  const nativeFallbackBaseline =
    !portableLifecycle &&
    input.initialGpuRoute === "native" &&
    input.gpuRoutePlan === "native-with-fallback"
      ? queryOpenShellDockerSandboxContainers(input.sandboxName)
      : null;
  const nativeFallbackHasCleanBaseline =
    nativeFallbackBaseline?.ok === true && nativeFallbackBaseline.ids.length === 0;
  const runAttempt = async (route: SelectedDockerGpuRoute) => {
    const deferPostCreateEffects = input.verifyCreatedSandboxBeforeEffects !== undefined;
    const compatibility = route === "compatibility";
    if (compatibility && input.initialGpuRoute === "native") {
      console.warn(
        "  Native OpenShell GPU onboarding did not complete; retrying once by recreating the OpenShell-managed Docker container with the legacy GPU compatibility envelope.",
      );
      console.warn(
        "  This compatibility container swap may relax container confinement compared with native injection. The retry is running only because NEMOCLAW_DOCKER_GPU_PATCH=fallback explicitly authorized it.",
      );
    }
    const hasRequiredLegacyUlimits =
      input.managedImage !== true && (input.requiredUlimits?.length ?? 0) > 0;
    const unboundAttemptRequest = state.compatibilityRequest ?? input.createRequest;
    if (input.requirePolicylessCreate) {
      if (unboundAttemptRequest.policyPath) {
        throw new Error("APF interceptor sandbox creation must not supply a caller policy.");
      }
    }
    const createAttemptNonce = resolveCreateAttemptNonce(input, deferPostCreateEffects);
    const persistIdentitySettlementRecovery = (
      sandboxIdentityFingerprint: string | null = null,
    ): void => {
      if (!createAttemptNonce) {
        throw new Error("Sandbox create-attempt identity was not generated.");
      }
      const persist = input.persistRetainedSandboxRecovery;
      if (!persist) {
        throw new Error("Verified sandbox creation has no durable recovery evidence owner.");
      }
      const message = formatRetainedSandboxRecoveryMessage({
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
        createAttemptLabel: `${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${createAttemptNonce}`,
        sandboxIdentityFingerprint,
      });
      let persisted = false;
      let persistenceCause: unknown;
      try {
        persisted = sandboxIdentityFingerprint
          ? persist(message, sandboxIdentityFingerprint, createAttemptNonce)
          : persist(message, undefined, createAttemptNonce);
      } catch (error) {
        persistenceCause = error;
      }
      console.error(`  ${message}`);
      if (!persisted) {
        const persistenceFailureMessage =
          "NemoClaw could not save the retained sandbox recovery record for this create attempt.";
        console.error(
          `  ${persistenceFailureMessage} Preserve the registry entry and terminal output; do not delete the sandbox by mutable name.`,
        );
        throw new Error(persistenceFailureMessage, { cause: persistenceCause });
      }
    };
    const waitForCreatedSandboxPublication = (sandboxId: string): void => {
      try {
        waitForCreatedOpenShellSandboxPublication(sandboxId, input, deps);
      } catch (error) {
        persistIdentitySettlementRecovery(fingerprintSandboxRecreateValue(sandboxId));
        throw error;
      }
    };
    const captureRetainedSandboxRecovery = () => {
      if (!input.requirePolicylessCreate || !createAttemptNonce) return {};
      let liveIdentityFingerprint: string | null = null;
      try {
        const sandboxId = resolveCreatedOpenShellSandboxId({
          sandboxName: input.sandboxName,
          gatewayName: input.gatewayName,
          createAttemptNonce,
          runCaptureOpenshell: deps.runCaptureOpenshell,
        });
        liveIdentityFingerprint = fingerprintSandboxRecreateValue(sandboxId);
      } catch {
        // The nonce remains durable recovery evidence when identity lookup is unavailable.
      }
      return {
        retainedSandboxRecovery: {
          createAttemptNonce,
          liveIdentityFingerprint,
        },
      } as const;
    };
    const attemptRequest = createAttemptNonce
      ? withCreateAttemptLabel(unboundAttemptRequest, createAttemptNonce)
      : unboundAttemptRequest;
    const createFailureRecoveryEvidence = () => ({
      createContext: createSandboxRecoveryContext(attemptRequest),
    });
    const persistRestartSafeStartup =
      input.persistStartupCommand === true &&
      (route !== "native" || !input.terminalAgent || hasRequiredLegacyUlimits);
    const deferRestartSafeCutover =
      !portableLifecycle &&
      input.managedImage !== true &&
      !compatibility &&
      persistRestartSafeStartup;
    const portableRuntimePatch = portableLifecycle
      ? createPortableRuntimePatch(input, deps, (generation) => {
          state.portableLifecycleGeneration = generation;
        })
      : null;
    const runtimePatch = portableRuntimePatch
      ? portableRuntimePatch
      : createDockerGpuSandboxCreatePatch({
          route,
          // Managed images already launch their canonical command directly and must
          // keep the exact runtime OpenShell created. Legacy/custom images retain the
          // restart-safe clone used to persist commands and DCode resource limits.
          persistStartupCommand: persistRestartSafeStartup,
          // Native managed images keep the exact runtime OpenShell created.
          // The explicit compatibility route still requires NemoClaw's
          // Docker recreation to attach the complete legacy GPU envelope;
          // OpenShell's compatibility create alone can expose nvidia-smi
          // without mounting a usable libcuda.so.1.
          externalRecreation: input.managedImage === true && !compatibility,
          sandboxName: input.sandboxName,
          gpuDevice: input.sandboxGpuConfig.sandboxGpuDevice,
          openshellSandboxCommand: input.sandboxStartupCommand,
          requiredUlimits: input.managedImage === true ? null : input.requiredUlimits,
          timeoutSecs: input.sandboxReadyTimeoutSecs,
          backend: input.sandboxGpuConfig.hostGpuPlatform === "jetson" ? "jetson" : "generic",
          deps,
        });
    const inspectNativeRuntime = (): NativeRuntimeSnapshot | null => {
      const expectedContainerId = runtimePatch.replacementRuntimeId?.() ?? null;
      const snapshot = expectedContainerId
        ? queryOpenShellDockerSandboxRuntimeSnapshot(input.sandboxName, {}, { expectedContainerId })
        : queryOpenShellDockerSandboxRuntimeSnapshot(input.sandboxName);
      return snapshot.ok ? snapshot : null;
    };
    let readyCheckCreatedSandboxId: string | null = null;
    let readyCheckCreatedIdentityFailure: unknown = null;
    const failReadyCheckCreatedIdentity = (diagnostic: string): true => {
      readyCheckCreatedIdentityFailure = new Error(
        `OpenShell did not return the exact created identity for sandbox '${input.sandboxName}'. Diagnostic class: ${diagnostic}.`,
      );
      return true;
    };
    const settleCreatedIdentity = (): string => {
      if (readyCheckCreatedIdentityFailure !== null) throw readyCheckCreatedIdentityFailure;
      const sandboxId = settleCreatedOpenShellSandboxId({
        sandboxName: input.sandboxName,
        gatewayName: input.gatewayName,
        createAttemptNonce: createAttemptNonce!,
        runCaptureOpenshell: deps.runCaptureOpenshell,
        priorSandboxId: readyCheckCreatedSandboxId,
        sleep: (milliseconds) => deps.sleep(milliseconds / 1000),
      });
      if (readyCheckCreatedSandboxId && sandboxId !== readyCheckCreatedSandboxId) {
        throw new Error("OpenShell create-attempt identity changed after the Ready handoff.");
      }
      return sandboxId;
    };
    const settleAmbiguousCreateResult = (
      createResult: StreamSandboxCreateResult | null,
      ambiguous: boolean,
    ): string | null => {
      if (!ambiguous || !createResult) return null;
      if (!deferPostCreateEffects) {
        throw new Error(
          `OpenShell did not confirm whether sandbox '${input.sandboxName}' was created. Preserve the terminal output and do not submit another create attempt until OpenShell confirms identity or absence.`,
        );
      }
      let sandboxId: string;
      try {
        sandboxId = settleCreatedIdentity();
      } catch (error) {
        persistIdentitySettlementRecovery();
        throw new Error(
          `Sandbox '${input.sandboxName}' was created, but OpenShell did not return one exact durable sandbox identity before post-create effects.`,
          { cause: error },
        );
      }
      if (createResult.status !== 0 && input.requirePolicylessCreate) {
        const failure = classifySandboxCreateFailure(createResult.output);
        if (failure.kind !== "sandbox_create_incomplete") {
          persistIdentitySettlementRecovery(fingerprintSandboxRecreateValue(sandboxId));
          reportSandboxCreateFailure(
            {
              sandboxName: input.sandboxName,
              createStatus: createResult.status,
              createOutput: createResult.output,
              restoreBackupPath: input.restoreBackupPath,
              ...createFailureRecoveryEvidence(),
            },
            {
              classifyCreateFailure: classifySandboxCreateFailure,
              printCreateFailureDiagnostics,
              printRecoveryHints: printSandboxCreateRecoveryHints,
              warn: (message) => console.warn(message),
              error: (message) => console.error(message),
              exitProcess: (code) => process.exit(code),
            },
          );
        }
      }
      return sandboxId;
    };
    let createdSandboxVerified = false;
    let compatibilityCreatePollError: unknown = null;
    const applyVerifiedCompatibilityCutover = async (): Promise<string | null> => {
      revalidatePostCreateEffect(`apply runtime patch for sandbox '${input.sandboxName}'`);
      requireCompatibilityLifecycleCommand("stop", input.sandboxName, input.gatewayName, deps);
      revalidatePostCreateEffect(`confirm stopped compatibility sandbox '${input.sandboxName}'`);
      await runtimePatch.ensureApplied();
      await runtimePatch.exitOnPatchError();
      return runtimePatch.replacementRuntimeId?.() ?? null;
    };
    const publishVerifiedCompatibilityCutover = async (): Promise<void> => {
      revalidatePostCreateEffect(`publish replacement runtime for sandbox '${input.sandboxName}'`);
      requireCompatibilityLifecycleCommand("start", input.sandboxName, input.gatewayName, deps);
    };
    const verifyAndPatchCompatibilityDuringCreate = async (): Promise<void> => {
      if (!compatibility || !deferPostCreateEffects || !createAttemptNonce) return;
      if (!createdSandboxVerified) {
        const list = deps.runCaptureOpenshell(["sandbox", "list", "-g", input.gatewayName], {
          ignoreError: true,
          killProcessTreeOnTimeout: true,
          timeout: SANDBOX_READY_PROBE_TIMEOUT_MS,
        });
        if (!sandboxGpuCreateAttempt.hasSandboxListEntry(list, input.sandboxName)) return;
        const observation = observeCreatedOpenShellSandboxId(
          {
            sandboxName: input.sandboxName,
            gatewayName: input.gatewayName,
            createAttemptNonce,
            runCaptureOpenshell: captureSandboxReadiness,
          },
          SANDBOX_READY_PROBE_TIMEOUT_MS,
        );
        if (observation.state === "invalid") {
          // During creation OpenShell can publish the row before its selector
          // and metadata views settle. No invalid observation authorizes a
          // mutation; retry until one strict nonce-owned row is available.
          return;
        }
        if (observation.sandboxId === null) return;
        if (readyCheckCreatedSandboxId && observation.sandboxId !== readyCheckCreatedSandboxId) {
          throw new Error("OpenShell create-attempt identity changed during initial cutover.");
        }
        readyCheckCreatedSandboxId = observation.sandboxId;
        if (observation.state === "pending") return;
        if (!sandboxGpuCreateAttempt.isSandboxReady(list, input.sandboxName)) return;
        const sandboxId = observation.sandboxId;
        const containers = queryOpenShellDockerSandboxContainers(input.sandboxName);
        if (!containers.ok || containers.ids.length !== 1) return;
        const runtimeId = containers.ids[0];
        const verifyExactRuntime =
          deps.verifyExactFinalHandoffRuntime ?? isExactOpenShellDockerSandboxReplacement;
        if (!runtimeId || !verifyExactRuntime(input.sandboxName, runtimeId, true)) return;
        waitForCreatedSandboxPublication(sandboxId);
        await verifyCreatedSandboxBeforeEffects(
          sandboxId,
          createAttemptNonce,
          route,
          input,
          applyVerifiedCompatibilityCutover,
          publishVerifiedCompatibilityCutover,
        );
        createdSandboxVerified = true;
      }
    };
    const streamCreate = async () => {
      const createResult = await streamSandboxCreateWithPublicImageCredentialIsolation(
        input.managedImage === true,
        input.sandboxName,
        input.sandboxEnv,
        (createEnv, dockerClientConfigDirectory) => {
          const createOptions = {
            readyCheck: () => {
              const list = deps.runCaptureOpenshell(["sandbox", "list", "-g", input.gatewayName], {
                ignoreError: true,
                killProcessTreeOnTimeout: true,
                timeout: SANDBOX_READY_PROBE_TIMEOUT_MS,
              });
              const ready = sandboxGpuCreateAttempt.isSandboxReady(list, input.sandboxName);
              if (
                ready &&
                compatibility &&
                deferPostCreateEffects &&
                (!createdSandboxVerified || !runtimePatch.replacementRuntimeId?.())
              ) {
                return false;
              }
              if (!ready || !createAttemptNonce) return ready;
              const observation = observeCreatedOpenShellSandboxId(
                {
                  sandboxName: input.sandboxName,
                  gatewayName: input.gatewayName,
                  createAttemptNonce,
                  runCaptureOpenshell: captureSandboxReadiness,
                },
                SANDBOX_READY_PROBE_TIMEOUT_MS,
              );
              if (observation.state === "invalid") {
                return failReadyCheckCreatedIdentity(observation.diagnostic);
              }
              if (observation.sandboxId === null) {
                return readyCheckCreatedSandboxId
                  ? failReadyCheckCreatedIdentity("selector-identity-disappeared")
                  : false;
              }
              if (
                readyCheckCreatedSandboxId &&
                observation.sandboxId !== readyCheckCreatedSandboxId
              ) {
                return failReadyCheckCreatedIdentity("selector-identity-changed");
              }
              readyCheckCreatedSandboxId = observation.sandboxId;
              // End only the create-client handoff. Strict metadata settlement still
              // runs before any post-create effect.
              return true;
            },
            ...(deferPostCreateEffects
              ? compatibility
                ? {
                    onPoll: async () => {
                      try {
                        await verifyAndPatchCompatibilityDuringCreate();
                      } catch (error) {
                        compatibilityCreatePollError = error;
                        throw error;
                      }
                    },
                  }
                : {}
              : {
                  onPoll: () => {
                    if (!deferRestartSafeCutover) void runtimePatch.maybeApplyDuringCreate();
                  },
                }),
            readyCheckOutputPatterns: getReadyCheckOutputPatternsForAgent({
              isTerminalAgent: input.terminalAgent,
              startupRunsDuringCreate: true,
              env: createEnv,
            }),
            failureCheck: runtimePatch.createFailureMessage,
            traceEvent: addTraceEvent,
            waitForReadyTermination: deferRestartSafeCutover || deferPostCreateEffects,
            initialPhase:
              compatibility && (input.prebuild.imageRef || state.compatibilityRequest)
                ? "create"
                : undefined,
          } as const;
          return deps.createSandbox(
            Object.freeze({
              ...attemptRequest,
              environment: Object.freeze({ ...createEnv }),
              ...(dockerClientConfigDirectory ? { dockerClientConfigDirectory } : {}),
            }),
            createOptions,
          );
        },
      );
      if (compatibilityCreatePollError !== null) throw compatibilityCreatePollError;
      if (createResult.readyTerminationTimedOut) {
        if (createAttemptNonce) {
          persistIdentitySettlementRecovery(
            readyCheckCreatedSandboxId
              ? fingerprintSandboxRecreateValue(readyCheckCreatedSandboxId)
              : null,
          );
        }
        throw new Error(
          createAttemptNonce
            ? `OpenShell create client did not exit after Ready for sandbox '${input.sandboxName}'. NemoClaw retained the sandbox and blocked post-create effects. Follow the retained recovery action above.`
            : `OpenShell create client did not exit after Ready for sandbox '${input.sandboxName}'. NemoClaw blocked post-create effects. No create-attempt identity was available for retained recovery. Preserve the registry entry and terminal output; do not delete the sandbox by mutable name.`,
        );
      }
      return createResult;
    };
    let createResult: Awaited<ReturnType<typeof deps.createSandbox>> | null = null;
    let resumedSandboxId: string | null = null;
    const failAfterCreatedSandboxVerification = (message: string, status: number): never => {
      if (createdSandboxVerified) throw new Error(message);
      return process.exit(status);
    };
    if (input.resumeVerifiedCreate) {
      if (route !== input.resumeVerifiedCreate.route) {
        throw new Error("Verified sandbox recovery route changed before continuation.");
      }
      const identity = probeExactOpenShellSandboxId(input.sandboxName, input.gatewayName, deps);
      if (identity.state !== "identified") {
        throw new Error(
          `Cannot resume sandbox '${input.sandboxName}': its exact live identity is unavailable.`,
        );
      }
      const liveIdentityFingerprint = fingerprintSandboxRecreateValue(identity.sandboxId);
      if (liveIdentityFingerprint !== input.resumeVerifiedCreate.liveIdentityFingerprint) {
        throw new Error(
          `Cannot resume sandbox '${input.sandboxName}': its live identity changed after the verified checkpoint.`,
        );
      }
      resumedSandboxId = identity.sandboxId;
      await verifyCreatedSandboxBeforeEffects(
        identity.sandboxId,
        createAttemptNonce ?? undefined,
        route,
        input,
      );
      createdSandboxVerified = true;
    } else {
      createResult = await streamCreate();
    }
    if (createResult && !state.firstCreateOutput) state.firstCreateOutput = createResult.output;
    if (!deferPostCreateEffects) await runtimePatch.exitOnPatchError();
    const createSubmissionAmbiguous =
      createResult !== null && "ambiguous" in createResult && createResult.ambiguous === true;
    const settledAmbiguousSandboxId = settleAmbiguousCreateResult(
      createResult,
      createSubmissionAmbiguous,
    );
    if (createResult && createResult.status !== 0 && !createSubmissionAmbiguous) {
      const failure = classifySandboxCreateFailure(createResult.output);
      let nativeCreateRejectedBeforeProgress = false;
      if (failure.kind === "sandbox_create_incomplete") {
        console.warn("");
        console.warn(
          `  Create stream exited with code ${createResult.status} after sandbox was created.`,
        );
        console.warn("  Checking whether the sandbox reaches Ready state...");
      } else if (
        route === "native" &&
        input.gpuRoutePlan === "native-with-fallback" &&
        nativeFallbackHasCleanBaseline &&
        (() => {
          if (
            sandboxGpuCreateAttempt.isNativeGpuCreateRoutingFailure(createResult.output, {
              sawProgress: createResult.sawProgress,
            })
          ) {
            nativeCreateRejectedBeforeProgress = true;
            state.allowUnbuiltCompatibilitySource = input.prebuild.imageRef === null;
            return true;
          }
          const snapshot = inspectNativeRuntime();
          if (
            snapshot &&
            sandboxGpuCreateAttempt.isTrustedNativeGpuRuntimeError(snapshot.stateError)
          ) {
            state.nativeRuntimeSnapshot = snapshot;
            return true;
          }
          return false;
        })()
      ) {
        if (nativeCreateRejectedBeforeProgress) {
          await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        } else {
          await rollbackNativeGpuFailureForFallback(runtimePatch);
        }
        return {
          ok: false,
          route,
          stage: "create",
          error: new Error("Native OpenShell GPU sandbox creation was rejected."),
          fallbackEligible: true,
          ...captureRetainedSandboxRecovery(),
          ...(nativeCreateRejectedBeforeProgress
            ? { nativeCreateRejectedBeforeProgress: true as const }
            : {}),
        } as const;
      } else {
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        reportSandboxCreateFailure(
          {
            sandboxName: input.sandboxName,
            createStatus: createResult.status,
            createOutput: createResult.output,
            restoreBackupPath: input.restoreBackupPath,
            ...createFailureRecoveryEvidence(),
          },
          {
            classifyCreateFailure: classifySandboxCreateFailure,
            printCreateFailureDiagnostics,
            printRecoveryHints: printSandboxCreateRecoveryHints,
            warn: (message) => console.warn(message),
            error: (message) => console.error(message),
            exitProcess: (code) => process.exit(code),
          },
        );
      }
    }
    if (!createdSandboxVerified && deferPostCreateEffects) {
      if (!createAttemptNonce) {
        throw new Error("Sandbox create-attempt identity was not generated.");
      }
      let sandboxId: string;
      try {
        sandboxId = settledAmbiguousSandboxId ?? settleCreatedIdentity();
      } catch (error) {
        persistIdentitySettlementRecovery();
        throw new Error(
          `Sandbox '${input.sandboxName}' was created, but OpenShell did not return one exact durable sandbox identity before post-create effects.`,
          { cause: error },
        );
      }
      waitForCreatedSandboxPublication(sandboxId);
      await verifyCreatedSandboxBeforeEffects(
        sandboxId,
        createAttemptNonce!,
        route,
        input,
        compatibility ? applyVerifiedCompatibilityCutover : undefined,
        compatibility ? publishVerifiedCompatibilityCutover : undefined,
      );
      createdSandboxVerified = true;
    }
    if (deferPostCreateEffects) {
      revalidatePostCreateEffect(`validate runtime patch for sandbox '${input.sandboxName}'`);
      await runtimePatch.exitOnPatchError();
    }
    const preRecreateIdentity =
      deferRestartSafeCutover && !resumedSandboxId
        ? probeExactOpenShellSandboxId(input.sandboxName, input.gatewayName, deps)
        : null;
    const expectedRecreatedSandboxId =
      resumedSandboxId ??
      (preRecreateIdentity?.state === "identified" ? preRecreateIdentity.sandboxId : null);
    if (deferRestartSafeCutover && !expectedRecreatedSandboxId) {
      console.error("");
      console.error(
        `  Sandbox '${input.sandboxName}' reached Ready, but OpenShell did not return one exact durable sandbox ID before runtime recreation.`,
      );
      printCreateFailureDiagnostics(input.sandboxName, {
        backupPath: input.restoreBackupPath,
      });
      failAfterCreatedSandboxVerification(
        `Sandbox '${input.sandboxName}' did not return one exact durable sandbox ID before runtime recreation after verified creation.`,
        createResult?.status === 0 ? 1 : (createResult?.status ?? 1),
      );
    }
    if (
      requiresRuntimePatchApplication({
        portableLifecycle,
        resumedFinalHandoff: input.resumeVerifiedCreate?.finalHandoffCommitStarted === true,
      })
    ) {
      revalidatePostCreateEffect(`apply runtime patch for sandbox '${input.sandboxName}'`);
      await runtimePatch.ensureApplied();
    }
    await runtimePatch.waitForSupervisorReconnectIfNeeded();
    revalidatePostCreateEffect(`reconnect sandbox supervisor for '${input.sandboxName}'`);
    restartInterruptedFinalHandoff(input, deps);
    console.log("  Waiting for sandbox to become ready...");
    const readiness = await sandboxReadinessTracing.waitForCreatedSandboxReadyWithTrace({
      sandboxName: input.sandboxName,
      timeoutSecs: input.sandboxReadyTimeoutSecs,
      observer: deps.sandboxObserver,
      target: { kind: "named", gatewayName: input.gatewayName },
      stableReadyPolls:
        compatibility || expectedRecreatedSandboxId ? REPLACEMENT_STABLE_READY_POLLS : 1,
      checkReadyIdentity: expectedRecreatedSandboxId
        ? (getRemainingMs = () => SANDBOX_RECREATE_PROBE_TIMEOUT_MS) =>
            checkRecreatedSandboxReadyIdentity(
              input.sandboxName,
              input.gatewayName,
              expectedRecreatedSandboxId,
              deps,
              getRemainingMs,
            )
        : input.terminalAgent
          ? undefined
          : (getRemainingMs = () => SANDBOX_RECREATE_PROBE_TIMEOUT_MS) =>
              checkCreatedSandboxReadyIdentity(
                input.sandboxName,
                input.gatewayName,
                deps,
                getRemainingMs,
              ),
      sleep: deps.sleep,
    });
    if (!readiness.ready) {
      console.error("");
      sandboxReadinessTracing.printReadinessFailure(
        readiness,
        input.sandboxName,
        input.sandboxReadyTimeoutSecs,
      );
      const canClassifyNativeReadiness =
        route === "native" &&
        input.gpuRoutePlan === "native-with-fallback" &&
        nativeFallbackHasCleanBaseline;
      const runtimeSnapshot = canClassifyNativeReadiness ? inspectNativeRuntime() : null;
      if (
        canClassifyNativeReadiness &&
        runtimeSnapshot &&
        sandboxGpuCreateAttempt.isNativeGpuReadinessRoutingFailure({
          failurePhase: readiness.failurePhase,
          runtimeError: runtimeSnapshot.stateError,
        })
      ) {
        state.nativeRuntimeSnapshot = runtimeSnapshot;
        await rollbackNativeGpuFailureForFallback(runtimePatch);
        return {
          ok: false,
          route,
          stage: "readiness",
          error: new Error(
            `Native OpenShell GPU sandbox did not become ready${readiness.failurePhase ? ` (${readiness.failurePhase})` : ""}.`,
          ),
          fallbackEligible: true,
          ...captureRetainedSandboxRecovery(),
        } as const;
      }
      await runtimePatch.rollbackManagedStartupAfterCreateFailure();
      printCreateFailureDiagnostics(input.sandboxName, {
        backupPath: input.restoreBackupPath,
      });
      if (compatibility) runtimePatch.printReadinessFailureIfEnabled();
      else if (expectedRecreatedSandboxId) {
        console.error(
          "  NemoClaw did not start dashboard forwarding. NemoClaw left the sandbox in place for inspection and recovery.",
        );
      } else if (portableLifecycle) {
        console.error(
          "  NemoClaw left the portable sandbox in place because it could not verify the exact runtime identity.",
        );
      } else {
        console.error(
          `  NemoClaw left sandbox '${input.sandboxName}' in place because OpenShell can delete it only by mutable name.`,
        );
        console.error(
          `  Recovery remains blocked while this sandbox exists. Do not delete it by mutable name; run 'nemoclaw ${input.sandboxName} destroy' to check for authoritative absence.`,
        );
      }
      failAfterCreatedSandboxVerification(
        `Sandbox '${input.sandboxName}' did not become ready after verified creation.`,
        createResult?.status === 0 ? 1 : (createResult?.status ?? 1),
      );
    }
    acknowledgeInterruptedFinalHandoff(input, deps);
    if (input.sandboxGpuConfig.sandboxGpuEnabled) {
      revalidatePostCreateEffect(`verify GPU access for sandbox '${input.sandboxName}'`);
      const deferNativeProofFailure =
        route === "native" &&
        input.gpuRoutePlan === "native-with-fallback" &&
        nativeFallbackHasCleanBaseline;
      let proof: SandboxGpuProofResult;
      try {
        proof = await dockerGpuLocalInference.verifyGpuSandboxAccessAfterReady(
          input.sandboxGpuConfig,
          {
            sandboxName: input.sandboxName,
            dockerDriverGateway: input.dockerDriverGateway,
            selectedRoute: route,
            verifyDirectSandboxGpu: deps.verifyDirectSandboxGpu,
            verifyGpuOrExit: deferNativeProofFailure ? undefined : runtimePatch.verifyGpuOrExit,
            reportGpuProofFailure: !deferNativeProofFailure,
            selectedMode: runtimePatch.selectedMode,
            runCaptureOpenshell: deps.runCaptureOpenshell,
            log: console.log,
          },
        );
      } catch (error) {
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        throw error;
      }
      if (deferNativeProofFailure && proof.status === "failed") {
        if (sandboxGpuPreflight.isExplicitNvidiaSmiDriverProofFailure(proof)) {
          const snapshot = inspectNativeRuntime();
          if (snapshot?.nativeGpuAttachmentState === "absent") {
            state.nativeRuntimeSnapshot = snapshot;
            await rollbackNativeGpuFailureForFallback(runtimePatch);
            return {
              ok: false,
              route,
              stage: "gpu-proof",
              error: new Error(
                "Native OpenShell GPU proof failed and the host confirms no GPU attachment.",
              ),
              fallbackEligible: true,
              ...captureRetainedSandboxRecovery(),
            } as const;
          }
        }
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        console.error("");
        console.error("  Native sandbox GPU proof failed.");
        console.error(
          "  Sandbox-reported GPU output without corroborating host evidence cannot authorize a less-confined compatibility retry.",
        );
        console.error(
          "  To explicitly select the compatibility route, clean up the sandbox and retry with NEMOCLAW_DOCKER_GPU_PATCH=1.",
        );
        failAfterCreatedSandboxVerification(
          `Sandbox '${input.sandboxName}' failed GPU proof after verified creation.`,
          1,
        );
      }
      if (proof.status === "failed") {
        await runtimePatch.rollbackManagedStartupAfterCreateFailure();
        throw new Error("Sandbox GPU proof returned failed status.");
      }
    }
    if (portableRuntimePatch) {
      revalidatePostCreateEffect(`install portable lifecycle for sandbox '${input.sandboxName}'`);
      await portableRuntimePatch.ensureApplied();
    }
    // GPU-enabled cutover stays reversible until the caller also proves the
    // configured host-local inference path. Non-GPU workloads have completed
    // their final authoritative Ready gate here.
    if (!input.sandboxGpuConfig.sandboxGpuEnabled) {
      revalidatePostCreateEffect(`commit runtime readiness for sandbox '${input.sandboxName}'`);
      await runtimePatch.commitAfterReady({
        beforeFinalHandoff: input.persistFinalHandoffCommitStarted,
      });
    }
    return {
      ok: true,
      route,
      value: createResult ? { createResult, runtimePatch } : { runtimePatch },
    } as const;
  };

  return { state, runAttempt };
}
