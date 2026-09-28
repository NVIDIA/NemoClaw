// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import type { OpenShellSandboxObserver } from "../adapters/openshell/sandbox-observer";
import {
  type CreateOpenShellSandboxRequest,
  type OpenShellSandboxLifecycle,
  withoutOpenShellSandboxCreateGpu,
} from "../adapters/openshell/sandbox-lifecycle";
import { createCliOpenShellSandboxLifecycleFromRunner } from "../adapters/openshell/sandbox-lifecycle-cli";
import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";
import { NEMOCLAW_CREATE_ATTEMPT_LABEL } from "../adapters/openshell/sandbox-identity";
import type { StreamSandboxCreateResult } from "../sandbox/create-stream";
import { redactFull } from "../security/redact";
import type { CheckpointPortableRuntimeAuthority } from "../state/onboard-checkpoint-types";
import { parsePortableRuntimeAuthority } from "../state/onboard/portable-runtime-authority";
import type { SandboxEntry, SandboxGpuProofResult } from "../state/registry";
import * as dockerGpuLocalInference from "./docker-gpu-local-inference";
import { collectDockerGpuPatchDiagnostics } from "./docker-gpu-patch";
import type {
  DockerGpuPatchDeps,
  DockerUlimit,
  SandboxCreateRuntimePatch,
} from "./docker-gpu-patch-types";
import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import { adaptDockerGpuRouteForPatch } from "./docker-gpu-route-patch-adapter";
import { resolveDockerStartupCommandPatch } from "./docker-startup-command-agent";
import {
  bindHermesPortableOnboardingLifecycleLock,
  classifyHermesPortableRegistry,
  createHermesPortableChildEnvironment,
  createHermesPortableContainerDeps,
  createHermesPortableOpenShellCapture,
  createHermesPortableReadyCapture,
  createHermesPortableReadyRunner,
  defaultHermesPortableStateDir,
  isHermesPortableLifecycleMode,
  observeHermesPortableSandbox,
  runHermesPortableOnboardingFromOnboard,
  runHermesPortableOnboardingTransaction,
  shouldManageHermesPortableDashboard,
} from "./experimental/hermes-portable-onboarding";
import { installPortableDemoSandboxLifecycle } from "./experimental/portable-demo-lifecycle";
import {
  buildHermesPortableCommandAuthority,
  buildHermesPortableOnboardingCommandAuthority,
  inspectPortableAgentReceiptDisposition,
} from "./experimental/portable-agent-lifecycle";
import { isPortableExperimentalProfile } from "./experimental/portable-profile";
import { isImmutableDockerImageId } from "./openshell-docker-sandbox-containers";
import * as sandboxGpuCreateAttempt from "./sandbox-gpu-create-attempt";
import {
  createSandboxGpuCreateAttemptRunner,
  verifySelectedSandboxBridgeReachability,
} from "./sandbox-gpu-create-run-attempt";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import {
  createDirectSandboxGpuVerifier,
  type DirectSandboxGpuVerifierDeps,
  type VerifyDirectSandboxGpu,
} from "./sandbox-gpu-preflight";
import type { SandboxPrebuildResult } from "./sandbox-prebuild";
import { addTraceEvent } from "./tracing";

export { resolveDockerStartupCommandPatch } from "./docker-startup-command-agent";
export {
  bindHermesPortableOnboardingLifecycleLock,
  classifyHermesPortableRegistry,
  createHermesPortableChildEnvironment,
  createHermesPortableContainerDeps,
  createHermesPortableOpenShellCapture,
  createHermesPortableReadyCapture,
  createHermesPortableReadyRunner,
  defaultHermesPortableStateDir,
  observeHermesPortableSandbox,
  runHermesPortableOnboardingFromOnboard,
  runHermesPortableOnboardingTransaction,
  shouldManageHermesPortableDashboard,
  buildHermesPortableCommandAuthority,
  inspectPortableAgentReceiptDisposition,
};
export type HermesPortableReadyCapture = ReturnType<typeof createHermesPortableReadyCapture>;
export type HermesPortableReadyRunner = ReturnType<typeof createHermesPortableReadyRunner>;

