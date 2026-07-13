// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { printSandboxCreateRecoveryHints } from "../build-context";
import { getSandboxDeleteOutcome } from "../domain/sandbox/destroy";
import { streamSandboxCreate } from "../sandbox/create-stream";
import { getReadyCheckOutputPatternsForAgent } from "../sandbox/create-stream-ready-gate";
import { getSandboxFailurePhase, isSandboxReady } from "../state/gateway";
import type { SandboxGpuProofResult } from "../state/registry";
import { classifySandboxCreateFailure } from "../validation";
import { cliName } from "./branding";
import { reportSandboxCreateFailure } from "./created-sandbox-failure";
import * as dockerGpuLocalInference from "./docker-gpu-local-inference";
import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import { createDockerGpuSandboxCreatePatch } from "./docker-gpu-sandbox-create";
import {
  type OpenShellDockerSandboxRuntimeSnapshotQuery,
  queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot,
} from "./openshell-docker-sandbox-containers";
import { printSandboxCreateFailureDiagnostics } from "./sandbox-create-failure";
import * as sandboxGpuCreateAttempt from "./sandbox-gpu-create-attempt";
import type {
  SandboxGpuCreateFlowDeps,
  SandboxGpuCreateFlowInput,
} from "./sandbox-gpu-create-flow";
import * as sandboxGpuPreflight from "./sandbox-gpu-preflight";
import * as sandboxReadinessTracing from "./sandbox-readiness-tracing";
import { addTraceEvent } from "./tracing";

type NativeRuntimeSnapshot = Extract<OpenShellDockerSandboxRuntimeSnapshotQuery, { ok: true }>;

export type SandboxGpuCreateAttemptState = {
  firstCreateOutput: string;
  compatibilityArgv: string[] | null;
  allowUnbuiltCompatibilitySource: boolean;
  nativeRuntimeSnapshot: NativeRuntimeSnapshot | null;
};

// A compatibility recreate can briefly observe the original container's stale
// Ready row. Require one confirmation poll before advancing to the GPU proof.
const COMPATIBILITY_STABLE_READY_POLLS = 2;

export function createSandboxGpuCreateAttemptRunner(
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
) {
  const state: SandboxGpuCreateAttemptState = {
    firstCreateOutput: "",
    compatibilityArgv: null,
    allowUnbuiltCompatibilitySource: false,
    nativeRuntimeSnapshot: null,
  };
  const nativeFallbackBaseline =
    input.initialGpuRoute === "native" && input.gpuRoutePlan === "native-with-fallback"
      ? queryOpenShellDockerSandboxContainers(input.sandboxName)
      : null;
  const nativeFallbackHasCleanBaseline =
    nativeFallbackBaseline?.ok === true && nativeFallbackBaseline.ids.length === 0;
  const inspectNativeRuntime = () => queryOpenShellDockerSandboxRuntimeSnapshot(input.sandboxName);

  const runAttempt = async (route: SelectedDockerGpuRoute) => {
    const compatibility = route === "compatibility";
    if (compatibility && input.initialGpuRoute === "native") {
      console.warn(
        "  Native OpenShell GPU onboarding did not complete; retrying once by recreating the OpenShell-managed Docker container with the legacy GPU compatibility envelope.",
      );
      console.warn(
        "  This compatibility container swap may relax container confinement compared with native injection. The retry is running only because NEMOCLAW_DOCKER_GPU_PATCH=fallback explicitly authorized it.",
      );
    }
    const dockerGpuCreatePatch = createDockerGpuSandboxCreatePatch({
      route,
      // Native attachment cannot be reproduced by a startup-only swap. The
      // compatibility route owns its GPU envelope; no-GPU can persist startup.
      persistStartupCommand: input.persistStartupCommand === true && route !== "native",
      sandboxName: input.sandboxName,
      gpuDevice: input.sandboxGpuConfig.sandboxGpuDevice,
      openshellSandboxCommand: input.sandboxStartupCommand,
      timeoutSecs: input.sandboxReadyTimeoutSecs,
      backend: input.sandboxGpuConfig.hostGpuPlatform === "jetson" ? "jetson" : "generic",
      deps,
    });
    const attemptArgv = state.compatibilityArgv ?? input.createArgv;
    const [createExecutable, ...createExecutableArgs] = attemptArgv;
    if (!createExecutable) throw new Error("Sandbox create executable is missing.");
    const createResult = await streamSandboxCreate(
      createExecutable,
      createExecutableArgs,
      input.sandboxEnv,
      {
        readyCheck: () => {
          const list = deps.runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
          return isSandboxReady(list, input.sandboxName);
        },
        onPoll: () => dockerGpuCreatePatch.maybeApplyDuringCreate(),
        readyCheckOutputPatterns: getReadyCheckOutputPatternsForAgent(
          input.terminalAgent,
          input.sandboxEnv,
        ),
        failureCheck: dockerGpuCreatePatch.createFailureMessage,
        traceEvent: addTraceEvent,
        initialPhase:
          compatibility && (input.prebuild.imageRef || state.compatibilityArgv)
            ? "create"
            : undefined,
      },
    );
    if (!state.firstCreateOutput) state.firstCreateOutput = createResult.output;
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
            state.allowUnbuiltCompatibilitySource = input.prebuild.imageRef === null;
            return true;
          }
          const snapshot = inspectNativeRuntime();
          if (
            snapshot.ok &&
            sandboxGpuCreateAttempt.isTrustedNativeGpuRuntimeError(snapshot.stateError)
          ) {
            state.nativeRuntimeSnapshot = snapshot;
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
        reportSandboxCreateFailure(
          {
            sandboxName: input.sandboxName,
            createStatus: createResult.status,
            createOutput: createResult.output,
            restoreBackupPath: input.restoreBackupPath,
            createArgs: input.prebuild.createArgs,
          },
          {
            classifyCreateFailure: classifySandboxCreateFailure,
            printCreateFailureDiagnostics: printSandboxCreateFailureDiagnostics,
            printRecoveryHints: printSandboxCreateRecoveryHints,
            warn: (message) => console.warn(message),
            error: (message) => console.error(message),
            exitProcess: (code) => process.exit(code),
          },
        );
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
        state.nativeRuntimeSnapshot = runtimeSnapshot;
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
        } else console.error(`  Retry: ${cliName()} onboard`);
      }
      process.exit(createResult.status === 0 ? 1 : createResult.status);
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
            state.nativeRuntimeSnapshot = snapshot;
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

  return { state, runAttempt };
}
