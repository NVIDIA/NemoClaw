// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { dockerContainerInspectFormat } from "../adapters/docker";
import { getGatewayClusterContainerName } from "../adapters/openshell/gateway-drift";
import { getGatewayHttpEndpoint } from "../core/gateway-address";
import { GATEWAY_PORT } from "../core/ports";
import { sleepSeconds } from "../core/wait";
import { shouldPatchCoredns } from "../platform";
import { run, SCRIPTS } from "../runner";
import { isGatewayHealthy } from "../state/gateway";
import { envInt } from "./env";
import { resolveGatewayName, resolveGatewayPortFromName } from "./gateway-binding";
import { isGatewayHttpReady } from "./gateway-http-readiness";
import { getContainerRuntime } from "./local-inference-topology";

export type StartGatewayForRecoveryOptions = {
  gatewayName?: string;
  gatewayPort?: number;
};

type RunOpenshellOptions = {
  ignoreError?: boolean;
  env?: Record<string, string>;
  suppressOutput?: boolean;
};

type RunCaptureOpenshellOptions = {
  ignoreError?: boolean;
};

type GatewayStartResult = {
  status?: number | null;
};

export type GatewayRecoveryDeps = {
  getGatewayClusterContainerState?(gatewayName: string): string;
  getGatewayStartEnv(): Record<string, string>;
  runCaptureOpenshell(args: string[], opts?: RunCaptureOpenshellOptions): string;
  runOpenshell(args: string[], opts?: RunOpenshellOptions): GatewayStartResult;
  startGatewayWithOptions(gpu: never, options: { exitOnFailure: false }): Promise<void>;
};

function isValidGatewayRecoveryPort(port: number | null | undefined): port is number {
  return Number.isInteger(port) && Number(port) >= 1 && Number(port) <= 65535;
}

function resolveDefaultGatewayName(): string {
  return resolveGatewayName(GATEWAY_PORT);
}

function resolveGatewayRecoveryTarget(options: StartGatewayForRecoveryOptions = {}) {
  const gatewayName = options.gatewayName || resolveDefaultGatewayName();
  const portFromName = resolveGatewayPortFromName(gatewayName);
  const gatewayPort = isValidGatewayRecoveryPort(options.gatewayPort)
    ? options.gatewayPort
    : (portFromName ?? GATEWAY_PORT);
  return { gatewayName, gatewayPort };
}

function getGatewayStartEnvForPort(
  gatewayPort: number,
  getGatewayStartEnv: GatewayRecoveryDeps["getGatewayStartEnv"],
): Record<string, string> {
  return {
    ...getGatewayStartEnv(),
    OPENSHELL_SERVER_PORT: String(gatewayPort),
    OPENSHELL_SSH_GATEWAY_PORT: String(gatewayPort),
  };
}

function getDefaultGatewayClusterContainerState(gatewayName: string): string {
  const state = dockerContainerInspectFormat(
    "{{.State.Status}}{{if .State.Health}} {{.State.Health.Status}}{{end}}",
    getGatewayClusterContainerName(gatewayName),
    { ignoreError: true },
  )
    .trim()
    .toLowerCase();
  return state || "missing";
}

function getGatewayHealthWaitConfig(_startStatus = 0, containerState = "") {
  const isArm64 = process.arch === "arm64";
  const standardCount = envInt("NEMOCLAW_HEALTH_POLL_COUNT", isArm64 ? 30 : 12);
  const standardInterval = envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", isArm64 ? 10 : 5);
  const extendedCount = envInt("NEMOCLAW_GATEWAY_START_POLL_COUNT", standardCount);
  const extendedInterval = envInt("NEMOCLAW_GATEWAY_START_POLL_INTERVAL", standardInterval);
  const normalizedState = String(containerState || "")
    .trim()
    .toLowerCase();
  const normalizedContainerState = normalizedState || "missing";
  const useExtendedWait = normalizedContainerState !== "missing";

  return {
    count: useExtendedWait ? extendedCount : standardCount,
    interval: useExtendedWait ? extendedInterval : standardInterval,
    extended: useExtendedWait,
    containerState: normalizedContainerState,
  };
}

async function startTargetGatewayForRecovery(
  { gatewayName, gatewayPort }: { gatewayName: string; gatewayPort: number },
  deps: GatewayRecoveryDeps,
): Promise<void> {
  const gatewayPortArg = String(gatewayPort);
  const startResult = deps.runOpenshell(
    ["gateway", "start", "--name", gatewayName, "--port", gatewayPortArg],
    {
      ignoreError: true,
      env: getGatewayStartEnvForPort(gatewayPort, deps.getGatewayStartEnv),
      suppressOutput: true,
    },
  );
  deps.runOpenshell(["gateway", "select", gatewayName], { ignoreError: true });

  const recoveryWait = getGatewayHealthWaitConfig(
    startResult.status ?? 0,
    (deps.getGatewayClusterContainerState ?? getDefaultGatewayClusterContainerState)(gatewayName),
  );
  const recoveryPollCount = recoveryWait.extended
    ? recoveryWait.count
    : envInt("NEMOCLAW_HEALTH_POLL_COUNT", 10);
  const recoveryPollInterval = recoveryWait.extended
    ? recoveryWait.interval
    : envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
  const targetGatewayUrl = `${getGatewayHttpEndpoint(gatewayPort)}/`;
  for (let i = 0; i < recoveryPollCount; i++) {
    const status = deps.runCaptureOpenshell(["status"], { ignoreError: true });
    const namedInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
      ignoreError: true,
    });
    const currentInfo = deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    if (
      status.includes("Connected") &&
      isGatewayHealthy(status, namedInfo, currentInfo, gatewayName) &&
      (await isGatewayHttpReady(undefined, targetGatewayUrl))
    ) {
      process.env.OPENSHELL_GATEWAY = gatewayName;
      const runtime = getContainerRuntime();
      if (shouldPatchCoredns(runtime)) {
        run(["bash", path.join(SCRIPTS, "fix-coredns.sh"), gatewayName], {
          ignoreError: true,
        });
      }
      return;
    }
    if (i < recoveryPollCount - 1) sleepSeconds(recoveryPollInterval);
  }

  throw new Error(`Gateway '${gatewayName}' failed to start`);
}

export async function startGatewayForRecovery(
  options: StartGatewayForRecoveryOptions,
  deps: GatewayRecoveryDeps,
): Promise<void> {
  const target = resolveGatewayRecoveryTarget(options);
  if (target.gatewayName === resolveDefaultGatewayName() && target.gatewayPort === GATEWAY_PORT) {
    return deps.startGatewayWithOptions(undefined as never, { exitOnFailure: false });
  }
  return startTargetGatewayForRecovery(target, deps);
}
