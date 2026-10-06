// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseTelemetryConfiguration, type TelemetryConfiguration } from "./dimensions";
import {
  isObservationOperation,
  OBSERVATION_OPERATIONS,
  parseAggregateTelemetryEvent,
  type AggregateTelemetryEvent,
} from "./observations";

export const INSTALL_COMPLETED_EVENT_NAME = "nemoclaw_install_completed" as const;
export const CONFIGURATION_COMPLETED_EVENT_NAME = "nemoclaw_configuration_completed" as const;
export const TELEMETRY_OPERATIONS = ["install", "update"] as const;
export const TELEMETRY_CONFIGURATION_OPERATIONS = OBSERVATION_OPERATIONS;

export type TelemetryOperation = (typeof TELEMETRY_OPERATIONS)[number];
export type TelemetryConfigurationOperation = (typeof TELEMETRY_CONFIGURATION_OPERATIONS)[number];

export const MAX_TELEMETRY_TEST_LABEL_LENGTH = 96;
// The label identifies a temporary QA campaign, case, and attempt, not an entity.
export const TELEMETRY_TEST_LABEL_PATTERN =
  /^qa-[a-z0-9][a-z0-9-]{0,31}:[a-z0-9][a-z0-9-]{0,39}:attempt-[1-9][0-9]{0,2}(?![\s\S])/;

export function isTelemetryTestLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_TELEMETRY_TEST_LABEL_LENGTH &&
    TELEMETRY_TEST_LABEL_PATTERN.test(value)
  );
}

/** An absent label is ordinary data; an assigned invalid label must not become ordinary data. */
export function readTelemetryTestLabel(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined | null {
  if (!Object.hasOwn(env, "NEMOCLAW_TELEMETRY_TEST_LABEL")) return undefined;
  const value = env.NEMOCLAW_TELEMETRY_TEST_LABEL;
  return isTelemetryTestLabel(value) ? value : null;
}

export interface TelemetryTestContext {
  testLabel?: string;
}

export interface InstallCompletedEvent extends TelemetryTestContext {
  event: typeof INSTALL_COMPLETED_EVENT_NAME;
  operation: TelemetryOperation;
}

export interface ConfigurationCompletedEvent extends TelemetryTestContext {
  event: typeof CONFIGURATION_COMPLETED_EVENT_NAME;
  operation: TelemetryConfigurationOperation;
  configuration: TelemetryConfiguration;
  scope?: "published_configuration";
}

export type TelemetryEvent =
  | InstallCompletedEvent
  | ConfigurationCompletedEvent
  | (AggregateTelemetryEvent & TelemetryTestContext);

export function parseTelemetryEvent(value: unknown): TelemetryEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.hasOwn(record, "testLabel")) {
    const { testLabel, ...unlabeled } = record;
    if (!isTelemetryTestLabel(testLabel)) return null;
    const event = parseTelemetryEvent(unlabeled);
    return event ? Object.freeze({ ...event, testLabel }) : null;
  }
  const install = parseInstallCompletedEvent(value);
  if (install) return install;
  const aggregate = parseAggregateTelemetryEvent(value);
  if (aggregate) return aggregate;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(record);
  if (
    !(
      (keys.length === 3 && !Object.hasOwn(record, "scope")) ||
      (keys.length === 4 && record.scope === "published_configuration")
    ) ||
    !keys.includes("event") ||
    !keys.includes("operation") ||
    !keys.includes("configuration")
  )
    return null;
  const operation = record.operation;
  if (record.event !== CONFIGURATION_COMPLETED_EVENT_NAME || !isObservationOperation(operation))
    return null;
  const configuration = parseTelemetryConfiguration(record.configuration);
  if (!configuration) return null;
  return Object.freeze({
    event: CONFIGURATION_COMPLETED_EVENT_NAME,
    operation: operation as TelemetryConfigurationOperation,
    configuration,
    ...(record.scope === "published_configuration"
      ? { scope: "published_configuration" as const }
      : {}),
  });
}

export function buildConfigurationCompletedEvent(
  operation: TelemetryConfigurationOperation,
  configuration: TelemetryConfiguration,
  scope?: "published_configuration",
): ConfigurationCompletedEvent {
  const event = parseTelemetryEvent({
    event: CONFIGURATION_COMPLETED_EVENT_NAME,
    operation,
    configuration,
    ...(scope ? { scope } : {}),
  });
  if (!event || event.event !== CONFIGURATION_COMPLETED_EVENT_NAME)
    throw new TypeError("Invalid configuration-completed telemetry event");
  return event;
}

export function isTelemetryOperation(value: unknown): value is TelemetryOperation {
  return TELEMETRY_OPERATIONS.some((operation) => operation === value);
}

export function parseInstallCompletedEvent(value: unknown): InstallCompletedEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("event") || !keys.includes("operation")) return null;

  const event = record.event;
  const operation = record.operation;
  if (event !== INSTALL_COMPLETED_EVENT_NAME || !isTelemetryOperation(operation)) return null;

  return Object.freeze({ event: INSTALL_COMPLETED_EVENT_NAME, operation });
}

export function buildInstallCompletedEvent(operation: TelemetryOperation): InstallCompletedEvent {
  const event = parseInstallCompletedEvent({
    event: INSTALL_COMPLETED_EVENT_NAME,
    operation,
  });
  if (!event) throw new TypeError("Invalid install-completed telemetry event");
  return event;
}
