// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readTelemetryTestLabel } from "../../domain/telemetry/event";

export const TEST_TELEMETRY_ENDPOINT =
  "https://events.telemetry.data-uat.nvidia.com/v1.1/events/json";
export interface TelemetryDeliveryConfig {
  endpoint: URL;
  localReceiver?: boolean;
}

// Registration and TEST validation are separate from Production activation.
export const telemetryRuntime: { config: TelemetryDeliveryConfig | null } = { config: null };

export function shouldSuppressTelemetry(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NEMOCLAW_DISABLE_TELEMETRY === "1" ||
    env.CI === "true" ||
    env.CI === "1" ||
    env.GITHUB_ACTIONS === "true" ||
    env.VITEST === "true" ||
    env.NODE_ENV === "test"
  );
}

export function allowedTelemetryEndpoint(config: TelemetryDeliveryConfig): boolean {
  const url = config.endpoint;
  if (url.username || url.password || url.search || url.hash) return false;
  if (config.localReceiver)
    return url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  return url.href === TEST_TELEMETRY_ENDPOINT;
}

export function allowedTelemetryCollection(
  config: TelemetryDeliveryConfig | null,
  testLabel: string | null,
): boolean {
  return (
    config !== null &&
    allowedTelemetryEndpoint(config) &&
    testLabel !== null &&
    (config.localReceiver === true || testLabel.length > 0)
  );
}

/** Select the fixed TEST receiver before a CLI or installer operation starts. */
export function resolveTelemetryDeliveryConfig(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryDeliveryConfig | null {
  if (shouldSuppressTelemetry(env)) return null;
  const label = readTelemetryTestLabel(env);
  if (label === null) return null;
  if (!telemetryRuntime.config && label.length > 0) {
    telemetryRuntime.config = { endpoint: new URL(TEST_TELEMETRY_ENDPOINT) };
  }
  return allowedTelemetryCollection(telemetryRuntime.config, label)
    ? telemetryRuntime.config
    : null;
}

export async function postOperationRecord(
  config: TelemetryDeliveryConfig,
  body: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!allowedTelemetryEndpoint(config) || signal.aborted) return false;
  const response = await fetch(config.endpoint, {
    method: "POST",
    body,
    signal,
    redirect: "error",
    credentials: "omit",
    headers: { "Content-Type": "application/json", "X-Event-Protocol": "1.6" },
  });
  await response.body?.cancel();
  return response.ok;
}