/** Release the exit cleanup listener only after its exact create source was retired. */
export function cleanupSandboxCreateSource(
  cleanup: (() => boolean) | undefined,
  options: { readonly exactCleanup?: () => boolean; readonly requireExact?: boolean } = {},
): boolean {
  if (options.requireExact && cleanup && !options.exactCleanup) {
    throw new Error("Hermes portable temporary policy source has no exact cleanup authority.");
  }
  const selected = options.exactCleanup ?? cleanup;
  if (!selected) return true;
  const completed = selected();
  if (completed && cleanup) process.removeListener("exit", cleanup);
  return completed;
}

/** Bind the exact create-source retirement decision without moving its execution point. */
export function createSandboxCreateSourceCleanup(
  source: { readonly cleanup?: () => boolean; readonly cleanupExact?: () => boolean },
  requireExact: boolean,
): () => boolean {
  let completed = false;
  return () => {
    if (completed) return true;
    completed = cleanupSandboxCreateSource(source.cleanup, {
      exactCleanup: source.cleanupExact,
      requireExact,
    });
    return completed;
  };
}

/** Bind cleanup for the one staged build context owned by this create attempt. */
export function createSandboxBuildContextCleanup(
  context: { readonly cleanupBuildCtx?: () => boolean } | null,
): () => boolean {
  let completed = false;
  return () => {
    if (completed) return true;
    if (!context?.cleanupBuildCtx) return true;
    completed = context.cleanupBuildCtx();
    if (completed) process.removeListener("exit", context.cleanupBuildCtx);
    return completed;
  };
}

export function resolvePortableLifecycleMode(
  agent: AgentDefinition | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isPortableExperimentalProfile(env) && (agent?.name ?? "openclaw") === "openclaw";
}

/** Resolve the checkpoint-owned authority required by exported portable creation helpers. */
export function resolveExportedPortableRuntimeAuthority(
  env: NodeJS.ProcessEnv,
  loadSession: () => {
    checkpoint?: {
      profile: { kind: "selected"; value: "default" | "portable" };
      runtimeAuthority:
        | { kind: "unset" }
        | { kind: "selected"; value: CheckpointPortableRuntimeAuthority };
    } | null;
  } | null,
): CheckpointPortableRuntimeAuthority | null {
  if (!isPortableExperimentalProfile(env)) return null;
  const checkpoint = loadSession()?.checkpoint;
  const authority =
    checkpoint?.profile.value === "portable" && checkpoint.runtimeAuthority.kind === "selected"
      ? parsePortableRuntimeAuthority(checkpoint.runtimeAuthority.value)
      : null;
  if (authority) return authority;
  throw new Error(
    "Portable sandbox creation requires checkpoint-owned Podman runtime authority before creation begins.",
  );
}

export function resolveAgentCreateInput(
  agent: AgentDefinition | null,
  dockerDriverGateway: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  return {
    dockerDriverGateway,
    ...resolveDockerStartupCommandPatch(agent, dockerDriverGateway, env),
    portableLifecycle: resolvePortableLifecycleMode(agent, env),
    hermesPortableLifecycle: isHermesPortableLifecycleMode(agent, env),
  };
}

/*
 * Keep recovery rendering at this public command boundary. Providers own the
 * detail and remediation; central orchestration only renders their bounded,
 * identity-bound evidence and never branches on provider IDs or error codes.
 */
type RunOpenshell = NonNullable<DockerGpuPatchDeps["runOpenshell"]>;
type RunCaptureOpenshell = NonNullable<DockerGpuPatchDeps["runCaptureOpenshell"]>;
type Sleep = NonNullable<DockerGpuPatchDeps["sleep"]>;
type LifecycleRegistrationFields = Pick<SandboxEntry, "lifecycleGeneration">;

