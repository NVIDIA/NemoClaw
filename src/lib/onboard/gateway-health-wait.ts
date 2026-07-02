// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { waitUntilAsync } from "../core/wait";
import { envInt } from "./env";

type RunCaptureOpenshell = (args: string[], opts?: { ignoreError?: boolean }) => string;

export interface GatewayHealthWaitOptions {
  attachGatewayMetadataIfNeeded: (options?: { forceRefresh?: boolean }) => void;
  gatewayClusterHealthcheckPassed: () => boolean;
  gatewayName: string;
  healthPollCount: number;
  healthPollIntervalSeconds: number;
  isGatewayHealthy: (status: string, namedInfo: string, currentInfo: string) => boolean;
  isGatewayHttpReady: () => Promise<boolean>;
  repairGatewayBootstrapSecrets: () => { repaired: boolean };
  runCaptureOpenshell: RunCaptureOpenshell;
  sleepSeconds: (seconds: number) => void;
}

export function getGatewayHealthWaitConfig(
  _startStatus = 0,
  containerState = "",
): { count: number; interval: number; extended: boolean; containerState: string } {
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

export async function waitForGatewayHealth({
  attachGatewayMetadataIfNeeded,
  gatewayClusterHealthcheckPassed,
  gatewayName,
  healthPollCount,
  healthPollIntervalSeconds,
  isGatewayHealthy,
  isGatewayHttpReady,
  repairGatewayBootstrapSecrets,
  runCaptureOpenshell,
  sleepSeconds,
}: GatewayHealthWaitOptions): Promise<boolean> {
  const healthPollIntervalMs = Math.max(0, healthPollIntervalSeconds * 1000);
  return (
    healthPollCount > 0 &&
    (await waitUntilAsync(
      async () => {
        const repairResult = repairGatewayBootstrapSecrets();
        if (repairResult.repaired) {
          attachGatewayMetadataIfNeeded({ forceRefresh: true });
        } else if (gatewayClusterHealthcheckPassed()) {
          attachGatewayMetadataIfNeeded();
        }
        runCaptureOpenshell(["gateway", "select", gatewayName], { ignoreError: true });
        const status = runCaptureOpenshell(["status"], { ignoreError: true });
        const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
          ignoreError: true,
        });
        const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
        return isGatewayHealthy(status, namedInfo, currentInfo) && (await isGatewayHttpReady());
      },
      {
        initialIntervalMs: healthPollIntervalMs,
        maxIntervalMs: healthPollIntervalMs,
        backoffFactor: 1,
        maxAttempts: healthPollCount,
        sleep: (ms) => sleepSeconds(ms / 1000),
      },
    ))
  );
}
