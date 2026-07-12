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
 * Operator-authorized native GPU compatibility fallback source-of-truth boundary:
 *
 * - Invalid state: OpenShell rejects `--gpu` before create progress, the exact
 *   labeled container records a host runtime GPU-injection error, or a
 *   structured driver proof is corroborated by host configuration showing
 *   that the exact native container has no GPU attachment.
 * - Source boundary: fallback never trusts free-form build/list output or the
 *   image-controlled proof by itself. Sandbox proof remains diagnostic and
 *   fails closed without host corroboration; immutable image identity, runtime
 *   state, and device attachment come from Docker.
 * - Source-fix constraint: supported OpenShell/Docker combinations cannot be
 *   upgraded atomically, so the existing compatibility path remains required.
 * - Regression tests: sandbox-gpu-create-failure-classification.test.ts and
 *   sandbox-gpu-fallback-orchestration.test.ts cover strict classification,
 *   non-GPU exclusions, safe cleanup, and the one-retry limit; the live Hermes
 *   GPU workflow proves native success and fallback after a real native create.
 * - Existing error boundary: build, upload, TLS, provider, policy, generic
 *   readiness, and refused-cleanup failures retain onboarding's established
 *   `process.exit` paths. The caller registers process-exit cleanup for its
 *   temporary policy/build context before entering this flow; only classified
 *   native GPU failures return into the compatibility orchestration.
 * - Authorization: ordinary Linux reaches this plan only through explicit
 *   `NEMOCLAW_DOCKER_GPU_PATCH=fallback`; diagnostics classify a failure after
 *   authorization and never independently grant broader confinement.
 *
 * The ordered boundary spans this orchestrator, the per-route executor in
 * `sandbox-gpu-create-run-attempt.ts`, and the retry and cleanup proof in
 * `sandbox-gpu-create-attempt.ts`. The executor owns attempt evidence, this
 * module prepares the compatibility retry, and the retry helper enforces the
 * one-transition cleanup gate. Every stage must succeed in that order.
 *
 * Create a sandbox through the selected GPU route, with one fail-closed
 * compatibility retry when the native-first plan permits it.
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
