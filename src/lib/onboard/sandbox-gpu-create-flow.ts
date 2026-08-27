// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import { NEMOCLAW_CREATE_ATTEMPT_LABEL } from "../adapters/openshell/sandbox-identity";
import type { StreamSandboxCreateResult } from "../sandbox/create-stream";
import { redactFull } from "../security/redact";
import type { CheckpointPortableRuntimeAuthority } from "../state/onboard-checkpoint-types";
import { parsePortableRuntimeAuthority } from "../state/onboard/portable-runtime-authority";
import type { SandboxEntry, SandboxGpuProofResult } from "../state/registry";
import * as dockerGpuLocalInference from "./docker-gpu-local-inference";
import { collectDockerGpuPatchDiagnostics } from "./docker-gpu-patch";
import type { DockerGpuPatchDeps, DockerUlimit } from "./docker-gpu-patch-types";
import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import { renderCompatibilityFallbackCreateArgs } from "./docker-gpu-route";
import { adaptDockerGpuRouteForPatch } from "./docker-gpu-route-patch-adapter";
import { resolveDockerStartupCommandPatch } from "./docker-startup-command-agent";
import {
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
import {
  createManagedBootstrapIdentity,
  type ManagedBootstrapAdapter,
  type ManagedBootstrapAgentIdentity,
  type ManagedBootstrapAuthorityStore,
  type ManagedBootstrapImageIdentity,
  ManagedBootstrapRecoveryBlockedError,
  renderManagedBootstrapHeldCommand,
} from "./managed-bootstrap/adapter";
import type { ManagedBootstrapRuntimePatch } from "./managed-bootstrap/runtime-create";
import { assertPortableManagedBootstrapNotSelected } from "./managed-workload/onboard-orchestration";
import type { ManagedStartupRootApplyRequest } from "./managed-startup/root-apply";
import { isImmutableDockerImageId } from "./openshell-docker-sandbox-containers";
import type {
  RuntimeProviderBundle,
  RuntimeProviderManagedImageBootstrapSurface,
} from "./runtime-provider/contract";
import * as sandboxGpuCreateAttempt from "./sandbox-gpu-create-attempt";
import { createSandboxGpuCreateAttemptRunner } from "./sandbox-gpu-create-run-attempt";
import { managedBootstrapCreateArgs } from "./sandbox-create-launch";
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
function exitForManagedBootstrapRecovery(error: ManagedBootstrapRecoveryBlockedError): never {
  console.error("");
  console.error(
    `  Managed bootstrap recovery stopped before sandbox '${error.sandboxName}' was created.`,
  );
  for (const failure of error.failures) {
    const scope = failure.sandbox
      ? `sandbox '${failure.sandbox.sandboxName}' (durable sandbox ID ${failure.sandbox.sandboxId}, provider ${failure.providerId})`
      : "a sandbox whose durable identity could not be recovered";
    console.error(
      `  Transaction ${failure.bootstrapIdentity} requires ${failure.retryable ? "a provider retry after its recovery condition is resolved" : "operator recovery"} for ${scope}.`,
    );
    console.error(`  ${redactFull(failure.detail)}`);
    if (failure.sandbox) {
      console.error(
        `  Before any provider action, query that exact name with OpenShell's sandbox get command and verify it returns durable sandbox ID ${failure.sandbox.sandboxId}.`,
      );
    }
  }
  console.error(
    "  Preserve every durable recovery record. Act only on exact provider, sandbox, and runtime IDs from the provider guidance; never delete a runtime by mutable sandbox name.",
  );
  process.exit(1);
}

type RunOpenshell = NonNullable<DockerGpuPatchDeps["runOpenshell"]>;
type RunCaptureOpenshell = NonNullable<DockerGpuPatchDeps["runCaptureOpenshell"]>;
type Sleep = NonNullable<DockerGpuPatchDeps["sleep"]>;
type LifecycleRegistrationFields = Pick<SandboxEntry, "lifecycleGeneration">;

export interface SandboxGpuCreateFlowInput {
  sandboxName: string;
  /** Reject every initial or fallback create attempt that carries a caller policy. */
  requirePolicylessCreate?: true;
  /** Durably retain exact create-attempt recovery evidence before identity-bound recovery stops. */
  persistRetainedSandboxRecovery?: (message: string) => boolean;
  provider: string;
  sandboxGpuConfig: SandboxGpuConfig;
  gpuRoutePlan: import("./docker-gpu-route").DockerGpuRoutePlan;
  initialGpuRoute: SelectedDockerGpuRoute;
  compatibilityPolicyPath: string | null;
  dockerDriverGateway: boolean;
  gatewayName: string;
  gatewayPort: number;
  sandboxReadyTimeoutSecs: number;
  createArgv: string[];
  /** Exact schema-5 build context consumed by the OpenShell create child. */
  createWorkingDirectory?: string;
  /** Host-side runtime environment used only by the selected lifecycle provider. */
  hostEnv?: NodeJS.ProcessEnv;
  portableLifecycle?: boolean;
  hermesPortableLifecycle?: boolean;
  sandboxEnv: NodeJS.ProcessEnv;
  sandboxStartupCommand: string[];
  lifecycleGeneration?: SandboxEntry["lifecycleGeneration"];
  portableRuntimeAuthority?: CheckpointPortableRuntimeAuthority | null;
  prebuild: SandboxPrebuildResult;
  restoreBackupPath: string | null;
  terminalAgent: boolean;
  persistStartupCommand?: boolean;
  managedBootstrap?: {
    readonly bootstrapIdentity: string;
    readonly stateRoot: string;
    readonly runtimeProvider: RuntimeProviderBundle & {
      readonly bootstrap: RuntimeProviderManagedImageBootstrapSurface;
    };
    readonly authorityStore: ManagedBootstrapAuthorityStore;
    readonly request: ManagedStartupRootApplyRequest;
    readonly image: ManagedBootstrapImageIdentity;
    readonly agentIdentity: ManagedBootstrapAgentIdentity;
    readonly intendedWorkloadArgv: readonly string[];
    readonly expectedSupervisorArgv: readonly string[];
  } | null;
  requiredUlimits?: readonly DockerUlimit[] | null;
  /**
   * Verify the exact sandbox created by each attempt before runtime activation,
   * readiness, GPU, service, dashboard, or registry effects continue.
   */
  verifyCreatedSandboxBeforeEffects?: (identity: CreatedSandboxIdentity) => void | Promise<void>;
  /** Re-read the exact durable policy checkpoint before each post-create effect. */
  revalidateVerifiedSandboxBeforeEffect?: (operation: string) => void;
}

export interface CreatedSandboxIdentity {
  readonly sandboxId: string;
  readonly liveIdentityFingerprint: string;
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
  runOpenshell: RunOpenshell;
  runCaptureOpenshell: RunCaptureOpenshell;
  sleep: Sleep;
  openshellArgv(args: string[]): string[];
  verifyDirectSandboxGpu(sandboxName: string): SandboxGpuProofResult;
  printCreateFailureDiagnostics?: (
    sandboxName: string,
    options: { readonly backupPath?: string | null },
  ) => void;
  /** Production callers configure the hidden portable lifecycle through the default implementation. */
  installPortableDemoLifecycle?: typeof installPortableDemoSandboxLifecycle;
  /** Production callers omit this factory and use the runtime provider's adapter. */
  createManagedBootstrapAdapter?: (stateRoot: string) => ManagedBootstrapAdapter;
}

export interface SandboxGpuCreateFlowResult {
  createResult: StreamSandboxCreateResult;
  runtimePatch: ManagedBootstrapRuntimePatch;
  route: SelectedDockerGpuRoute;
  firstCreateOutput: string;
  /** Mutable tag/reference retained only for registry and image-GC bookkeeping. */
  registryImageRef: string | null;
  lifecycleRegistrationFields: LifecycleRegistrationFields;
}

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
  assertPortableManagedBootstrapNotSelected(
    input.portableLifecycle === true,
    input.managedBootstrap != null,
  );
  if (hermesPortableLifecycle && input.managedBootstrap != null) {
    throw new Error(
      "Hermes portable onboarding cannot use managed-image bootstrap because it requires Docker lifecycle operations.",
    );
  }
  if (hermesPortableLifecycle && (!input.lifecycleGeneration || !input.portableRuntimeAuthority)) {
    throw new Error(
      "Hermes portable onboarding requires checkpoint runtime authority and a lifecycle generation before creation.",
    );
  }
  let registryImageRef: string | null = input.prebuild.imageRef;
  const attemptRunner = createSandboxGpuCreateAttemptRunner(
    hermesPortableLifecycle ? { ...input, portableLifecycle: true } : input,
    hermesPortableLifecycle
      ? {
          ...deps,
          installPortableDemoLifecycle: () => input.lifecycleGeneration!,
        }
      : deps,
  );
  const gpuCreateOutcome = await sandboxGpuCreateAttempt
    .executeSandboxGpuCreatePlan(input.gpuRoutePlan, {
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
        if (attemptRunner.managedRouting) {
          const managedBootstrap = input.managedBootstrap;
          if (!managedBootstrap) {
            throw new Error("Managed compatibility routing is missing bootstrap authority.");
          }
          const bootstrapIdentity = createManagedBootstrapIdentity();
          const heldWorkloadArgv = [
            ...renderManagedBootstrapHeldCommand(
              managedBootstrap.request,
              bootstrapIdentity,
              managedBootstrap.intendedWorkloadArgv,
            ),
          ];
          const prepared = attemptRunner.managedRouting.prepareCompatibilityLaunch({
            createArgs: managedBootstrapCreateArgs(input.prebuild.createArgs, bootstrapIdentity),
            currentRegistryImageRef: registryImageRef,
            prebuildImageId: input.prebuild.imageId,
            allowUnbuiltSource: attemptRunner.state.allowUnbuiltCompatibilitySource,
            compatibilityPolicyPath: input.compatibilityPolicyPath,
            startupCommand: heldWorkloadArgv,
            runtimeSnapshot: nativeRuntimeSnapshot,
          });
          attemptRunner.state.compatibilityArgv = [...prepared.createArgv];
          attemptRunner.state.compatibilityBootstrapIdentity = bootstrapIdentity;
          attemptRunner.state.compatibilityHeldWorkloadArgv = heldWorkloadArgv;
          registryImageRef = prepared.registryImageRef;
        } else {
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
          const compatibilityArgs = renderCompatibilityFallbackCreateArgs(
            input.prebuild.createArgs,
            {
              imageRef: imageId,
              allowUnbuiltSource: attemptRunner.state.allowUnbuiltCompatibilitySource,
              compatibilityPolicyPath: input.compatibilityPolicyPath,
            },
          );
          attemptRunner.state.compatibilityArgv = deps.openshellArgv([
            "sandbox",
            "create",
            ...compatibilityArgs,
            "--",
            ...input.sandboxStartupCommand,
          ]);
        }
        if (attemptRunner.state.compatibilityArgv.length === 0) {
          throw new Error("Compatibility sandbox create executable is missing.");
        }
      },
      activateCompatibilityAttempt: async () => {
        if (!input.managedBootstrap) {
          await dockerGpuLocalInference.enforceDockerGpuPatchPreserveNetwork(
            input.provider,
            input.sandboxGpuConfig,
            {
              dockerDriverGateway: input.dockerDriverGateway,
              selectedRoute: "compatibility",
              gatewayPort: input.gatewayPort,
              log: console.log,
            },
          );
        }
        input.sandboxGpuConfig.sandboxGpuProof = null;
      },
      traceEvent: addTraceEvent,
    })
    .catch((error: unknown) => {
      if (error instanceof ManagedBootstrapRecoveryBlockedError) {
        exitForManagedBootstrapRecovery(error);
      }
      throw error;
    });
  if (!gpuCreateOutcome.ok) {
    console.error("");
    console.error("  Operator-authorized GPU fallback stopped before compatibility retry.");
    if (gpuCreateOutcome.preparationRefused) {
      console.error(
        `  Compatibility retry could not be prepared: ${gpuCreateOutcome.preparationRefused}`,
      );
    }
    if (gpuCreateOutcome.cleanupRefused) {
      console.error(
        `  Cleanup could not be proven safe: ${redactFull(gpuCreateOutcome.cleanupRefused)}`,
      );
    }
    console.error(
      gpuCreateOutcome.nativeCleanupHandoff
        ? `  Managed bootstrap retained exact owner-cleanup authority for sandbox '${input.sandboxName}'. Do not delete a runtime by mutable sandbox name; preserve it for identity-bound recovery.`
        : hermesPortableLifecycle
          ? `  Hermes portable sandbox '${input.sandboxName}' did not complete receipt-owned creation. Preserve its lifecycle receipt and resume onboarding after correcting the reported failure.`
          : `  Sandbox '${input.sandboxName}' may still exist. Verify its durable identity before manual cleanup; do not act by mutable name alone.`,
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
          : "OpenShell did not return one exact durable sandbox identity for this create attempt. Recovery is blocked until an OpenShell administrator resolves the create-attempt label to one sandbox.";
        const message =
          `Create-attempt label: ${NEMOCLAW_CREATE_ATTEMPT_LABEL}=${evidence.createAttemptNonce}. ` +
          `${evidence.liveIdentityFingerprint ? `Durable sandbox identity fingerprint: ${evidence.liveIdentityFingerprint}. ` : ""}` +
          `APF sandbox '${input.sandboxName}' may have been retained after native GPU fallback stopped. ` +
          `Gateway '${input.gatewayName}'. ${identityGuidance} ` +
          "Do not delete a sandbox by mutable name; use an identity-bound administrator recovery procedure.";
        let persisted = false;
        try {
          persisted = persistRetainedSandboxRecovery(message);
        } catch {
          persisted = false;
        }
        console.error(`  ${message}`);
        if (!persisted) {
          console.error(
            "  APF recovery is blocked because NemoClaw could not save this create-attempt evidence. Preserve the terminal output for an OpenShell administrator.",
          );
        }
      }
    }
    process.exit(1);
  }

  let portableLifecycleGeneration = attemptRunner.state.portableLifecycleGeneration;
  if (!input.portableLifecycle && !input.hermesPortableLifecycle && !portableLifecycleGeneration) {
    if (input.verifyCreatedSandboxBeforeEffects) {
      const revalidate = input.revalidateVerifiedSandboxBeforeEffect;
      if (!revalidate) {
        throw new Error("Verified sandbox creation has no post-create effect revalidation.");
      }
      revalidate(`record portable lifecycle for sandbox '${input.sandboxName}'`);
    }
    try {
      portableLifecycleGeneration =
        (deps.installPortableDemoLifecycle ?? installPortableDemoSandboxLifecycle)(
          input.sandboxName,
          input.sandboxStartupCommand,
          process.env,
          {
            ...(input.lifecycleGeneration ? { registryGeneration: input.lifecycleGeneration } : {}),
            runtimeAuthority: input.portableRuntimeAuthority ?? null,
          },
        ) ?? null;
    } catch (error) {
      const detail = redactFull(error instanceof Error ? error.message : String(error)).slice(
        0,
        500,
      );
      console.warn(`  Portable demo lifecycle setup did not complete: ${detail}`);
    }
  }

  return {
    ...gpuCreateOutcome.value,
    route: gpuCreateOutcome.route,
    firstCreateOutput: attemptRunner.state.firstCreateOutput,
    registryImageRef,
    lifecycleRegistrationFields: {
      ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
      ...(portableLifecycleGeneration ? { lifecycleGeneration: portableLifecycleGeneration } : {}),
    },
  };
}
