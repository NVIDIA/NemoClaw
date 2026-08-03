// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StreamSandboxCreateResult } from "../sandbox/create-stream";
import { redactFull } from "../security/redact";
import type { SandboxGpuProofResult } from "../state/registry";
import * as dockerGpuLocalInference from "./docker-gpu-local-inference";
import { collectDockerGpuPatchDiagnostics } from "./docker-gpu-patch";
import type { DockerGpuPatchDeps, DockerUlimit } from "./docker-gpu-patch-types";
import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import { renderCompatibilityFallbackCreateArgs } from "./docker-gpu-route";
import { adaptDockerGpuRouteForPatch } from "./docker-gpu-route-patch-adapter";
import {
  type ManagedBootstrapAdapter,
  type ManagedBootstrapAgentIdentity,
  type ManagedBootstrapAuthorityStore,
  type ManagedBootstrapImageIdentity,
  ManagedBootstrapRecoveryBlockedError,
} from "./managed-bootstrap/adapter";
import type { ManagedBootstrapRuntimePatch } from "./managed-bootstrap/runtime-create";
import type { ManagedStartupRootApplyRequest } from "./managed-startup/root-apply";
import { isImmutableDockerImageId } from "./openshell-docker-sandbox-containers";
import type {
  RuntimeProviderBootstrapSurface,
  RuntimeProviderBundle,
} from "./runtime-provider/contract";
import * as sandboxGpuCreateAttempt from "./sandbox-gpu-create-attempt";
import { createSandboxGpuCreateAttemptRunner } from "./sandbox-gpu-create-run-attempt";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import type { SandboxPrebuildResult } from "./sandbox-prebuild";
import { addTraceEvent } from "./tracing";

export { resolveDockerStartupCommandPatch } from "./docker-startup-command-agent";

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

export interface SandboxGpuCreateFlowInput {
  sandboxName: string;
  provider: string;
  sandboxGpuConfig: SandboxGpuConfig;
  gpuRoutePlan: import("./docker-gpu-route").DockerGpuRoutePlan;
  initialGpuRoute: SelectedDockerGpuRoute;
  compatibilityPolicyPath: string | null;
  dockerDriverGateway: boolean;
  gatewayPort: number;
  sandboxReadyTimeoutSecs: number;
  createArgv: string[];
  sandboxEnv: NodeJS.ProcessEnv;
  sandboxStartupCommand: string[];
  prebuild: SandboxPrebuildResult;
  restoreBackupPath: string | null;
  terminalAgent: boolean;
  persistStartupCommand?: boolean;
  managedBootstrap?: {
    readonly bootstrapIdentity: string;
    readonly runtimeProvider: RuntimeProviderBundle & {
      readonly bootstrap: Extract<RuntimeProviderBootstrapSurface, { readonly supported: true }>;
    };
    readonly authorityStore: ManagedBootstrapAuthorityStore;
    readonly request: ManagedStartupRootApplyRequest;
    readonly image: ManagedBootstrapImageIdentity;
    readonly agentIdentity: ManagedBootstrapAgentIdentity;
    readonly intendedWorkloadArgv: readonly string[];
    readonly expectedSupervisorArgv: readonly string[];
  } | null;
  requiredUlimits?: readonly DockerUlimit[] | null;
}

export interface SandboxGpuCreateFlowDeps {
  runOpenshell: RunOpenshell;
  runCaptureOpenshell: RunCaptureOpenshell;
  sleep: Sleep;
  openshellArgv(args: string[]): string[];
  verifyDirectSandboxGpu(sandboxName: string): SandboxGpuProofResult;
  /** Production callers omit this factory and use the runtime provider's adapter. */
  createManagedBootstrapAdapter?: () => ManagedBootstrapAdapter;
}

export interface SandboxGpuCreateFlowResult {
  createResult: StreamSandboxCreateResult;
  runtimePatch: ManagedBootstrapRuntimePatch;
  route: SelectedDockerGpuRoute;
  firstCreateOutput: string;
  /** Mutable tag/reference retained only for registry and image-GC bookkeeping. */
  registryImageRef: string | null;
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
  let registryImageRef: string | null = input.prebuild.imageRef;
  const attemptRunner = createSandboxGpuCreateAttemptRunner(input, deps);
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
      cleanupNativeFailure: () =>
        sandboxGpuCreateAttempt.cleanupNativeGpuAttemptForFallback(input.sandboxName, {
          runOpenshell: deps.runOpenshell,
          sleep: deps.sleep,
        }),
      prepareCompatibilityAttempt: async () => {
        if (!input.compatibilityPolicyPath) {
          throw new Error("Compatibility retry policy was not materialized.");
        }
        const nativeRuntimeSnapshot = attemptRunner.state.nativeRuntimeSnapshot;
        if (attemptRunner.managedRouting) {
          const prepared = attemptRunner.managedRouting.prepareCompatibilityLaunch({
            createArgs: input.prebuild.createArgs,
            currentRegistryImageRef: registryImageRef,
            prebuildImageId: input.prebuild.imageId,
            allowUnbuiltSource: attemptRunner.state.allowUnbuiltCompatibilitySource,
            compatibilityPolicyPath: input.compatibilityPolicyPath,
            startupCommand: input.sandboxStartupCommand,
            runtimeSnapshot: nativeRuntimeSnapshot,
          });
          attemptRunner.state.compatibilityArgv = [...prepared.createArgv];
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
    console.error(`  Manual cleanup: openshell sandbox delete "${input.sandboxName}"`);
    process.exit(1);
  }

  return {
    ...gpuCreateOutcome.value,
    route: gpuCreateOutcome.route,
    firstCreateOutput: attemptRunner.state.firstCreateOutput,
    registryImageRef,
  };
}
