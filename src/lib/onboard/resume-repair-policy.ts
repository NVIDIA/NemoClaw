// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";

export type ResumeRepairReason =
  | "failed_terminal_snapshot"
  | "reopened_complete_snapshot"
  | "nonterminal_snapshot"
  | "completed_nonresumable_snapshot";

export type ResumeRepairPolicyDecision =
  | {
      action: "repair";
      reason: Extract<
        ResumeRepairReason,
        "failed_terminal_snapshot" | "reopened_complete_snapshot"
      >;
    }
  | {
      action: "keep";
      reason: Extract<
        ResumeRepairReason,
        "nonterminal_snapshot" | "completed_nonresumable_snapshot"
      >;
    };

/**
 * Terminal snapshots need a compatibility bridge while resume/rebuild still
 * derives its entry point from legacy step fields. Fresh flow transitions remain
 * strict FSM behavior; this policy only classifies whether --resume must reopen
 * a terminal durable snapshot before compatibility replay.
 */
export function classifyResumeMachineRepair(session: Session): ResumeRepairPolicyDecision {
  if (session.machine.state === "failed") {
    return { action: "repair", reason: "failed_terminal_snapshot" };
  }
  if (session.machine.state !== "complete") {
    return { action: "keep", reason: "nonterminal_snapshot" };
  }
  if (session.status !== "complete" || session.resumable !== false) {
    return { action: "repair", reason: "reopened_complete_snapshot" };
  }
  return { action: "keep", reason: "completed_nonresumable_snapshot" };
}
