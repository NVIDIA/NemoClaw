// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { waitUntilAsync } from "../core/wait";

type RunCaptureOpenshell = (args: string[], opts?: { ignoreError?: boolean }) => string;

export interface GatewayHealthWaitOptions {
  attachGatewayMetadataIfNeeded: (options?: { forceRefresh?: boolean }) => void;
  gatewayClusterHealthcheckPassed: () => boolean;
  gatewayName: string;
  healthPollCount: number;
  healthPollIntervalSeconds: number;
  isGatewayHealthy: (status: string, namedInfo: string, currentInfo: string) => boolean;
  isGatewayHttpReady: (signal?: AbortSignal) => Promise<boolean>;
  repairGatewayBootstrapSecrets: () => { repaired: boolean };
  runCaptureOpenshell: RunCaptureOpenshell;
  sleepSeconds: (seconds: number) => void;
}

function startAbortableGatewayHttpProbe(
  isGatewayHttpReady: GatewayHealthWaitOptions["isGatewayHttpReady"],
): { abort: () => void; ready: Promise<boolean> } {
  const controller = new AbortController();
  let started: Promise<boolean>;
  try {
    started = Promise.resolve(isGatewayHttpReady(controller.signal));
  } catch (error) {
    started = Promise.reject(error);
  }
  const ready = started.catch((error: unknown) => {
    if (controller.signal.aborted) return false;
    throw error;
  });
  return {
    abort: () => controller.abort(),
    ready,
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
        const httpProbe = startAbortableGatewayHttpProbe(isGatewayHttpReady);
        runCaptureOpenshell(["gateway", "select", gatewayName], { ignoreError: true });
        const status = runCaptureOpenshell(["status"], { ignoreError: true });
        const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
          ignoreError: true,
        });
        const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
        if (!isGatewayHealthy(status, namedInfo, currentInfo)) {
          httpProbe.abort();
          return false;
        }
        return await httpProbe.ready;
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