export interface SandboxGpuCreateFlowInput {
  sandboxName: string;
  /** Resume the exact sandbox retained after its verified-create checkpoint was persisted. */
  resumeVerifiedCreate?: {
    readonly route: SelectedDockerGpuRoute;
    readonly liveIdentityFingerprint: string;
    readonly createAttemptNonce?: string;
    readonly finalHandoffCommitStarted?: true;
    readonly finalHandoffRuntimeId?: string;
  };
  /** Reject every initial or fallback create attempt that carries a caller policy. */
  requirePolicylessCreate?: true;
  /** Durably retain exact create-attempt recovery evidence before identity-bound recovery stops. */
  persistRetainedSandboxRecovery?: (
    message: string,
    sandboxIdentityFingerprint?: string,
    createAttemptNonce?: string,
  ) => boolean;
  provider: string;
  sandboxGpuConfig: SandboxGpuConfig;
  gpuRoutePlan: import("./docker-gpu-route").DockerGpuRoutePlan;
  initialGpuRoute: SelectedDockerGpuRoute;
  compatibilityPolicyPath: string | null;
  dockerDriverGateway: boolean;
  gatewayName: string;
  gatewayPort: number;
  sandboxReadyTimeoutSecs: number;
  /** Semantic request consumed by the selected OpenShell lifecycle adapter. */
  createRequest: CreateOpenShellSandboxRequest;
  /** Host-side runtime environment used only by the selected lifecycle provider. */
  hostEnv?: NodeJS.ProcessEnv;
  portableLifecycle?: boolean;
  hermesPortableLifecycle?: boolean;
  sandboxEnv: NodeJS.ProcessEnv;
  sandboxStartupCommand: string[];
  lifecycleGeneration?: SandboxEntry["lifecycleGeneration"];
  portableRuntimeAuthority?: CheckpointPortableRuntimeAuthority | null;
  prebuild: Omit<SandboxPrebuildResult, "createArgs">;
  restoreBackupPath: string | null;
  terminalAgent: boolean;
  persistStartupCommand?: boolean;
  managedImage?: boolean;
  requiredUlimits?: readonly DockerUlimit[] | null;
  /**
   * Verify the exact sandbox created by each attempt before runtime activation,
   * readiness, GPU, service, dashboard, or registry effects continue.
   */
  verifyCreatedSandboxBeforeEffects?: (
    identity: CreatedSandboxIdentity,
    beforeEffects?: () => unknown | Promise<unknown>,
    afterEffects?: () => void | Promise<void>,
  ) => void | Promise<void>;
  /** Re-read the exact pending create identity before each post-create effect. */
  revalidateVerifiedSandboxBeforeEffect?: (operation: string) => void;
  /** Persist the commit fence before the exact final handoff starts. */
  persistFinalHandoffCommitStarted?: (replacementRuntimeId: string | null) => void;
  /** Persist acknowledgement after resume reconfirms exact identity and Ready. */
  persistResumedFinalHandoffAcknowledgement?: () => void;
}

export interface CreatedSandboxIdentity {
  readonly sandboxId: string;
  readonly liveIdentityFingerprint: string;
  readonly createAttemptNonce?: string;
  readonly route: SelectedDockerGpuRoute;
}

/** Refuse APF fallback when OpenShell can remove the failed sandbox only by mutable name. */
export function refuseApfMutableNameFallbackCleanup(sandboxName: string) {
  return {
    safe: false,
    reason: `APF-selected sandbox '${sandboxName}' cannot be deleted by mutable name for a compatibility retry`,
    deleteStatus: null,
    sandboxPresent: null,
    containerIds: null,
  } as const;
}

export interface SandboxGpuCreateFlowDeps {
  commandExecutor: OpenShellSandboxBufferedCommandExecutor;
  runOpenshell: RunOpenshell;
  runCaptureOpenshell: RunCaptureOpenshell;
  sandboxObserver: OpenShellSandboxObserver;
  sleep: Sleep;
  openshellArgv(args: string[]): string[];
  createSandbox?: OpenShellSandboxLifecycle["createSandbox"];
  verifyDirectSandboxGpu(sandboxName: string): SandboxGpuProofResult;
  /** Test seam for the exact Docker runtime proof used only during handoff resume. */
  verifyExactFinalHandoffRuntime?: (
    sandboxName: string,
    replacementRuntimeId: string,
    requireRunning: boolean,
  ) => boolean;
  printCreateFailureDiagnostics?: (
    sandboxName: string,
    options: { readonly backupPath?: string | null },
  ) => void;
  /** Production callers configure the hidden portable lifecycle through the default implementation. */
  installPortableDemoLifecycle?: typeof installPortableDemoSandboxLifecycle;
  /** Production callers omit this factory and use the runtime provider's adapter. */
}

