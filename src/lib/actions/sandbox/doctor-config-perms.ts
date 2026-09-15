// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// The config guard owns the runtime's private or shared permission contract.
//
// The orchestration is parameterized over inspect/repair helpers so it can be
// unit-tested without the heavy host-probing imports in ./doctor.ts.

import type {
  MutableConfigPermsInspection,
  MutableConfigRepairResult,
} from "../../sandbox/mutable-config-perms";
import type { DoctorCheck } from "./doctor";

export interface ConfigPermsCheckDeps {
  inspect: (sandboxName: string) => MutableConfigPermsInspection;
  repair: (sandboxName: string) => MutableConfigRepairResult;
  cliName: string;
}

const LABEL = "Config permissions";

export function buildConfigPermsCheck(
  sandboxName: string,
  wantsFix: boolean,
  deps: ConfigPermsCheckDeps,
): DoctorCheck | null {
  const { inspect, repair, cliName } = deps;

  let inspection: MutableConfigPermsInspection;
  try {
    inspection = inspect(sandboxName);
  } catch (err) {
    // The probe itself failed unexpectedly. Surface it rather than dropping the
    // check, so `doctor` does not report a healthy sandbox when it could not
    // actually verify the permission contract.
    return {
      group: "Sandbox",
      label: LABEL,
      status: "warn",
      detail: `permission probe failed: ${err instanceof Error ? err.message : String(err)}`,
      hint: `re-run \`${cliName} ${sandboxName} doctor\`, or rebuild with \`${cliName} ${sandboxName} rebuild\``,
    };
  }
  if (!inspection.applies) {
    return inspection.skipReason === "agent"
      ? null
      : {
          group: "Sandbox",
          label: LABEL,
          status: "warn",
          detail: `config posture could not be verified: ${inspection.reason}`,
        };
  }

  if (inspection.ok) {
    return {
      group: "Sandbox",
      label: LABEL,
      status: "ok",
      detail: "runtime config permission contract verified",
    };
  }

  if (!wantsFix) {
    return {
      group: "Sandbox",
      label: LABEL,
      status: "warn",
      detail: inspection.issues.join("; "),
      hint: `run \`${cliName} ${sandboxName} doctor --fix\` to restore the runtime config permissions`,
    };
  }

  const before = inspection.issues.join("; ");
  let repairResult: MutableConfigRepairResult;
  try {
    repairResult = repair(sandboxName);
  } catch (err) {
    return {
      group: "Sandbox",
      label: LABEL,
      status: "fail",
      detail: `repair failed: ${err instanceof Error ? err.message : String(err)} (was: ${before})`,
      hint: `inspect permissions manually or rebuild with \`${cliName} ${sandboxName} rebuild\``,
    };
  }
  if (!repairResult.applied) {
    return {
      group: "Sandbox",
      label: LABEL,
      status: "warn",
      detail: `repair skipped: ${repairResult.reason} (issues: ${before})`,
    };
  }

  const fixed = repairResult.verified;
  return {
    group: "Sandbox",
    label: LABEL,
    status: fixed ? "ok" : "fail",
    detail: fixed
      ? `runtime config permissions verified after repair (was: ${before})`
      : `repair incomplete: ${repairResult.errors.join("; ") || "verification failed"}`,
    hint: fixed
      ? undefined
      : `inspect permissions manually or rebuild with \`${cliName} ${sandboxName} rebuild\``,
  };
}
