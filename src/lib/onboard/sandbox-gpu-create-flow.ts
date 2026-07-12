// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StreamSandboxCreateResult } from "../sandbox/create-stream";
import { redactFull } from "../security/redact";
import type { SandboxGpuProofResult } from "../state/registry";
import * as dockerGpuLocalInference from "./docker-gpu-local-inference";
import { collectDockerGpuPatchDiagnostics } from "./docker-gpu-patch";
import type { DockerGpuPatchDeps } from "./docker-gpu-patch-types";
import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import { renderCompatibilityFallbackCreateArgs } from "./docker-gpu-route";
import { adaptDockerGpuRouteForPatch } from "./docker-gpu-route-patch-adapter";
import type { DockerGpuSandboxCreatePatch } from "./docker-gpu-sandbox-create";
import { isImmutableDockerImageId } from "./openshell-docker-sandbox-containers";
import * as sandboxGpuCreateAttempt from "./sandbox-gpu-create-attempt";
import { createSandboxGpuCreateAttemptRunner } from "./sandbox-gpu-create-run-attempt";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import type { SandboxPrebuildResult } from "./sandbox-prebuild";
import { addTraceEvent } from "./tracing";

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
}

export interface SandboxGpuCreateFlowDeps {
  runOpenshell: RunOpenshell;
  runCaptureOpenshell: RunCaptureOpenshell;
  sleep: Sleep;
  openshellArgv(args: string[]): string[];
  verifyDirectSandboxGpu(sandboxName: string): SandboxGpuProofResult;
}

export interface SandboxGpuCreateFlowResult {
  createResult: StreamSandboxCreateResult;
  dockerGpuCreatePatch: DockerGpuSandboxCreatePatch;
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
  const gpuCreateOutcome = await sandboxGpuCreateAttempt.executeSandboxGpuCreatePlan(
    input.gpuRoutePlan,
    {
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
        const compatibilityArgs = renderCompatibilityFallbackCreateArgs(input.prebuild.createArgs, {
          imageRef: imageId,
          allowUnbuiltSource: attemptRunner.state.allowUnbuiltCompatibilitySource,
          compatibilityPolicyPath: input.compatibilityPolicyPath,
        });
        attemptRunner.state.compatibilityArgv = deps.openshellArgv([
          "sandbox",
          "create",
          ...compatibilityArgs,
          "--",
          ...input.sandboxStartupCommand,
        ]);
        if (attemptRunner.state.compatibilityArgv.length === 0) {
          throw new Error("Compatibility sandbox create executable is missing.");
        }
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
          },
        );
        input.sandboxGpuConfig.sandboxGpuProof = null;
      },
      traceEvent: addTraceEvent,
    },
  );
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
