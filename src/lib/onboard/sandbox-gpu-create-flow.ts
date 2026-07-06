// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { extractBuiltImageRef, printSandboxCreateRecoveryHints } from "../build-context";
import { type StreamSandboxCreateResult, streamSandboxCreate } from "../sandbox/create-stream";
import { getSandboxFailurePhase, isSandboxReady } from "../state/gateway";
import type { SandboxGpuProofResult } from "../state/registry";
import { classifySandboxCreateFailure } from "../validation";
import { cliName } from "./branding";
import * as dockerGpuLocalInference from "./docker-gpu-local-inference";
import {
  collectDockerGpuPatchDiagnostics,
  type DockerGpuPatchDeps,
  queryOpenShellDockerSandboxImage,
} from "./docker-gpu-patch";
import type { SelectedDockerGpuRoute } from "./docker-gpu-route";
import {
  createDockerGpuSandboxCreatePatch,
  type DockerGpuSandboxCreatePatch,
} from "./docker-gpu-sandbox-create";
import { printSandboxCreateFailureDiagnostics } from "./sandbox-create-failure";
import { renderSandboxCreateCommand } from "./sandbox-create-launch";
import { renderCompatibilityFallbackCreateArgs } from "./sandbox-create-plan";
import * as sandboxGpuCreateAttempt from "./sandbox-gpu-create-attempt";
import type { SandboxGpuConfig } from "./sandbox-gpu-mode";
import type { SandboxPrebuildResult } from "./sandbox-prebuild";
import * as sandboxReadinessTracing from "./sandbox-readiness-tracing";
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
  selectedCreateImageRef: string | null;
}

/**
 * Create a sandbox through the selected GPU route, with one fail-closed
 * compatibility retry when the native-first plan permits it.
 */
export async function runSandboxGpuCreateFlow(
  input: SandboxGpuCreateFlowInput,
  deps: SandboxGpuCreateFlowDeps,
): Promise<SandboxGpuCreateFlowResult> {
  let firstCreateOutput = "";
  let compatibilityCommand: string | null = null;
  let selectedCreateImageRef: string | null = input.prebuild.imageRef;

  const runGpuCreateAttempt = async (route: SelectedDockerGpuRoute) => {
    const compatibility = route === "compatibility";
    if (compatibility && input.initialGpuRoute === "native") {
      console.warn(
        "  Native OpenShell GPU onboarding did not complete; retrying once with the compatibility path...",
      );
    }
    const dockerGpuCreatePatch = createDockerGpuSandboxCreatePatch({
      enabled: compatibility,
      selectedRoute: route,
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
        const list = deps.runCaptureOpenshell(["sandbox", "list"], { ignoreError: true });
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
        sandboxGpuCreateAttempt.isNativeGpuCreateRoutingFailure(createResult.output)
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
      sleep: deps.sleep,
    });
    if (!readiness.ready) {
      console.error("");
      sandboxReadinessTracing.printReadinessFailure(
        readiness,
        input.sandboxName,
        input.sandboxReadyTimeoutSecs,
      );
      if (route === "native" && input.gpuRoutePlan === "native-with-fallback") {
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
      else deps.runOpenshell(["sandbox", "delete", input.sandboxName], { ignoreError: true });
      console.error(`  Retry: ${cliName()} onboard`);
      process.exit(1);
    }
    if (input.sandboxGpuConfig.sandboxGpuEnabled) {
      try {
        const deferNativeProofFailure =
          route === "native" && input.gpuRoutePlan === "native-with-fallback";
        const proof = dockerGpuLocalInference.verifyGpuSandboxAccessAfterReady(
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
        if (
          route === "native" &&
          input.gpuRoutePlan === "native-with-fallback" &&
          sandboxGpuCreateAttempt.isHardNativeGpuProofFailure(proof)
        ) {
          return {
            ok: false,
            route,
            stage: "gpu-proof",
            error: new Error("Native OpenShell GPU CUDA proof failed."),
            fallbackEligible: true,
          } as const;
        }
      } catch (error) {
        if (route === "native" && input.gpuRoutePlan === "native-with-fallback") {
          return { ok: false, route, stage: "gpu-proof", error, fallbackEligible: true } as const;
        }
        throw error;
      }
    }
    return { ok: true, route, value: { createResult, dockerGpuCreatePatch } } as const;
  };

  const gpuCreateOutcome = await sandboxGpuCreateAttempt.executeSandboxGpuCreatePlan(
    input.gpuRoutePlan,
    {
      runAttempt: runGpuCreateAttempt,
      captureNativeFailure: (failure) => {
        const diagnostics = collectDockerGpuPatchDiagnostics(
          input.sandboxName,
          { error: failure.error, selectedRoute: failure.route },
          { runCaptureOpenshell: deps.runCaptureOpenshell },
        );
        if (diagnostics) console.error(`  Native GPU diagnostics saved: ${diagnostics.dir}`);
      },
      cleanupNativeFailure: () =>
        sandboxGpuCreateAttempt.cleanupNativeGpuAttemptForFallback(input.sandboxName, {
          runOpenshell: deps.runOpenshell,
          sleep: deps.sleep,
        }),
      prepareCompatibilityAttempt: async (failure) => {
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
        const containerImage = queryOpenShellDockerSandboxImage(input.sandboxName);
        const imageRef =
          input.prebuild.imageRef ??
          extractBuiltImageRef(firstCreateOutput) ??
          (containerImage.ok ? containerImage.imageRef : null);
        selectedCreateImageRef = imageRef;
        const compatibilityArgs = renderCompatibilityFallbackCreateArgs(input.prebuild.createArgs, {
          imageRef,
          allowUnbuiltSource:
            failure.stage === "create" &&
            sandboxGpuCreateAttempt.isNativeGpuCreatePreBuildRejection(firstCreateOutput),
        });
        compatibilityCommand = renderSandboxCreateCommand(
          compatibilityArgs,
          input.sandboxStartupCommand,
          deps.openshellShellCommand,
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
      console.error(`  Cleanup could not be proven safe: ${gpuCreateOutcome.cleanupRefused}`);
    console.error(`  Manual cleanup: openshell sandbox delete "${input.sandboxName}"`);
    process.exit(1);
  }

  return {
    ...gpuCreateOutcome.value,
    route: gpuCreateOutcome.route,
    firstCreateOutput,
    selectedCreateImageRef,
  };
}
