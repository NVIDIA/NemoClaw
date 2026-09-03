// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  postTelemetryEvent,
  TELEMETRY_DELIVERY_DEADLINE_MS,
  type TelemetryHttpConfig,
  type TelemetryHttpDeliveryResult,
} from "../../adapters/telemetry/http";
import {
  buildInstallCompletedEvent,
  type InstallCompletedEvent,
  type TelemetryEvent,
  type TelemetryOperation,
} from "../../domain/telemetry/event";

export type InstallerTelemetryResult = "delivered" | "disabled" | "failed" | "suppressed";

export interface InstallerTelemetryDependencies {
  loadConfig: () => TelemetryHttpConfig | null;
  buildEvent: (operation: TelemetryOperation) => InstallCompletedEvent;
  deliverEvent: (
    config: TelemetryHttpConfig,
    event: TelemetryEvent,
    deadlineMs: number,
  ) => Promise<TelemetryHttpDeliveryResult>;
}

// Production delivery remains structurally disabled until the telemetry client ID,
// event schemas, and collector endpoints are provisioned together.
const PRODUCTION_TELEMETRY_CONFIG: TelemetryHttpConfig | null = null;

export function loadProductionTelemetryConfig(): TelemetryHttpConfig | null {
  return PRODUCTION_TELEMETRY_CONFIG;
}

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

function defaultDependencies(): InstallerTelemetryDependencies {
  return {
    loadConfig: loadProductionTelemetryConfig,
    buildEvent: buildInstallCompletedEvent,
    deliverEvent: postTelemetryEvent,
  };
}

export async function sendInstallerTelemetry(
  operation: TelemetryOperation,
  overrides: Partial<InstallerTelemetryDependencies> = {},
): Promise<InstallerTelemetryResult> {
  if (shouldSuppressTelemetry(process.env)) return "suppressed";

  const dependencies = { ...defaultDependencies(), ...overrides };

  try {
    const config = dependencies.loadConfig();
    if (!config) return "disabled";

    const event = dependencies.buildEvent(operation);
    return await dependencies.deliverEvent(config, event, TELEMETRY_DELIVERY_DEADLINE_MS);
  } catch {
    return "failed";
  }
}
