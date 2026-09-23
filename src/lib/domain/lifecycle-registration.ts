// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../state/registry";

export type LifecycleOperation = "snapshot" | "rebuild" | "upgrade" | "recovery" | "reboot";

export type LifecycleRegistrationIssue = {
  field: keyof SandboxEntry;
  reason: "missing" | "invalid";
  operations: readonly LifecycleOperation[];
};

const LIFECYCLE_FIELD_OPERATIONS = {
  openshellDriver: ["snapshot", "recovery", "reboot"],
  openshellVersion: ["snapshot", "recovery", "reboot"],
  nemoclawVersion: ["rebuild", "upgrade", "recovery"],
  fromDockerfile: ["rebuild", "upgrade", "recovery"],
  dashboardPort: ["rebuild", "recovery", "reboot"],
  imageTag: ["snapshot", "rebuild", "upgrade", "recovery"],
  gatewayName: ["snapshot", "recovery", "reboot"],
  gatewayPort: ["snapshot", "recovery", "reboot"],
} as const satisfies Record<string, readonly LifecycleOperation[]>;

function hasOwn(entry: SandboxEntry, field: keyof SandboxEntry): boolean {
  return Object.prototype.hasOwnProperty.call(entry, field);
}

function isPresentString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): boolean {
  return value === null || isPresentString(value);
}

function isPort(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

function isNullablePort(value: unknown): boolean {
  return value === null || isPort(value);
}

function addPresenceIssue(
  issues: LifecycleRegistrationIssue[],
  entry: SandboxEntry,
  field: keyof typeof LIFECYCLE_FIELD_OPERATIONS,
  isValid: (value: unknown) => boolean,
): void {
  if (!hasOwn(entry, field)) {
    issues.push({ field, reason: "missing", operations: LIFECYCLE_FIELD_OPERATIONS[field] });
    return;
  }
  if (!isValid(entry[field])) {
    issues.push({ field, reason: "invalid", operations: LIFECYCLE_FIELD_OPERATIONS[field] });
  }
}

function addOptionalIssue(
  issues: LifecycleRegistrationIssue[],
  entry: SandboxEntry,
  field: keyof typeof LIFECYCLE_FIELD_OPERATIONS,
  isValid: (value: unknown) => boolean,
): void {
  if (hasOwn(entry, field) && !isValid(entry[field])) {
    issues.push({ field, reason: "invalid", operations: LIFECYCLE_FIELD_OPERATIONS[field] });
  }
}

function hasCustomImageEvidence(entry: SandboxEntry): boolean {
  return isPresentString(entry.fromDockerfile);
}

export function collectLifecycleRegistrationIssues(
  entry: SandboxEntry,
  options: { dashboardPortRequired: boolean },
): LifecycleRegistrationIssue[] {
  const issues: LifecycleRegistrationIssue[] = [];
  addPresenceIssue(issues, entry, "openshellDriver", isPresentString);
  addPresenceIssue(issues, entry, "openshellVersion", isPresentString);
  addPresenceIssue(issues, entry, "fromDockerfile", isNullableString);
  if (options.dashboardPortRequired) {
    addPresenceIssue(issues, entry, "dashboardPort", isPort);
  } else {
    addOptionalIssue(issues, entry, "dashboardPort", isNullablePort);
  }
  addPresenceIssue(issues, entry, "imageTag", isPresentString);
  addPresenceIssue(issues, entry, "gatewayName", isNullableString);
  addPresenceIssue(issues, entry, "gatewayPort", isNullablePort);

  if (!hasCustomImageEvidence(entry)) {
    addPresenceIssue(issues, entry, "nemoclawVersion", isPresentString);
  }

  return issues;
}
