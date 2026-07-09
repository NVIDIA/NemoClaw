// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type WaitUntilOptions, waitUntilAsync } from "../core/wait";

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
  now?: () => number;
}

export function getGatewayHealthWaitBudgetMs(
  healthPollCount: number,
  healthPollIntervalSeconds: number,
): number {
  const normalizedCount = Number.isFinite(healthPollCount) ? Math.max(0, healthPollCount) : 0;
  const normalizedIntervalSeconds = Number.isFinite(healthPollIntervalSeconds)
    ? Math.max(0, healthPollIntervalSeconds)
    : 0;
  if (normalizedCount <= 0 || normalizedIntervalSeconds <= 0) return 0;
  const budgetMs = normalizedCount * normalizedIntervalSeconds * 1000;
  return Number.isFinite(budgetMs)
    ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, budgetMs))
    : Number.MAX_SAFE_INTEGER;
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
  const intervalMs = normalizedIntervalSeconds * 1000;
  const commonOptions = {
    initialIntervalMs: intervalMs,
    maxIntervalMs: intervalMs,
    backoffFactor: 1,
    now,
    sleep,
  } satisfies WaitUntilOptions;

  // A zero interval is an accepted fast-test and operator configuration. It
  // has no meaningful time budget, so preserve the former bounded attempt
  // semantics instead of turning scheduling overhead into a zero-probe wait.
  if (intervalMs === 0) {
    return { ...commonOptions, maxAttempts: normalizedCount };
  }

  return {
    ...commonOptions,
    deadlineMs: now() + getGatewayHealthWaitBudgetMs(normalizedCount, normalizedIntervalSeconds),
  };
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
