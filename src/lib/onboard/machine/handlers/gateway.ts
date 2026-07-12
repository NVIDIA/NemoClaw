// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { NvidiaPlatform } from "../../../inference/nim";
import type { GatewayReuseState } from "../../../state/gateway";
import type { Session } from "../../../state/onboard-session";
import type { GatewayContainerState } from "../../gateway-container-running";
import { withGatewayTrace } from "../../tracing";
import { advanceTo, type OnboardStateTransitionResult } from "../result";

export interface GatewayStateOptions<Gpu> {
  resume: boolean;
  session: Session | null;
  initialGatewayReuseState: GatewayReuseState;
  gpu: Gpu;
  gpuPassthrough: boolean;
  gatewayName: string;
  recordedSandboxName: string | null;
  requestedSandboxName: string | null;
  recreateSandbox: boolean;
  deps: {
    refreshDockerDriverGatewayReuseState(state: GatewayReuseState): Promise<GatewayReuseState>;
    gatewayCliSupportsLifecycleCommands(): boolean;
    verifyGatewayContainerRunning(gatewayName: string): GatewayContainerState;
    waitForGatewayHttpReady(): Promise<boolean>;
    recoverGatewayRuntime(): Promise<boolean>;
    getGatewayLocalEndpoint(): string;
    stopDashboardForward(): void;
    destroyGateway(
      clearRegistry?: () => void,
      isDockerDriverGatewayEnabledForDestroy?: () => boolean,
    ): boolean;
    destroyGatewayForReuse(
      destroyGateway: () => boolean,
      successMessage: string,
      failureMessage: string,
    ): GatewayReuseState;
    getGatewayClusterImageDrift(): { currentVersion: string; expectedVersion: string } | null;
    stopAllDashboardForwards(): void;
    reconcileGatewayGpuReuseForGpuIntent(options: {
      gatewayReuseState: GatewayReuseState;
      gpuPassthrough: boolean;
      gatewayName: string;
      currentSandboxName: string | null;
      hostGpuPlatform: NvidiaPlatform | null;
      recreateSandbox: boolean;
      confirmedDockerDriverGateway: boolean;
      stopDashboardForwards: () => void;
      retireLegacyGatewayForDockerDriverUpgrade: () => void;
      destroyGatewayRuntimeForGpuReuse: () => boolean;
    }): GatewayReuseState;
    isLinuxDockerDriverGatewayEnabled(): boolean;
    retireLegacyGatewayForDockerDriverUpgrade(): void;
    destroyGatewayRuntimeForGpuReuse(): boolean;
    skippedStepMessage(stepName: string, detail?: string | null, reason?: "resume" | "reuse"): void;
    recordStateSkipped(
      state: "gateway",
      metadata?: Record<string, unknown> | null,
    ): Promise<Session>;
    note(message: string): void;
    startRecordedStep(stepName: string): Promise<void>;
    startGateway(gpu: Gpu, options: { gpuPassthrough: boolean }): Promise<void>;
    recordStepComplete(stepName: string): Promise<Session>;
    exitProcess(code: number): never;
  };
}

export interface GatewayStateResult {
  gatewayReuseState: GatewayReuseState;
  session: Session | null;
  stateResult: OnboardStateTransitionResult;
}

