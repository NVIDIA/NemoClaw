// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const INSTALL_COMPLETED_EVENT_NAME = "nemoclaw_install_completed" as const;
export const TELEMETRY_OPERATIONS = ["install", "update"] as const;

export type TelemetryOperation = (typeof TELEMETRY_OPERATIONS)[number];

export interface InstallCompletedEvent {
  event: typeof INSTALL_COMPLETED_EVENT_NAME;
  operation: TelemetryOperation;
}

// Keep every sendable event in this closed union. Adding a new schema requires
// an explicit type, validator branch, and tests before the shared client can send it.
export type TelemetryEvent = InstallCompletedEvent;

export function isTelemetryOperation(value: unknown): value is TelemetryOperation {
  return value === "install" || value === "update";
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

export function parseTelemetryEvent(value: unknown): TelemetryEvent | null {
  return parseInstallCompletedEvent(value);
}

export function isInstallCompletedEvent(value: unknown): value is InstallCompletedEvent {
  return parseInstallCompletedEvent(value) !== null;
}

export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  return parseTelemetryEvent(value) !== null;
}

export function buildInstallCompletedEvent(operation: TelemetryOperation): InstallCompletedEvent {
  const event = parseInstallCompletedEvent({
    event: INSTALL_COMPLETED_EVENT_NAME,
    operation,
  });
  if (!event) throw new TypeError("Invalid install-completed telemetry event");
  return event;
}
