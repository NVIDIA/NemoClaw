// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// #4538: the `doctor` "Config permissions" check. Detects (and, with --fix,
// repairs) a mutable OpenClaw config tree that `openclaw doctor --fix` tightened
// from the NemoClaw contract (setgid + group-writable 2770/660) back to single-
// user 700/600 — which blocks the gateway UID from persisting config edits.
//
// The orchestration is parameterized over shields' inspect/repair helpers so it
// can be unit-tested without the heavy host-probing imports in ./doctor.ts.

import type {
  MutableConfigPermsInspection,
  MutableConfigRepairResult,
} from "../../shields/mutable-config-perms";
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
  } catch {
    return null;
  }
  if (!inspection.applies) return null;

  if (inspection.ok) {
    return {
      group: "Sandbox",
      label: LABEL,
      status: "ok",
      detail: `mutable contract intact (dir ${inspection.dirMode}, ${inspection.configFile} ${inspection.fileMode})`,
    };
  }

  if (!wantsFix) {
    return {
      group: "Sandbox",
      label: LABEL,
      status: "warn",
      detail: inspection.issues.join("; "),
      hint:
        `mutable OpenClaw config was tightened (likely \`openclaw doctor --fix\` inside the sandbox); ` +
        `run \`${cliName} ${sandboxName} doctor --fix\` to restore group-write, or restart the sandbox`,
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

  let after: MutableConfigPermsInspection;
  try {
    after = inspect(sandboxName);
  } catch {
    after = { applies: false, reason: "re-inspection failed" };
  }
  const fixed = after.applies && after.ok;
  return {
    group: "Sandbox",
    label: LABEL,
    status: fixed ? "ok" : "fail",
    detail: fixed
      ? `restored mutable contract (was: ${before})`
      : `repair incomplete: ${after.applies ? after.issues.join("; ") : repairResult.errors.join("; ") || "unknown"}`,
    hint: fixed
      ? undefined
      : `inspect permissions manually or rebuild with \`${cliName} ${sandboxName} rebuild\``,
  };
}