export async function handleGatewayState<Gpu>({
  resume,
  session,
  initialGatewayReuseState,
  gpu,
  gpuPassthrough,
  gatewayName,
  recordedSandboxName,
  requestedSandboxName,
  recreateSandbox,
  deps,
}: GatewayStateOptions<Gpu>): Promise<GatewayStateResult> {
  let gatewayReuseState = await deps.refreshDockerDriverGatewayReuseState(initialGatewayReuseState);
  const supportsLifecycleCommands = deps.gatewayCliSupportsLifecycleCommands();

  if (gatewayReuseState === "healthy" && supportsLifecycleCommands) {
    const containerState = deps.verifyGatewayContainerRunning(gatewayName);
    let checkImageDrift = false;
    if (containerState === "missing") {
      console.log("  Gateway metadata is stale (container not running). Cleaning up...");
      deps.stopDashboardForward();
      gatewayReuseState = deps.destroyGatewayForReuse(
        deps.destroyGateway,
        "  ✓ Stale gateway metadata cleaned up",
        "  ! Stale gateway metadata cleanup failed; leaving registry state intact.",
      );
    } else if (containerState === "stopped") {
      // #4187: a stopped legacy `openshell-cluster-*` container after a host
      // VM stop/start still holds the PVC volume. Attempt non-destructive
      // recovery (openshell gateway start) before any destructive path so we
      // never delete the k3s local-path PVC backing data.
      console.log(
        "  Gateway container is stopped (likely host or Docker restart). Attempting non-destructive recovery...",
      );
      const recovered = await deps.recoverGatewayRuntime();
      if (recovered) {
        console.log(
          "  ✓ Gateway recovered without removing volumes; existing sandbox PVC preserved.",
        );
        checkImageDrift = true;
      } else {
        console.log(
          `  Could not start the stopped NemoClaw gateway and ${deps.getGatewayLocalEndpoint()}/ is not responding.`,
        );
        console.log(
          "  Refusing to delete openshell-cluster-* volumes — they may hold the existing PVC/workspace data.",
        );
        console.log(
          "  Restart Docker, free the gateway port if held by another process, and re-run `nemoclaw onboard`. See #4187.",
        );
        deps.exitProcess(1);
      }
    } else if (containerState === "unknown") {
      if (await deps.waitForGatewayHttpReady()) {
        console.log(
          "  Warning: could not verify gateway container state (Docker may be unavailable), but the gateway is responding on HTTP. Proceeding with reuse.",
        );
      } else {
        console.log(
          `  Error: could not verify gateway container state and ${deps.getGatewayLocalEndpoint()}/ is not responding.`,
        );
        console.log(
          "  Refusing to proceed without a clear Docker signal — restarting Docker and re-running onboard is the safe path. See #3258 / #2020.",
        );
        deps.exitProcess(1);
      }
    } else if (!(await deps.waitForGatewayHttpReady())) {
      console.log(
        `  Gateway container is running but ${deps.getGatewayLocalEndpoint()}/ is not responding. Recreating...`,
      );
      deps.stopDashboardForward();
      gatewayReuseState = deps.destroyGatewayForReuse(
        deps.destroyGateway,
        "  ✓ Stale gateway cleaned up",
        "  ! Stale gateway cleanup failed; leaving registry state intact.",
      );
    } else {
      checkImageDrift = true;
    }

    if (checkImageDrift) {
      const imageDrift = deps.getGatewayClusterImageDrift();
      if (imageDrift) {
        console.log(
          `  Gateway image ${imageDrift.currentVersion} does not match openshell ${imageDrift.expectedVersion}. Recreating...`,
        );
        deps.stopAllDashboardForwards();
        gatewayReuseState = deps.destroyGatewayForReuse(
          deps.destroyGateway,
          "  ✓ Previous gateway cleaned up",
          "  ! Previous gateway cleanup failed; leaving registry state intact.",
        );
      }
    }
  }

  gatewayReuseState = deps.reconcileGatewayGpuReuseForGpuIntent({
    gatewayReuseState,
    gpuPassthrough,
    gatewayName,
    currentSandboxName: recordedSandboxName || requestedSandboxName,
    hostGpuPlatform: (gpu as { platform?: NvidiaPlatform } | null)?.platform ?? null,
    recreateSandbox,
    confirmedDockerDriverGateway:
      deps.isLinuxDockerDriverGatewayEnabled() &&
      gatewayReuseState === "healthy" &&
      !supportsLifecycleCommands,
    stopDashboardForwards: deps.stopAllDashboardForwards,
    retireLegacyGatewayForDockerDriverUpgrade: deps.retireLegacyGatewayForDockerDriverUpgrade,
    destroyGatewayRuntimeForGpuReuse: deps.destroyGatewayRuntimeForGpuReuse,
  });

  const canReuseHealthyGateway = gatewayReuseState === "healthy";
  const resumeGateway =
    resume && session?.steps?.gateway?.status === "complete" && canReuseHealthyGateway;
  if (resumeGateway) {
    deps.skippedStepMessage("gateway", "running");
    await deps.recordStateSkipped("gateway", { reason: "resume", reuseState: gatewayReuseState });
    session = await deps.recordStepComplete("gateway");
  } else if (!resume && canReuseHealthyGateway) {
    deps.skippedStepMessage("gateway", "running", "reuse");
    await deps.recordStateSkipped("gateway", { reason: "reuse", reuseState: gatewayReuseState });
    deps.note("  Reusing healthy NemoClaw gateway.");
    session = await deps.recordStepComplete("gateway");
  } else {
    if (resume && session?.steps?.gateway?.status === "complete") {
      if (gatewayReuseState === "active-unnamed") {
        deps.note(
          "  [resume] Gateway is active but named metadata is missing; recreating it safely.",
        );
      } else if (gatewayReuseState === "foreign-active") {
        deps.note(
          "  [resume] A different OpenShell gateway is active; NemoClaw will not reuse it.",
        );
      } else if (gatewayReuseState === "stale") {
        deps.note("  [resume] Recorded gateway is unhealthy; recreating it.");
      } else {
        deps.note("  [resume] Recorded gateway state is unavailable; recreating it.");
      }
    }
    await deps.startRecordedStep("gateway");
    if (
      deps.isLinuxDockerDriverGatewayEnabled() &&
      gatewayReuseState !== "missing" &&
      gatewayReuseState !== "foreign-active"
    ) {
      deps.note("  Replacing legacy OpenShell gateway metadata with Docker-driver gateway.");
      deps.retireLegacyGatewayForDockerDriverUpgrade();
      gatewayReuseState = "missing";
    } else if (gatewayReuseState === "foreign-active") {
      gatewayReuseState = "missing";
    }
    await withGatewayTrace(gatewayReuseState, gpuPassthrough, () =>
      deps.startGateway(gpu, { gpuPassthrough }),
    );
    session = await deps.recordStepComplete("gateway");
  }

  return {
    gatewayReuseState,
    session,
    stateResult: advanceTo("provider_selection", {
      metadata: { state: "gateway", gatewayReuseState },
    }),
  };
}
