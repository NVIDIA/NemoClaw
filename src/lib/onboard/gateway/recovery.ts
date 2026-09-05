// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { gatewayStartGuidance } from "../../gateway-start-guidance";
import { getGatewayHealthWaitConfig, waitForGatewayHealth } from "../gateway-health-wait";
import {
  startGatewayForRecovery as startGatewayForRecoveryFlow,
  type StartGatewayForRecoveryOptions,
} from "../gateway-recovery";

type DynamicGatewayHelpers = ReturnType<
  typeof import("../gateway-binding").createDynamicGatewayRuntimeHelpers
>;
type GatewayBootstrapRepairHelpers = ReturnType<
  typeof import("../gateway-bootstrap").createGatewayBootstrapRepairHelpers
>;
type OnboardGpu = ReturnType<typeof import("../../inference/nim").detectGpu>;
type RunResult = ReturnType<typeof import("../../runner").run>;

export interface GatewayRecoveryOrchestrationDeps {
  SCRIPTS: string;
  assertGatewayStartAllowed(
    exitOnFailure: boolean,
    target?: { gatewayName: string; gatewayPort: number },
  ): void;
  attachGatewayMetadataIfNeeded(options?: { forceRefresh?: boolean }): boolean;
  envInt: typeof import("../env").envInt;
  gatewayClusterHealthcheckPassed: GatewayBootstrapRepairHelpers["gatewayClusterHealthcheckPassed"];
  gatewayName(): string;
  getContainerRuntime: typeof import("../local-inference-topology").getContainerRuntime;
  getGatewayClusterContainerState(): string;
  isGatewayHealthy(status: string, namedInfo: string, activeInfo: string): boolean;
  isGatewayHttpReady: DynamicGatewayHelpers["isGatewayHttpReady"];
  isLinuxDockerDriverGatewayEnabled(): boolean;
  isSelectedGateway(status: string): boolean;
  repairGatewayBootstrapSecrets: GatewayBootstrapRepairHelpers["repairGatewayBootstrapSecrets"];
  run: typeof import("../../runner").run;
  runCaptureOpenshell(args: string[], options?: { ignoreError?: boolean }): string;
  runOpenshell(args: string[], options?: { ignoreError?: boolean }): RunResult;
  shouldPatchCoredns: typeof import("../../platform").shouldPatchCoredns;
  sleepSeconds: typeof import("../../core/wait").sleepSeconds;
  startDockerDriverGateway(options?: { exitOnFailure?: boolean }): Promise<void>;
  startGatewayWithOptions(
    gpu: OnboardGpu,
    options: {
      exitOnFailure: false;
      runtimeSelection?: StartGatewayForRecoveryOptions["runtimeSelection"];
    },
  ): Promise<void>;
}

export interface GatewayRecoveryOrchestration {
  recoverGatewayRuntime(): Promise<boolean>;
  startGatewayForRecovery(options?: StartGatewayForRecoveryOptions): Promise<void>;
}

export function createGatewayRecoveryOrchestration(
  deps: GatewayRecoveryOrchestrationDeps,
): GatewayRecoveryOrchestration {
  async function startGatewayForRecovery(
    options: StartGatewayForRecoveryOptions = {},
  ): Promise<void> {
    return startGatewayForRecoveryFlow(options, {
      assertGatewayStartAllowed: deps.assertGatewayStartAllowed,
      runCaptureOpenshell: deps.runCaptureOpenshell,
      runOpenshell: deps.runOpenshell,
      startGatewayWithOptions: deps.startGatewayWithOptions,
      isLinuxDockerDriverGatewayEnabled: deps.isLinuxDockerDriverGatewayEnabled,
    });
  }

  async function recoverGatewayRuntime(): Promise<boolean> {
    deps.assertGatewayStartAllowed(false);
    if (deps.isLinuxDockerDriverGatewayEnabled()) {
      try {
        await deps.startDockerDriverGateway({ exitOnFailure: false });
        return true;
      } catch {
        return false;
      }
    }

    deps.runOpenshell(["gateway", "select", deps.gatewayName()], { ignoreError: true });
    const status = deps.runCaptureOpenshell(["status"], { ignoreError: true });
    if (
      status.includes("Connected") &&
      deps.isSelectedGateway(status) &&
      (await deps.isGatewayHttpReady())
    ) {
      process.env.OPENSHELL_GATEWAY = deps.gatewayName();
      return true;
    }

    const recoveryWait = getGatewayHealthWaitConfig(0, deps.getGatewayClusterContainerState());
    const pollCount = recoveryWait.extended
      ? recoveryWait.count
      : deps.envInt("NEMOCLAW_HEALTH_POLL_COUNT", 10);
    const pollInterval = recoveryWait.extended
      ? recoveryWait.interval
      : deps.envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
    const healthy = await waitForGatewayHealth({
      attachGatewayMetadataIfNeeded: deps.attachGatewayMetadataIfNeeded,
      gatewayClusterHealthcheckPassed: deps.gatewayClusterHealthcheckPassed,
      gatewayName: deps.gatewayName(),
      healthPollCount: pollCount,
      healthPollIntervalSeconds: pollInterval,
      isGatewayHealthy: deps.isGatewayHealthy,
      isGatewayHttpReady: (signal?: AbortSignal) =>
        deps.isGatewayHttpReady(undefined, undefined, undefined, signal),
      repairGatewayBootstrapSecrets: deps.repairGatewayBootstrapSecrets,
      runCaptureOpenshell: deps.runCaptureOpenshell,
      sleepSeconds: deps.sleepSeconds,
    });
    if (!healthy) {
      console.error(`  ${gatewayStartGuidance(deps.gatewayName())}`);
      return false;
    }

    process.env.OPENSHELL_GATEWAY = deps.gatewayName();
    if (deps.shouldPatchCoredns(deps.getContainerRuntime())) {
      deps.run(["bash", path.join(deps.SCRIPTS, "fix-coredns.sh"), deps.gatewayName()], {
        ignoreError: true,
      });
    }
    return true;
  }

  return { recoverGatewayRuntime, startGatewayForRecovery };
}
