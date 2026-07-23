// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry";
import type { DoctorCheck } from "./doctor-report";

type LifecycleOperation = "snapshot" | "rebuild" | "upgrade" | "recovery" | "reboot";

type FieldIssue = {
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
  imageTag: ["rebuild", "upgrade", "recovery"],
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

function isNullablePort(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535)
  );
}

function addPresenceIssue(
  issues: FieldIssue[],
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

function hasManagedImageEvidence(entry: SandboxEntry): boolean {
  return isPresentString(entry.nemoclawVersion);
}

function hasCustomImageEvidence(entry: SandboxEntry): boolean {
  return isPresentString(entry.fromDockerfile);
}

function collectLifecycleRegistrationIssues(entry: SandboxEntry): FieldIssue[] {
  const issues: FieldIssue[] = [];
  addPresenceIssue(issues, entry, "openshellDriver", isPresentString);
  addPresenceIssue(issues, entry, "openshellVersion", isNullableString);
  addPresenceIssue(issues, entry, "fromDockerfile", isNullableString);
  addPresenceIssue(issues, entry, "dashboardPort", isNullablePort);
  addPresenceIssue(issues, entry, "imageTag", isNullableString);
  addPresenceIssue(issues, entry, "gatewayName", isNullableString);
  addPresenceIssue(issues, entry, "gatewayPort", isNullablePort);

  if (!hasCustomImageEvidence(entry)) {
    addPresenceIssue(issues, entry, "nemoclawVersion", isNullableString);
    if (!hasManagedImageEvidence(entry)) {
      issues.push({
        field: "nemoclawVersion",
        reason: "missing",
        operations: LIFECYCLE_FIELD_OPERATIONS.nemoclawVersion,
      });
    }
  }

  return issues;
}

function uniqueOrdered<T extends string>(values: readonly T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function formatFieldList(issues: readonly FieldIssue[], reason: FieldIssue["reason"]): string {
  return uniqueOrdered(
    issues.filter((issue) => issue.reason === reason).map((issue) => issue.field),
  )
    .sort()
    .join(", ");
}

export function buildLifecycleRegistrationCheck(
  sandboxName: string,
  entry: SandboxEntry,
  cliName: string,
): DoctorCheck {
  const issues = collectLifecycleRegistrationIssues(entry);
  if (issues.length === 0) {
    return {
      group: "Sandbox",
      label: "Lifecycle registration",
      status: "ok",
      detail:
        "registry entry has lifecycle metadata for snapshot, rebuild, upgrade, recovery, and reboot",
    };
  }

  const affectedOperations = uniqueOrdered(issues.flatMap((issue) => issue.operations)).sort();
  const missingFields = formatFieldList(issues, "missing");
  const invalidFields = formatFieldList(issues, "invalid");
  const fieldParts = [
    missingFields ? `missing ${missingFields}` : null,
    invalidFields ? `invalid ${invalidFields}` : null,
  ].filter((part): part is string => part !== null);

  return {
    group: "Sandbox",
    label: "Lifecycle registration",
    status: "warn",
    detail: `registry entry incomplete for lifecycle operations (${fieldParts.join("; ")}; affected: ${affectedOperations.join(", ")})`,
    hint: `re-register or re-onboard '${sandboxName}' before running lifecycle commands such as \`${cliName} ${sandboxName} snapshot create\` or \`${cliName} ${sandboxName} rebuild\``,
  };
}
