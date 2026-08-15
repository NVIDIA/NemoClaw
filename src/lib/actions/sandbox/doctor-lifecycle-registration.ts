// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  collectLifecycleRegistrationIssues,
  type LifecycleRegistrationIssue,
} from "../../domain/lifecycle-registration";
import { inspectPortableRuntimeReceiptReadiness } from "../../onboard/experimental/portable-runtime-receipt-readiness";
import type { SandboxEntry } from "../../state/registry";
import type { DoctorCheck } from "./doctor-report";

function uniqueOrdered<T extends string>(values: readonly T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function formatFieldList(
  issues: readonly LifecycleRegistrationIssue[],
  reason: LifecycleRegistrationIssue["reason"],
): string {
  return uniqueOrdered(
    issues.filter((issue) => issue.reason === reason).map((issue) => issue.field),
  )
    .sort()
    .join(", ");
}

export function buildPortableRuntimeCheck(sandboxName: string): DoctorCheck | null {
  const portable = inspectPortableRuntimeReceiptReadiness(sandboxName);
  if (!portable) return null;
  const recordedSocket =
    !portable.ok && portable.socketPath ? ` Recorded socket: ${portable.socketPath}.` : "";
  const recoveryHint =
    !portable.ok && !portable.socketPath
      ? portable.recovery === "current-user-authority"
        ? "run NemoClaw as the user who created the portable state, or rerun portable onboarding as the current user"
        : "rerun portable onboarding with `nemoclaw onboard --experimental-profile portable`, then retry"
      : "repair the recorded current-user Podman endpoint, then retry";
  return portable.ok
    ? {
        group: "Host",
        label: "Portable Podman API",
        status: "ok",
        detail: `server ${portable.serverVersion}; ${portable.timing.mode}; activation ${String(portable.timing.activationMs)} ms; API ${String(portable.timing.apiMs)} ms; total ${String(portable.timing.totalMs)} ms`,
      }
    : {
        group: "Host",
        label: "Portable Podman API",
        status: "fail",
        detail: `${portable.stage}: ${portable.detail}${recordedSocket}`,
        hint: recoveryHint,
      };
}

export function buildLifecycleRegistrationCheck(
  sandboxName: string,
  entry: SandboxEntry,
  cliName: string,
  options: { dashboardPortRequired?: boolean } = {},
): DoctorCheck {
  const issues = collectLifecycleRegistrationIssues(entry, {
    dashboardPortRequired: options.dashboardPortRequired !== false,
  });
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