interface SandboxGpuCreateFlowResultCommon {
  runtimePatch: SandboxCreateRuntimePatch;
  route: SelectedDockerGpuRoute;
  /** Mutable tag/reference retained only for registry and image-GC bookkeeping. */
  registryImageRef: string | null;
  lifecycleRegistrationFields: LifecycleRegistrationFields;
}

export type SandboxGpuCreateFlowResult = SandboxGpuCreateFlowResultCommon &
  (
    | {
        readonly origin: "created";
        readonly createResult: StreamSandboxCreateResult;
        readonly firstCreateOutput: string;
      }
    | { readonly origin: "resumed" }
  );

/** Bind only the schema-5 GPU proof child to its admitted command authorities. */
export function createHermesPortableGpuProofAuthority(input: {
  readonly sandboxName: string;
  readonly gatewayName: string;
  readonly lifecycleGeneration: string;
  readonly sourceEnv: NodeJS.ProcessEnv;
  readonly runtimeAuthority: CheckpointPortableRuntimeAuthority;
  readonly runOpenshell: DirectSandboxGpuVerifierDeps["runOpenshell"];
  readonly compactText: DirectSandboxGpuVerifierDeps["compactText"];
  readonly redact: DirectSandboxGpuVerifierDeps["redact"];
}): { readonly env: NodeJS.ProcessEnv; readonly verify: VerifyDirectSandboxGpu } {
  const env = createHermesPortableChildEnvironment(input.sourceEnv, input.runtimeAuthority);
  return {
    env,
    verify: createDirectSandboxGpuVerifier({
      runOpenshell: input.runOpenshell,
      compactText: input.compactText,
      redact: input.redact,
      gatewayName: input.gatewayName,
      subprocessEnv: env,
      resolveOpenShellCommandAuthority: () =>
        buildHermesPortableOnboardingCommandAuthority(
          input.sandboxName,
          input.gatewayName,
          input.lifecycleGeneration,
          input.sourceEnv,
        ),
    }),
  };
}

/**
 * SOURCE_OF_TRUTH_REVIEW (ordered native-GPU fallback; #6110)
 * invalidState: native injection fails and a broader retry starts without exact evidence or cleanup.
 * sourceBoundary: the operator authorizes fallback; Docker owns image, runtime, attachment, and
 *   cleanup evidence, while image-controlled proof output remains diagnostic only.
 * whyNotSourceFix: supported OpenShell and Docker versions cannot be upgraded atomically.
 * regressionTest: the create classification/orchestration/cleanup suites and live Hermes GPU flow.
 * removalCondition: native injection works on all supported hosts and compatibility is retired.
 * Build/upload/TLS/provider/policy/general-readiness failures retain their existing exit paths.
 * The runner captures evidence; this module renders before cleanup, activates networking only
 * after proven cleanup, and the attempt helper permits at most one retry.
 */
