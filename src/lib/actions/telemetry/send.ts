// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { performance } from "node:perf_hooks";

import {
  postTelemetryEvent,
  postTelemetryBatch,
  TELEMETRY_DELIVERY_DEADLINE_MS,
  type TelemetryHttpConfig,
  type TelemetryHttpDeliveryResult,
} from "../../adapters/telemetry/http";
import {
  buildInstallCompletedEvent,
  buildConfigurationCompletedEvent,
  type ConfigurationCompletedEvent,
  type TelemetryConfigurationOperation,
  type InstallCompletedEvent,
  type TelemetryOperation,
  parseTelemetryEvent,
  readTelemetryTestLabel,
  type TelemetryEvent,
} from "../../domain/telemetry/event";
import type { TelemetryConfiguration } from "../../domain/telemetry/dimensions";
import { MAX_TELEMETRY_BATCH_EVENTS } from "../../domain/telemetry/observations";

export type InstallerTelemetryResult = "delivered" | "disabled" | "failed" | "suppressed";

export interface InstallerTelemetryDependencies {
  loadConfig: () => TelemetryHttpConfig | null;
  buildEvent: (operation: TelemetryOperation) => InstallCompletedEvent;
  deliverEvent: (
    config: TelemetryHttpConfig,
    event: InstallCompletedEvent,
    deadlineMs: number,
  ) => Promise<TelemetryHttpDeliveryResult>;
}

// Registration alone does not enable collection. Service, consent, location,
// and protected-record access must be verified before production activation.
const PRODUCTION_TELEMETRY_CONFIG: TelemetryHttpConfig | null = null;

export function loadTelemetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryHttpConfig | null {
  if (shouldSuppressTelemetry(env)) return null;
  if (env.NEMOCLAW_TELEMETRY_ENV === "uat" && readTelemetryTestLabel(env)) {
    return { endpoint: new URL("https://events.telemetry.data-uat.nvidia.com/v1.1/events/json") };
  }
  return env.NEMOCLAW_TELEMETRY_ENV === undefined ? PRODUCTION_TELEMETRY_CONFIG : null;
}

export function shouldSuppressTelemetry(env: NodeJS.ProcessEnv): boolean {
  return (
    readTelemetryTestLabel(env) === null ||
    (env.NEMOCLAW_TELEMETRY_ENV === "uat" && !readTelemetryTestLabel(env)) ||
    env.NEMOCLAW_DISABLE_TELEMETRY === "1" ||
    env.CI === "true" ||
    env.CI === "1" ||
    env.GITHUB_ACTIONS === "true" ||
    env.VITEST === "true" ||
    env.NEMOCLAW_RUN_LIVE_E2E === "1" ||
    Boolean(env.NEMOCLAW_E2E_EXPECTED_SHA?.trim()) ||
    env.NODE_ENV === "test"
  );
}

function defaultDependencies(): InstallerTelemetryDependencies {
  return {
    loadConfig: loadTelemetryConfig,
    buildEvent: buildInstallCompletedEvent,
    deliverEvent: postTelemetryEvent,
  };
}

export async function sendInstallerTelemetry(
  operation: TelemetryOperation,
  overrides: Partial<InstallerTelemetryDependencies> = {},
): Promise<InstallerTelemetryResult> {
  if (shouldSuppressTelemetry(process.env)) return "suppressed";
  const testLabel = readTelemetryTestLabel(process.env);

  const dependencies = { ...defaultDependencies(), ...overrides };

  try {
    const config = dependencies.loadConfig();
    if (!config) return "disabled";

    const parsed = parseTelemetryEvent(dependencies.buildEvent(operation));
    if (!parsed || (parsed.testLabel !== undefined && parsed.testLabel !== testLabel))
      return "failed";
    const event = testLabel ? parseTelemetryEvent({ ...parsed, testLabel }) : parsed;
    if (!event || event.event !== "nemoclaw_install_completed") return "failed";
    return await dependencies.deliverEvent(config, event, TELEMETRY_DELIVERY_DEADLINE_MS);
  } catch {
    return "failed";
  }
}

export interface ConfigurationTelemetryDependencies {
  loadConfig: () => TelemetryHttpConfig | null;
  monotonicNow: () => number;
  buildEvent: (
    operation: TelemetryConfigurationOperation,
    configuration: TelemetryConfiguration,
  ) => ConfigurationCompletedEvent;
  deliverEvent: (
    config: TelemetryHttpConfig,
    event: ConfigurationCompletedEvent,
    deadlineMs: number,
  ) => Promise<TelemetryHttpDeliveryResult>;
}

