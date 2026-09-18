// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayLifecycle } from "../../adapters/openshell/gateway-lifecycle";
import type { OpenShellGatewayReuseObserver } from "../../adapters/openshell/gateway-reuse";
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

export interface GatewayRecoveryOrchestrationDeps {
  lifecycle: OpenShellGatewayLifecycle;
  observer: OpenShellGatewayReuseObserver;
  SCRIPTS: string;
  assertGatewayStartAllowed(
    exitOnFailure: boolean,
    target?: { gatewayName: string; gatewayPort: number },
  ): void;
  attachGatewayMetadataIfNeeded(options?: { forceRefresh?: boolean }): Promise<boolean>;
  envInt: typeof import("../env").envInt;
  gatewayClusterHealthcheckPassed: GatewayBootstrapRepairHelpers["gatewayClusterHealthcheckPassed"];
  gatewayName(): string;
  getContainerRuntime: typeof import("../local-inference-topology").getContainerRuntime;
  getGatewayClusterContainerState(): string;
  isGatewayHttpReady: DynamicGatewayHelpers["isGatewayHttpReady"];
  isLinuxDockerDriverGatewayEnabled(): boolean;
  repairGatewayBootstrapSecrets: GatewayBootstrapRepairHelpers["repairGatewayBootstrapSecrets"];
  run: typeof import("../../runner").run;
  shouldPatchCoredns: typeof import("../../platform").shouldPatchCoredns;
  sleepSeconds: typeof import("../../core/wait").sleepSeconds;
  startDockerDriverGateway(options?: { exitOnFailure?: boolean }): Promise<void>;
  startGatewayWithOptions(
    gpu: OnboardGpu,
    options: {
      exitOnFailure: false;
      output?: StartGatewayForRecoveryOptions["output"];
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
      lifecycle: deps.lifecycle,
      observer: deps.observer,
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

    const request = { target: { kind: "named" as const, gatewayName: deps.gatewayName() } };
    const selected = await deps.lifecycle.selectGateway(request);
    if (!selected.ok) return false;
    const observed = await deps.observer.observeGatewayReuse(request);
    if (
      !observed.error &&
      observed.healthy &&
      observed.namedMetadata &&
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
      lifecycle: deps.lifecycle,
      observer: deps.observer,
      attachGatewayMetadataIfNeeded: deps.attachGatewayMetadataIfNeeded,
      gatewayClusterHealthcheckPassed: deps.gatewayClusterHealthcheckPassed,
      gatewayName: deps.gatewayName(),
      healthPollCount: pollCount,
      healthPollIntervalSeconds: pollInterval,
      isGatewayHttpReady: (signal?: AbortSignal) =>
        deps.isGatewayHttpReady(undefined, undefined, undefined, signal),
      repairGatewayBootstrapSecrets: deps.repairGatewayBootstrapSecrets,
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
