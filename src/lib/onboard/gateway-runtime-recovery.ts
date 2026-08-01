// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { dockerContainerInspectFormat } from "../adapters/docker";
import { getGatewayClusterContainerName } from "../adapters/openshell/gateway-drift";
import { compactText } from "../core/url-utils";
import { sleepSeconds } from "../core/wait";
import { shouldPatchCoredns } from "../platform";
import { redact, run, SCRIPTS } from "../runner";
import type { OpenShellComputePlan } from "./compute/plan";
import * as computeRuntime from "./compute/runtime";
import { envInt } from "./env";
import * as gatewayBinding from "./gateway-binding";
import { getGatewayHealthWaitConfig, waitForGatewayHealth } from "./gateway-health-wait";
import * as gatewayRecovery from "./gateway-recovery";
import { getContainerRuntime } from "./local-inference-topology";

type RunOpenshellOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string>;
  ignoreError?: boolean;
  suppressOutput?: boolean;
};

type RunOpenshellResult = {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

type RunCaptureOpenshell = (
  args: string[],
  options?: { ignoreError?: boolean; timeout?: number },
) => string;

export interface GatewayRuntimeRecoveryDeps {
  assertGatewayStartAllowed(
    exitOnFailure: boolean,
    target?: { gatewayName: string; gatewayPort: number },
  ): void;
  attachGatewayMetadataIfNeeded(options?: { forceRefresh?: boolean }): void;
  gatewayClusterHealthcheckPassed(): boolean;
  getActiveComputePlan(): OpenShellComputePlan;
  getGatewayName(): string;
  getGatewayPort(): number;
  getGatewayPortArg(): string;
  getGatewayStartEnv(): Record<string, string>;
  isGatewayHealthy(
    statusOutput?: string,
    gatewayInfoOutput?: string,
    activeGatewayInfoOutput?: string,
  ): boolean;
  isGatewayHttpReady(
    timeoutMs?: number,
    url?: string,
    method?: "GET" | "POST",
    signal?: AbortSignal,
  ): Promise<boolean>;
  isManagedDriverGatewayEnabled(): boolean;
  isSelectedGateway(statusOutput?: string): boolean;
  repairGatewayBootstrapSecrets(): { repaired: boolean };
  runCaptureOpenshell: RunCaptureOpenshell;
  runOpenshell(args: string[], options?: RunOpenshellOptions): RunOpenshellResult;
  setActiveComputePlan(plan: OpenShellComputePlan): void;
  setGatewayTarget(target: { gatewayName: string; gatewayPort: number }): void;
  startGatewayWithOptions(
    gpu: never,
    options?: { exitOnFailure?: boolean; gpuPassthrough?: boolean },
  ): Promise<void>;
  startManagedDriverGateway(options?: { exitOnFailure?: boolean }): Promise<void>;
}

export interface GatewayRuntimeRecovery {
  getGatewayClusterContainerState(): string;
  recoverGatewayRuntime(): Promise<boolean>;
  startGatewayForRecovery(options?: gatewayRecovery.StartGatewayForRecoveryOptions): Promise<void>;
}

export function createGatewayRuntimeRecovery(
  deps: GatewayRuntimeRecoveryDeps,
): GatewayRuntimeRecovery {
  function getGatewayClusterContainerState(): string {
    const containerName = getGatewayClusterContainerName(deps.getGatewayName());
    const state = dockerContainerInspectFormat(
      "{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}}",
      containerName,
      { ignoreError: true },
    )
      .trim()
      .toLowerCase();
    return state || "missing";
  }

  async function startGatewayForRecovery(
    options: gatewayRecovery.StartGatewayForRecoveryOptions = {},
  ): Promise<void> {
    const previousComputePlan = deps.getActiveComputePlan();
    const previousRecoveryRuntimeEnvironment = new Map<string, string | undefined>();
    try {
      if (options.computeDriver) {
        const requestedDriver = options.computeDriver === "vm" ? "docker" : options.computeDriver;
        deps.setActiveComputePlan(
          computeRuntime.resolveOpenShellComputeSelection({
            requestedDriver,
            autoPlan: computeRuntime.resolveCurrentOpenShellComputePlan(),
          }),
        );
        if (computeRuntime.supportsManagedGatewayRecoveryRuntime(requestedDriver)) {
          const recoveryGatewayName =
            options.gatewayName ??
            gatewayBinding.resolveGatewayName(options.gatewayPort ?? deps.getGatewayPort());
          const recoveryRuntime = computeRuntime.resolveManagedGatewayRecoveryRuntime({
            driverName: requestedDriver,
            environment: process.env,
            stateDir: gatewayBinding.resolveManagedGatewayStateDirectory(recoveryGatewayName),
          });
          computeRuntime.qualifyManagedGatewayRecoveryRuntime(recoveryRuntime);
          for (const key of Object.keys(recoveryRuntime.environment)) {
            previousRecoveryRuntimeEnvironment.set(key, process.env[key]);
          }
          Object.assign(process.env, recoveryRuntime.environment);
        }
      }
      return await gatewayRecovery.startGatewayForRecovery(options, {
        assertGatewayStartAllowed: deps.assertGatewayStartAllowed,
        getGatewayStartEnv: deps.getGatewayStartEnv,
        runCaptureOpenshell: deps.runCaptureOpenshell,
        runOpenshell: deps.runOpenshell,
        startGatewayWithOptions: async (gpu, recoveryTarget) => {
          const previousTarget = {
            gatewayName: deps.getGatewayName(),
            gatewayPort: deps.getGatewayPort(),
          };
          try {
            deps.setGatewayTarget(recoveryTarget);
            return await deps.startGatewayWithOptions(gpu, {
              exitOnFailure: recoveryTarget.exitOnFailure,
            });
          } finally {
            deps.setGatewayTarget(previousTarget);
          }
        },
        isManagedDriverGatewayEnabled: deps.isManagedDriverGatewayEnabled,
      });
    } finally {
      deps.setActiveComputePlan(previousComputePlan);
      for (const [key, previous] of previousRecoveryRuntimeEnvironment) {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  }

  async function recoverGatewayRuntime(): Promise<boolean> {
    deps.assertGatewayStartAllowed(false);
    if (deps.isManagedDriverGatewayEnabled()) {
      try {
        await deps.startManagedDriverGateway({ exitOnFailure: false });
        return true;
      } catch {
        return false;
      }
    }

    deps.runOpenshell(["gateway", "select", deps.getGatewayName()], { ignoreError: true });
    const status = deps.runCaptureOpenshell(["status"], { ignoreError: true });
    if (
      status.includes("Connected") &&
      deps.isSelectedGateway(status) &&
      (await deps.isGatewayHttpReady())
    ) {
      process.env.OPENSHELL_GATEWAY = deps.getGatewayName();
      return true;
    }

    const startResult = deps.runOpenshell(
      ["gateway", "start", "--name", deps.getGatewayName(), "--port", deps.getGatewayPortArg()],
      {
        ignoreError: true,
        env: deps.getGatewayStartEnv(),
        suppressOutput: true,
      },
    );
    if (startResult.status !== 0) {
      const diagnostic = compactText(
        redact(`${startResult.stderr || ""} ${startResult.stdout || ""}`),
      );
      console.error(`  Gateway restart failed (exit ${startResult.status}).`);
      if (diagnostic) {
        console.error(`  ${diagnostic.slice(0, 240)}`);
      }
    }
    deps.runOpenshell(["gateway", "select", deps.getGatewayName()], { ignoreError: true });

    const recoveryWait = getGatewayHealthWaitConfig(
      startResult.status ?? 0,
      getGatewayClusterContainerState(),
    );
    const recoveryPollCount = recoveryWait.extended
      ? recoveryWait.count
      : envInt("NEMOCLAW_HEALTH_POLL_COUNT", 10);
    const recoveryPollInterval = recoveryWait.extended
      ? recoveryWait.interval
      : envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
    const healthy = await waitForGatewayHealth({
      attachGatewayMetadataIfNeeded: deps.attachGatewayMetadataIfNeeded,
      gatewayClusterHealthcheckPassed: deps.gatewayClusterHealthcheckPassed,
      gatewayName: deps.getGatewayName(),
      healthPollCount: recoveryPollCount,
      healthPollIntervalSeconds: recoveryPollInterval,
      isGatewayHealthy: deps.isGatewayHealthy,
      isGatewayHttpReady: (signal) =>
        deps.isGatewayHttpReady(undefined, undefined, undefined, signal),
      repairGatewayBootstrapSecrets: deps.repairGatewayBootstrapSecrets,
      runCaptureOpenshell: deps.runCaptureOpenshell,
      sleepSeconds,
    });
    if (!healthy) return false;

    process.env.OPENSHELL_GATEWAY = deps.getGatewayName();
    if (shouldPatchCoredns(getContainerRuntime())) {
      run(["bash", path.join(SCRIPTS, "fix-coredns.sh"), deps.getGatewayName()], {
        ignoreError: true,
      });
    }
    return true;
  }

  return {
    getGatewayClusterContainerState,
    recoverGatewayRuntime,
    startGatewayForRecovery,
  };
}