export async function sendConfigurationTelemetry(
  operation: TelemetryConfigurationOperation,
  loadSnapshot: () => TelemetryConfiguration | null,
  overrides: Partial<ConfigurationTelemetryDependencies> = {},
): Promise<InstallerTelemetryResult> {
  if (shouldSuppressTelemetry(process.env)) return "suppressed";
  const testLabel = readTelemetryTestLabel(process.env);
  const dependencies: ConfigurationTelemetryDependencies = {
    loadConfig: loadTelemetryConfig,
    monotonicNow: () => performance.now(),
    buildEvent: buildConfigurationCompletedEvent,
    deliverEvent: postTelemetryEvent,
    ...overrides,
  };
  try {
    const config = dependencies.loadConfig();
    if (!config) return "disabled";
    const collectionStartedAt = dependencies.monotonicNow();
    // Do not read registry, host, or location data before opt-out and activation checks.
    const snapshot = loadSnapshot();
    if (!snapshot) return "failed";
    const parsed = parseTelemetryEvent(dependencies.buildEvent(operation, snapshot));
    if (!parsed || (parsed.testLabel !== undefined && parsed.testLabel !== testLabel))
      return "failed";
    const event = testLabel ? parseTelemetryEvent({ ...parsed, testLabel }) : parsed;
    if (!event || event.event !== "nemoclaw_configuration_completed") return "failed";
    const elapsed = dependencies.monotonicNow() - collectionStartedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0) return "failed";
    const elapsedMs = Math.ceil(elapsed);
    const remainingMs = TELEMETRY_DELIVERY_DEADLINE_MS - elapsedMs;
    if (remainingMs <= 0) return "failed";
    return await dependencies.deliverEvent(config, event, remainingMs);
  } catch {
    return "failed";
  }
}

export interface ConfigurationSnapshotTelemetryDependencies {
  loadConfig: () => TelemetryHttpConfig | null;
  monotonicNow: () => number;
  deliverBatch: (
    config: TelemetryHttpConfig,
    events: readonly TelemetryEvent[],
    deadlineMs: number,
  ) => Promise<TelemetryHttpDeliveryResult>;
}

/** One completed operation observes one complete registry snapshot in one request. */
export async function sendConfigurationSnapshotTelemetry(
  operation: TelemetryConfigurationOperation,
  loadSnapshot: () => readonly TelemetryEvent[] | null,
  overrides: Partial<ConfigurationSnapshotTelemetryDependencies> = {},
): Promise<InstallerTelemetryResult> {
  if (shouldSuppressTelemetry(process.env)) return "suppressed";
  const testLabel = readTelemetryTestLabel(process.env);
  const dependencies: ConfigurationSnapshotTelemetryDependencies = {
    loadConfig: loadTelemetryConfig,
    monotonicNow: () => performance.now(),
    deliverBatch: postTelemetryBatch,
    ...overrides,
  };
  try {
    const config = dependencies.loadConfig();
    if (!config) return "disabled";
    const startedAt = dependencies.monotonicNow();
    const snapshot = loadSnapshot();
    if (
      !snapshot ||
      !Array.isArray(snapshot) ||
      snapshot.length === 0 ||
      snapshot.length > MAX_TELEMETRY_BATCH_EVENTS
    ) {
      return "failed";
    }
    const events: TelemetryEvent[] = [];
    for (let index = 0; index < snapshot.length; index++) {
      const parsed = parseTelemetryEvent(snapshot[index]);
      if (!parsed || (parsed.testLabel !== undefined && parsed.testLabel !== testLabel))
        return "failed";
      const event = testLabel ? parseTelemetryEvent({ ...parsed, testLabel }) : parsed;
      if (!event || event.event === "nemoclaw_install_completed" || event.operation !== operation)
        return "failed";
      events.push(event);
    }
    const elapsed = dependencies.monotonicNow() - startedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0) return "failed";
    const remainingMs = TELEMETRY_DELIVERY_DEADLINE_MS - Math.ceil(elapsed);
    if (remainingMs <= 0) return "failed";
    return await dependencies.deliverBatch(config, Object.freeze(events), remainingMs);
  } catch {
    return "failed";
  }
}
