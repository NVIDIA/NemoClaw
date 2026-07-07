// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { printSandboxCreateRecoveryHints } from "../build-context";
import { getSandboxDeleteOutcome } from "../domain/sandbox/destroy";
import { type StreamSandboxCreateResult, streamSandboxCreate } from "../sandbox/create-stream";
import { redactFull } from "../security/redact";
import { getSandboxFailurePhase, isSandboxReady } from "../state/gateway";
import type { SandboxGpuProofResult } from "../state/registry";
import { classifySandboxCreateFailure } from "../validation";
import { cliName } from "./branding";
import * as dockerGpuLocalInference from "./docker-gpu-local-inference";
import { collectDockerGpuPatchDiagnostics } from "./docker-gpu-patch";
import type { DockerGpuPatchDeps } from "./docker-gpu-patch-types";
import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import { renderCompatibilityFallbackCreateArgs } from "./docker-gpu-route";
import { adaptDockerGpuRouteForPatch } from "./docker-gpu-route-patch-adapter";
import {
  createDockerGpuSandboxCreatePatch,
  type DockerGpuSandboxCreatePatch,
} from "./docker-gpu-sandbox-create";
import {
  isImmutableDockerImageId,
  type OpenShellDockerSandboxRuntimeSnapshotQuery,
  queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot,
} from "./openshell-docker-sandbox-containers";
import { printSandboxCreateFailureDiagnostics } from "./sandbox-create-failure";
import { renderSandboxCreateCommand } from "./sandbox-create-launch";
import * as sandboxGpuCreateAttempt from "./sandbox-gpu-create-attempt";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import * as sandboxGpuPreflight from "./sandbox-gpu-preflight";
import type { SandboxPrebuildResult } from "./sandbox-prebuild";
import * as sandboxReadinessTracing from "./sandbox-readiness-tracing";
import { addTraceEvent } from "./tracing";

type RunOpenshell = NonNullable<DockerGpuPatchDeps["runOpenshell"]>;
type RunCaptureOpenshell = NonNullable<DockerGpuPatchDeps["runCaptureOpenshell"]>;
type Sleep = NonNullable<DockerGpuPatchDeps["sleep"]>;

// After compatibility recreation, OpenShell's sandbox-list cache can expose
// one stale Ready row from the original container before the replacement
// supervisor's registration transition arrives. One confirmation poll keeps
// that stale row from advancing directly into the GPU proof (run 28817562371).
const COMPATIBILITY_STABLE_READY_POLLS = 2;

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
  createCommand: string;
  sandboxEnv: NodeJS.ProcessEnv;
  sandboxStartupCommand: string[];
  prebuild: SandboxPrebuildResult;
  restoreBackupPath: string | null;
  terminalAgent: boolean;
}

