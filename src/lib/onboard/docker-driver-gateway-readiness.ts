// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { waitUntilAsync } from "../core/wait";
import { createGatewayHealthWaitOptions } from "./gateway-health-wait";

type RunCaptureOpenshell = (args: string[], opts?: { ignoreError?: boolean }) => string;

export type DockerDriverGatewayStartupResult = "healthy" | "exited" | "timeout";

export async function waitForStandaloneDockerDriverGateway(options: {
  childExited: () => boolean;
  childPid: number;
  gatewayName: string;
  healthPollCount: number;
  healthPollIntervalSeconds: number;
  isGatewayHealthy: (status: string, namedInfo: string, currentInfo: string) => boolean;
  isGatewayTcpReady: () => Promise<boolean>;
  isPidAlive: (pid: number) => boolean;
  onHealthy: () => Promise<void>;
  registerGatewayEndpoint: () => boolean;
  runCaptureOpenshell: RunCaptureOpenshell;
  sleepSeconds: (seconds: number) => void;
  now?: () => number;
}): Promise<DockerDriverGatewayStartupResult> {
  let result: DockerDriverGatewayStartupResult = "timeout";
  const waitOptions = createGatewayHealthWaitOptions(
    options.healthPollCount,
    options.healthPollIntervalSeconds,
    options.now ?? Date.now,
    (ms) => options.sleepSeconds(ms / 1000),
  );
  if (!waitOptions) return result;

  await waitUntilAsync(async () => {
    if (options.childExited() || !options.isPidAlive(options.childPid)) {
      result = "exited";
      return true;
    }
    if (!options.registerGatewayEndpoint()) return false;

    const status = options.runCaptureOpenshell(["status"], { ignoreError: true });
    const namedInfo = options.runCaptureOpenshell(["gateway", "info", "-g", options.gatewayName], {
      ignoreError: true,
    });
    const currentInfo = options.runCaptureOpenshell(["gateway", "info"], {
      ignoreError: true,
    });
    // Probes take real wall-clock time. Reconfirm process liveness afterward
    // so a gateway that exits during migration cannot be reported as healthy.
    if (
      options.isGatewayHealthy(status, namedInfo, currentInfo) &&
      (await options.isGatewayTcpReady()) &&
      !options.childExited() &&
      options.isPidAlive(options.childPid)
    ) {
      await options.onHealthy();
      result = "healthy";
      return true;
    }
    return false;
  }, waitOptions);

  return result;
}
