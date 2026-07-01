// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { sleepSeconds, waitUntilAsync } from "../core/wait";
import { isGatewayHealthy } from "../state/gateway";
import { envInt } from "./env";
import { isDockerDriverGatewayHttpReady } from "./gateway-http-readiness";
import {
  hasOpenShellGatewayUserService,
  startOpenShellGatewayUserService,
  stopOpenShellGatewayUserService,
  type OpenShellGatewayUserServiceOptions,
  type OpenShellGatewayUserServiceStartResult,
  type OpenShellGatewayUserServiceStopResult,
} from "./openshell-gateway-user-service";
export {
  getOpenShellGatewayUserServiceBinaryPaths,
  getOpenShellGatewayUserServicePaths,
  hasOpenShellGatewayUserService,
  startOpenShellGatewayUserService,
  stopOpenShellGatewayUserService,
} from "./openshell-gateway-user-service";
export type {
  OpenShellGatewayUserServiceOptions,
  OpenShellGatewayUserServiceStartResult,
  OpenShellGatewayUserServiceStopResult,
  SpawnSyncLike,
  SpawnSyncLikeResult,
} from "./openshell-gateway-user-service";

interface SandboxBridgeVerifierOptions {
  onUnreachable?: () => Promise<void> | void;
  skip?: boolean;
}

export interface PackageManagedDockerDriverGatewayOptions {
  clearDockerDriverGatewayRuntimeFiles: () => void;
  exitOnFailure: boolean;
  gatewayName: string;
  hasOpenShellGatewayUserService?: () => boolean;
  healthPollCount?: number;
  healthPollInterval?: number;
  isDockerDriverGatewayReady?: () => Promise<boolean>;
  registerDockerDriverGatewayEndpoint: () => boolean;
  runCaptureOpenshell: (args: string[], opts?: { ignoreError?: boolean }) => string;
  sleepSeconds?: (seconds: number) => void;
  prepareOpenShellGatewayUserServiceEnv?: () => void;
  skipSandboxBridgeReachability: boolean;
  startOpenShellGatewayUserService?: (
    opts?: Pick<OpenShellGatewayUserServiceOptions, "prepareServiceEnv">,
  ) => OpenShellGatewayUserServiceStartResult;
  stopOpenShellGatewayUserService?: () => OpenShellGatewayUserServiceStopResult;
  verifySandboxBridgeGatewayReachableOrExit: (
    exitOnFailure: boolean,
    options?: SandboxBridgeVerifierOptions,
  ) => Promise<void>;
}

export async function startPackageManagedDockerDriverGateway({
  clearDockerDriverGatewayRuntimeFiles,
  exitOnFailure,
  gatewayName,
  hasOpenShellGatewayUserService:
    hasOpenShellGatewayUserServiceImpl = hasOpenShellGatewayUserService,
  healthPollCount,
  healthPollInterval,
  isDockerDriverGatewayReady = isDockerDriverGatewayHttpReady,
  registerDockerDriverGatewayEndpoint,
  runCaptureOpenshell,
  sleepSeconds: sleepSecondsImpl = sleepSeconds,
  prepareOpenShellGatewayUserServiceEnv,
  skipSandboxBridgeReachability,
  startOpenShellGatewayUserService:
    startOpenShellGatewayUserServiceImpl = startOpenShellGatewayUserService,
  stopOpenShellGatewayUserService:
    stopOpenShellGatewayUserServiceImpl = stopOpenShellGatewayUserService,
  verifySandboxBridgeGatewayReachableOrExit,
}: PackageManagedDockerDriverGatewayOptions): Promise<boolean> {
  if (!hasOpenShellGatewayUserServiceImpl()) return false;

  console.log("  Starting OpenShell Docker-driver gateway via upstream user service...");
  const serviceStart = startOpenShellGatewayUserServiceImpl({
    prepareServiceEnv: prepareOpenShellGatewayUserServiceEnv,
  });
  if (!serviceStart.started) {
    const detail = serviceStart.reason ? ` (${serviceStart.reason})` : "";
    if (serviceStart.fallbackAllowed) {
      console.warn(
        `  OpenShell gateway user service is unavailable${detail}; using standalone fallback.`,
      );
      return false;
    }
    const message = `OpenShell gateway user service failed to start${detail}.`;
    console.error(`  ${message}`);
    console.error("  Check: systemctl --user status openshell-gateway");
    if (exitOnFailure) process.exit(1);
    throw new Error(message);
  }

  const pollCount = healthPollCount ?? envInt("NEMOCLAW_HEALTH_POLL_COUNT", 30);
  const pollInterval = healthPollInterval ?? envInt("NEMOCLAW_HEALTH_POLL_INTERVAL", 2);
  const pollIntervalMs = Math.max(0, pollInterval * 1000);
  const healthy =
    pollCount > 0 &&
    (await waitUntilAsync(
      async () => {
        if (!registerDockerDriverGatewayEndpoint()) return false;
        const status = runCaptureOpenshell(["status"], { ignoreError: true });
        const namedInfo = runCaptureOpenshell(["gateway", "info", "-g", gatewayName], {
          ignoreError: true,
        });
        const currentInfo = runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
        return (
          isGatewayHealthy(status, namedInfo, currentInfo) && (await isDockerDriverGatewayReady())
        );
      },
      {
        initialIntervalMs: pollIntervalMs,
        maxIntervalMs: pollIntervalMs,
        backoffFactor: 1,
        maxAttempts: pollCount,
        sleep: (ms) => sleepSecondsImpl(ms / 1000),
      },
    ));
  if (healthy) {
    clearDockerDriverGatewayRuntimeFiles();
    await verifySandboxBridgeGatewayReachableOrExit(exitOnFailure, {
      skip: skipSandboxBridgeReachability,
      onUnreachable: () => {
        const stop = stopOpenShellGatewayUserServiceImpl();
        if (!stop.stopped) {
          const detail = stop.reason ? `: ${stop.reason}` : "";
          throw new Error(`failed to stop OpenShell gateway user service${detail}`);
        }
      },
    });
    console.log("  ✓ OpenShell gateway user service is healthy");
    return true;
  }

  const message = "OpenShell gateway user service started but did not become healthy.";
  console.error(`  ${message}`);
  console.error("  Check: systemctl --user status openshell-gateway");
  if (exitOnFailure) process.exit(1);
  throw new Error(message);
}