export interface SandboxGpuCreateFlowDeps {
  runOpenshell: RunOpenshell;
  runCaptureOpenshell: RunCaptureOpenshell;
  sleep: Sleep;
  openshellShellCommand(args: string[]): string;
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
 * Automatic native GPU compatibility fallback source-of-truth boundary:
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
 * - Removal condition: remove automatic fallback only when the minimum
 *   supported OpenShell version provides reliable native GPU injection across
 *   ordinary Linux, Docker Desktop WSL, and Jetson/Tegra hosts.
 *
 * Keep this module bounded to one create-attempt execution plus composition of
 * the generic fallback plan. If another lifecycle stage or retry route is
 * added, extract the attempt executor instead of growing this trust boundary.
 *
 * Create a sandbox through the selected GPU route, with one fail-closed
 * compatibility retry when the native-first plan permits it.
 */
export async function runSandboxGpuCreateFlow(
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
): Promise<SandboxGpuCreateFlowResult> {
  let firstCreateOutput = "";
  let compatibilityCommand: string | null = null;
  let registryImageRef: string | null = input.prebuild.imageRef;
  let allowUnbuiltCompatibilitySource = false;
  let nativeRuntimeSnapshot: Extract<
    OpenShellDockerSandboxRuntimeSnapshotQuery,
    { ok: true }
  > | null = null;
  const nativeFallbackBaseline =
    input.initialGpuRoute === "native" && input.gpuRoutePlan === "native-with-fallback"
      ? queryOpenShellDockerSandboxContainers(input.sandboxName)
      : null;
  const nativeFallbackHasCleanBaseline =
    nativeFallbackBaseline?.ok === true && nativeFallbackBaseline.ids.length === 0;
  const inspectNativeRuntime = () => queryOpenShellDockerSandboxRuntimeSnapshot(input.sandboxName);

  const runGpuCreateAttempt = async (route: SelectedDockerGpuRoute) => {
    const compatibility = route === "compatibility";
    if (compatibility && input.initialGpuRoute === "native") {
      console.warn(
        "  Native OpenShell GPU onboarding did not complete; retrying once by recreating the OpenShell-managed Docker container with the legacy GPU compatibility envelope.",
      );
      console.warn(
        "  This compatibility container swap may relax container confinement compared with native injection. Set NEMOCLAW_DOCKER_GPU_PATCH=0 for native-only behavior.",
      );
    }
    const dockerGpuCreatePatch = createDockerGpuSandboxCreatePatch({
      route,
      sandboxName: input.sandboxName,
      gpuDevice: input.sandboxGpuConfig.sandboxGpuDevice,
      openshellSandboxCommand: input.sandboxStartupCommand,
      timeoutSecs: input.sandboxReadyTimeoutSecs,
      backend: input.sandboxGpuConfig.hostGpuPlatform === "jetson" ? "jetson" : "generic",
      deps,
    });
    const command = compatibilityCommand ?? input.createCommand;
    const createResult = await streamSandboxCreate(command, input.sandboxEnv, {
      readyCheck: () => {
        const list = deps.runCaptureOpenshell(["sandbox", "list"], {
          ignoreError: true,
        });
        if (isSandboxReady(list, input.sandboxName)) return true;
        dockerGpuCreatePatch.maybeApplyDuringCreate();
        return false;
      },
      readyCheckOutputPatterns: input.terminalAgent ? [] : undefined,
      failureCheck: dockerGpuCreatePatch.createFailureMessage,
      traceEvent: addTraceEvent,
      initialPhase:
        compatibility && (input.prebuild.imageRef || compatibilityCommand) ? "create" : undefined,
    });
    if (!firstCreateOutput) firstCreateOutput = createResult.output;
    dockerGpuCreatePatch.exitOnPatchError();
    if (createResult.status !== 0) {
      const failure = classifySandboxCreateFailure(createResult.output);
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
            allowUnbuiltCompatibilitySource = input.prebuild.imageRef === null;
            return true;
          }
          const snapshot = inspectNativeRuntime();
          if (
            snapshot.ok &&
            sandboxGpuCreateAttempt.isTrustedNativeGpuRuntimeError(snapshot.stateError)
          ) {
            nativeRuntimeSnapshot = snapshot;
            return true;
          }
          return false;
        })()
      ) {
        return {
          ok: false,
          route,
          stage: "create",
          error: new Error("Native OpenShell GPU sandbox creation was rejected."),
          fallbackEligible: true,
        } as const;
      } else {
        console.error("");
        console.error(`  Sandbox creation failed (exit ${createResult.status}).`);
        if (createResult.output) console.error(`\n${createResult.output}`);
        printSandboxCreateFailureDiagnostics(input.sandboxName, {
          backupPath: input.restoreBackupPath,
        });
        console.error("  Try:  openshell sandbox list        # check gateway state");
        printSandboxCreateRecoveryHints(createResult.output, {
          createArgs: input.prebuild.createArgs,
        });
        process.exit(createResult.status || 1);
      }
    }
    dockerGpuCreatePatch.ensureApplied();
    dockerGpuCreatePatch.waitForSupervisorReconnectIfNeeded();
    console.log("  Waiting for sandbox to become ready...");
    const readiness = sandboxReadinessTracing.waitForCreatedSandboxReadyWithTrace({
      sandboxName: input.sandboxName,
      timeoutSecs: input.sandboxReadyTimeoutSecs,
      runCaptureOpenshell: deps.runCaptureOpenshell,
      isSandboxReady,
      getSandboxFailurePhase,
      stableReadyPolls: compatibility ? COMPATIBILITY_STABLE_READY_POLLS : 1,
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
        runtimeSnapshot?.ok &&
        sandboxGpuCreateAttempt.isNativeGpuReadinessRoutingFailure({
          failurePhase: readiness.failurePhase,
          runtimeError: runtimeSnapshot.stateError,
        })
      ) {
        nativeRuntimeSnapshot = runtimeSnapshot;
        return {
          ok: false,
          route,
          stage: "readiness",
          error: new Error(
            `Native OpenShell GPU sandbox did not become ready${readiness.failurePhase ? ` (${readiness.failurePhase})` : ""}.`,
          ),
          fallbackEligible: true,
        } as const;
      }
      printSandboxCreateFailureDiagnostics(input.sandboxName, {
        backupPath: input.restoreBackupPath,
      });
      if (compatibility) dockerGpuCreatePatch.printReadinessFailureIfEnabled();
      else {
        const deletion = deps.runOpenshell(["sandbox", "delete", input.sandboxName], {
          ignoreError: true,
          suppressOutput: true,
        });
        const { alreadyGone } = getSandboxDeleteOutcome({
          status: deletion.status ?? null,
          stdout: String(deletion.stdout ?? ""),
          stderr: String(deletion.stderr ?? ""),
        });
        if (Number(deletion.status ?? 1) !== 0 && !alreadyGone) {
          console.error("  The failed sandbox could not be removed automatically.");
          console.error(`  Manual cleanup: openshell sandbox delete "${input.sandboxName}"`);
        } else {
          console.error(`  Retry: ${cliName()} onboard`);
        }
      }
      process.exit(1);
    }
    if (input.sandboxGpuConfig.sandboxGpuEnabled) {
      const deferNativeProofFailure =
        route === "native" &&
        input.gpuRoutePlan === "native-with-fallback" &&
        nativeFallbackHasCleanBaseline;
      const proof: SandboxGpuProofResult = dockerGpuLocalInference.verifyGpuSandboxAccessAfterReady(
        input.sandboxGpuConfig,
        {
          sandboxName: input.sandboxName,
          dockerDriverGateway: input.dockerDriverGateway,
          selectedRoute: route,
          verifyDirectSandboxGpu: deps.verifyDirectSandboxGpu,
          verifyGpuOrExit: deferNativeProofFailure
            ? undefined
            : dockerGpuCreatePatch.verifyGpuOrExit,
          reportGpuProofFailure: !deferNativeProofFailure,
          selectedMode: dockerGpuCreatePatch.selectedMode,
          runCaptureOpenshell: deps.runCaptureOpenshell,
          log: console.log,
        },
      );
      if (deferNativeProofFailure && proof.status === "failed") {
        if (sandboxGpuPreflight.isExplicitNvidiaSmiDriverProofFailure(proof)) {
          const snapshot = inspectNativeRuntime();
          if (snapshot.ok && snapshot.nativeGpuAttachmentState === "absent") {
            nativeRuntimeSnapshot = snapshot;
            return {
              ok: false,
              route,
              stage: "gpu-proof",
              error: new Error(
                "Native OpenShell GPU proof failed and the host confirms no GPU attachment.",
              ),
              fallbackEligible: true,
            } as const;
          }
        }
        console.error("");
        console.error("  Native sandbox GPU proof failed.");
        console.error(
          "  Sandbox-reported GPU output without corroborating host evidence cannot authorize a less-confined compatibility retry.",
        );
        console.error(
          "  To explicitly select the compatibility route, clean up the sandbox and retry with NEMOCLAW_DOCKER_GPU_PATCH=1.",
        );
        process.exit(1);
      }
      if (proof.status === "failed") {
        throw new Error("Sandbox GPU proof returned failed status.");
      }
    }
    return {
      ok: true,
      route,
      value: { createResult, dockerGpuCreatePatch },
    } as const;
  };

  const gpuCreateOutcome = await sandboxGpuCreateAttempt.executeSandboxGpuCreatePlan(
    input.gpuRoutePlan,
    {
      runAttempt: runGpuCreateAttempt,
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
          allowUnbuiltSource: allowUnbuiltCompatibilitySource,
          compatibilityPolicyPath: input.compatibilityPolicyPath,
        });
        compatibilityCommand = renderSandboxCreateCommand(
          compatibilityArgs,
          input.sandboxStartupCommand,
          deps.openshellShellCommand,
        );
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
    console.error("  Automatic GPU fallback stopped before compatibility retry.");
    if (gpuCreateOutcome.preparationRefused)
      console.error(
        `  Compatibility retry could not be prepared: ${gpuCreateOutcome.preparationRefused}`,
      );
    if (gpuCreateOutcome.cleanupRefused)
      console.error(
        `  Cleanup could not be proven safe: ${redactFull(gpuCreateOutcome.cleanupRefused)}`,
      );
    console.error(`  Manual cleanup: openshell sandbox delete "${input.sandboxName}"`);
    process.exit(1);
  }

  return {
    ...gpuCreateOutcome.value,
    route: gpuCreateOutcome.route,
    firstCreateOutput,
    registryImageRef,
  };
}
