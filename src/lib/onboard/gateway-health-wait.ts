// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WaitUntilOptions } from "../core/wait";
import { envInt } from "./env";
import {
  createReadinessWaitOptions,
  getLegacyPollDeadlineBudgetMs,
  waitUntilAsync,
} from "./readiness-wait";

type RunCaptureOpenshell = (args: string[], opts?: { ignoreError?: boolean }) => string;

export function getGatewayHealthWaitConfig(_startStatus = 0, containerState = "") {
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
  now?: () => number;
}

export function getGatewayHealthWaitBudgetMs(
  healthPollCount: number,
  healthPollIntervalSeconds: number,
): number {
  return getLegacyPollDeadlineBudgetMs(healthPollCount, healthPollIntervalSeconds);
}

export function formatGatewayHealthWaitBudget(
  healthPollCount: number,
  healthPollIntervalSeconds: number,
): string {
  const budgetMs = getGatewayHealthWaitBudgetMs(healthPollCount, healthPollIntervalSeconds);
  if (budgetMs <= 0) return "0s";
  if (budgetMs < 1000) return `${Math.ceil(budgetMs)}ms`;
  const seconds = budgetMs / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

export function formatGatewayHealthWaitLimit(
  healthPollCount: number,
  healthPollIntervalSeconds: number,
): string {
  const normalizedIntervalSeconds = Number.isFinite(healthPollIntervalSeconds)
    ? Math.max(0, healthPollIntervalSeconds)
    : 0;
  const immediateAttempts =
    normalizedIntervalSeconds === 0 && Number.isFinite(healthPollCount)
      ? Math.max(0, Math.floor(healthPollCount))
      : 0;
  if (immediateAttempts > 0) {
    return `${String(immediateAttempts)} immediate health ${immediateAttempts === 1 ? "probe" : "probes"}`;
  }
  return `${formatGatewayHealthWaitBudget(healthPollCount, healthPollIntervalSeconds)} health deadline`;
}

export function createGatewayHealthWaitOptions(
  healthPollCount: number,
  healthPollIntervalSeconds: number,
  now: () => number,
  sleep: (ms: number) => void,
): WaitUntilOptions | null {
  const normalizedCount = Number.isFinite(healthPollCount) ? Math.max(0, healthPollCount) : 0;
  if (normalizedCount <= 0) return null;

  const normalizedIntervalSeconds = Number.isFinite(healthPollIntervalSeconds)
    ? Math.max(0, healthPollIntervalSeconds)
    : 0;
  return createReadinessWaitOptions({
    budgetMs: getGatewayHealthWaitBudgetMs(normalizedCount, normalizedIntervalSeconds),
    maxIntervalMs: normalizedIntervalSeconds * 1000,
    zeroBudgetAttempts: normalizedCount,
    now,
    sleep,
  });
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
  now = Date.now,
}: GatewayHealthWaitOptions): Promise<boolean> {
  const waitOptions = createGatewayHealthWaitOptions(
    healthPollCount,
    healthPollIntervalSeconds,
    now,
    (ms) => sleepSeconds(ms / 1000),
  );
  return (
    waitOptions !== null &&
    (await waitUntilAsync(async () => {
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
    }, waitOptions))
  );
}