export async function runSandboxGpuCreateFlow(
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
): Promise<SandboxGpuCreateFlowResult> {
  if (
    input.requirePolicylessCreate &&
    (!input.verifyCreatedSandboxBeforeEffects ||
      !input.revalidateVerifiedSandboxBeforeEffect ||
      !input.persistRetainedSandboxRecovery)
  ) {
    throw new Error(
      "APF interceptor sandbox creation requires exact post-create verification and durable fallback recovery.",
    );
  }
  if (input.verifyCreatedSandboxBeforeEffects && !input.persistRetainedSandboxRecovery) {
    throw new Error("Verified sandbox creation requires durable create-attempt recovery evidence.");
  }
  const hermesPortableLifecycle = input.hermesPortableLifecycle === true;
  if (hermesPortableLifecycle && (!input.lifecycleGeneration || !input.portableRuntimeAuthority)) {
    throw new Error(
      "Hermes portable onboarding requires checkpoint runtime authority and a lifecycle generation before creation.",
    );
  }
  let registryImageRef: string | null = input.prebuild.imageRef;
  const createSandbox =
    deps.createSandbox ??
    (() => {
      let selectedExecutable: string | undefined;
      return createCliOpenShellSandboxLifecycleFromRunner(deps.runOpenshell, {
        resolveBinary: () => {
          selectedExecutable ??= deps.openshellArgv([])[0];
          if (!selectedExecutable) {
            throw new Error("OpenShell executable selection returned an empty command.");
          }
          return selectedExecutable;
        },
      }).createSandbox;
    })();
  const attemptRunner = createSandboxGpuCreateAttemptRunner(
    hermesPortableLifecycle ? { ...input, portableLifecycle: true } : input,
    hermesPortableLifecycle
      ? {
          ...deps,
          createSandbox,
          installPortableDemoLifecycle: () => input.lifecycleGeneration!,
        }
      : { ...deps, createSandbox },
  );
  const gpuCreateOutcome = await (input.resumeVerifiedCreate
    ? attemptRunner.runAttempt(input.resumeVerifiedCreate.route)
    : sandboxGpuCreateAttempt.executeSandboxGpuCreatePlan(input.gpuRoutePlan, {
        runAttempt: attemptRunner.runAttempt,
        captureNativeFailure: (failure) => {
          const routeAdapter = adaptDockerGpuRouteForPatch(failure.route);
          const diagnostics = collectDockerGpuPatchDiagnostics(
            input.sandboxName,
            {
              error: failure.error,
              additionalSummaryLines: routeAdapter.additionalSummaryLines,
            },
            { runCaptureOpenshell: deps.runCaptureOpenshell },
          );
          if (diagnostics) console.error(`  Native GPU diagnostics saved: ${diagnostics.dir}`);
        },
        cleanupNativeFailure: (failure) => {
          if (input.requirePolicylessCreate) {
            return refuseApfMutableNameFallbackCleanup(input.sandboxName);
          }
          return sandboxGpuCreateAttempt.cleanupNativeGpuFailureForFallback(
            input.sandboxName,
            failure,
            {
              gatewayName: input.gatewayName,
              runOpenshell: deps.runOpenshell,
              sleep: deps.sleep,
            },
          );
        },
        prepareCompatibilityAttempt: async () => {
          if (!input.compatibilityPolicyPath) {
            throw new Error("Compatibility retry policy was not materialized.");
          }
          const nativeRuntimeSnapshot = attemptRunner.state.nativeRuntimeSnapshot;
          const prebuildImageId = input.prebuild.imageId;
          const imageId =
            nativeRuntimeSnapshot?.imageId ??
            (prebuildImageId && isImmutableDockerImageId(prebuildImageId)
              ? prebuildImageId.toLowerCase()
              : null);
          if (
            !registryImageRef &&
            nativeRuntimeSnapshot?.bookkeepingImageRef &&
            !isImmutableDockerImageId(nativeRuntimeSnapshot.bookkeepingImageRef)
          ) {
            registryImageRef = nativeRuntimeSnapshot.bookkeepingImageRef;
          }
          if (!input.createRequest) {
            throw new Error("Ordinary compatibility creation has no semantic create request.");
          }
          if (!imageId && !attemptRunner.state.allowUnbuiltCompatibilitySource) {
            throw new Error(
              "Native GPU fallback cannot reuse the completed sandbox image; refusing to rebuild it.",
            );
          }
          attemptRunner.state.compatibilityRequest = withoutOpenShellSandboxCreateGpu(
            input.createRequest,
            {
              ...(imageId ? { sourceReference: imageId } : {}),
              policyPath: input.compatibilityPolicyPath,
            },
          );
        },
        activateCompatibilityAttempt: async () => {
          await dockerGpuLocalInference.enforceDockerGpuPatchPreserveNetwork(
            input.provider,
            input.sandboxGpuConfig,
            {
              dockerDriverGateway: input.dockerDriverGateway,
              selectedRoute: "compatibility",
              gatewayPort: input.gatewayPort,
              log: console.log,
              reverifyBridgeReachability: () => verifySelectedSandboxBridgeReachability(input),
            },
          );
          input.sandboxGpuConfig.sandboxGpuProof = null;
        },
        traceEvent: addTraceEvent,
      }));
  if (!gpuCreateOutcome.ok) {
    const preparationRefused =
      "preparationRefused" in gpuCreateOutcome ? gpuCreateOutcome.preparationRefused : undefined;
    const cleanupRefused =
      "cleanupRefused" in gpuCreateOutcome ? gpuCreateOutcome.cleanupRefused : undefined;
    console.error("");
    console.error("  Operator-authorized GPU fallback stopped before compatibility retry.");
    if (preparationRefused) {
      console.error(`  Compatibility retry could not be prepared: ${preparationRefused}`);
    }
    if (cleanupRefused) {
      console.error(`  Cleanup could not be proven safe: ${redactFull(cleanupRefused)}`);
    }
    console.error(
      hermesPortableLifecycle
        ? `  Hermes portable sandbox '${input.sandboxName}' did not complete receipt-owned creation. Preserve its lifecycle receipt and resume onboarding after correcting the reported failure.`
        : `  Sandbox '${input.sandboxName}' may still exist. Recovery remains blocked while it exists; do not delete it by mutable name. Run 'nemoclaw ${input.sandboxName} destroy' to check for authoritative absence.`,
    );
    if (input.requirePolicylessCreate) {
      const persistRetainedSandboxRecovery = input.persistRetainedSandboxRecovery;
      if (!persistRetainedSandboxRecovery) {
        throw new Error("APF interceptor sandbox creation requires durable fallback recovery.");
      }
      const evidence = gpuCreateOutcome.retainedSandboxRecovery;
      if (!evidence) {
        console.error(
          "  APF recovery is blocked because the create attempt returned no durable identity or create-attempt label.",
        );
      } else {
        const identityGuidance = evidence.liveIdentityFingerprint
          ? "Use that fingerprint only to compare the surviving sandbox with this create attempt."
          : "OpenShell did not return one exact durable sandbox identity for this create attempt.";
        const message =
          `Create-attempt label: ${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${evidence.createAttemptNonce}. ` +
          `${evidence.liveIdentityFingerprint ? `Durable sandbox identity fingerprint: ${evidence.liveIdentityFingerprint}. ` : ""}` +
          `APF sandbox '${input.sandboxName}' may have been retained after native GPU fallback stopped. ` +
          `Gateway '${input.gatewayName}'. ${identityGuidance} ` +
          `Do not delete the sandbox by mutable name. Run 'nemoclaw ${input.sandboxName} destroy'; it can clear retained recovery only after OpenShell confirms absence.`;
        let persisted = false;
        try {
          persisted = evidence.liveIdentityFingerprint
            ? persistRetainedSandboxRecovery(
                message,
                evidence.liveIdentityFingerprint,
                evidence.createAttemptNonce,
              )
            : persistRetainedSandboxRecovery(message, undefined, evidence.createAttemptNonce);
        } catch {
          persisted = false;
        }
        console.error(`  ${message}`);
        if (!persisted) {
          console.error(
            "  APF recovery is blocked because NemoClaw could not save this create-attempt evidence. Preserve the registry entry and terminal output; do not delete the sandbox by mutable name.",
          );
        }
      }
    }
    process.exit(1);
  }

  const portableLifecycleGeneration = attemptRunner.state.portableLifecycleGeneration;

  const common = {
    runtimePatch: gpuCreateOutcome.value.runtimePatch,
    route: gpuCreateOutcome.route,
    registryImageRef,
    lifecycleRegistrationFields: {
      ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
      ...(portableLifecycleGeneration ? { lifecycleGeneration: portableLifecycleGeneration } : {}),
    },
  };
  if (input.resumeVerifiedCreate) return { ...common, origin: "resumed" };
  const createResult =
    "createResult" in gpuCreateOutcome.value ? gpuCreateOutcome.value.createResult : null;
  if (!createResult) {
    throw new Error("Sandbox create completed without its create result.");
  }
  return {
    ...common,
    origin: "created",
    createResult,
    firstCreateOutput: attemptRunner.state.firstCreateOutput,
  };
}
