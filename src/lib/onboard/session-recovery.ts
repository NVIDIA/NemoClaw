// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createSessionRecoveryReceiptId,
  MACHINE_SNAPSHOT_VERSION,
  type Session,
} from "../state/onboard-session";
import { isTerminalOnboardMachineState } from "./machine/transitions";
import type { OnboardMachineState, OnboardNonTerminalMachineState } from "./machine/types";
import { resumeMachineState } from "./resume-machine-repair";
import { classifyResumeMachineRepair, type ResumeRepairReason } from "./resume-repair-policy";

/**
 * The single, deterministic recovery decision for a resumed session.
 *
 * `recover` re-seats a terminal (failed / reopened-complete) durable snapshot at
 * a validated non-terminal entry state; `keep` leaves a nonterminal or
 * legitimately-complete snapshot untouched. This is the one explicit recovery
 * path that replaces the previous implicit snapshot rewrite, so terminal states
 * stay terminal within the FSM graph while recovery stays observable.
 */
export type SessionRecoveryPlan =
  | {
      action: "recover";
      reason: Extract<
        ResumeRepairReason,
        "failed_terminal_snapshot" | "reopened_complete_snapshot"
      >;
      entry: OnboardNonTerminalMachineState;
    }
  | {
      action: "keep";
      reason: Extract<
        ResumeRepairReason,
        "nonterminal_snapshot" | "completed_nonresumable_snapshot"
      >;
    };

/**
 * Raised when a session cannot be recovered to a legal non-terminal entry
 * state. Signals unrecoverable durable corruption rather than a recoverable
 * failure or user cancellation.
 */
export class UnrecoverableSessionError extends Error {
  readonly derivedEntry: string;

  constructor(derivedEntry: string) {
    super(
      `Cannot recover onboarding session: derived resume entry '${derivedEntry}' is not a legal non-terminal state.`,
    );
    this.name = "UnrecoverableSessionError";
    this.derivedEntry = derivedEntry;
  }
}

/**
 * Validates that a derived resume entry is a legal non-terminal state.
 *
 * Recovery must place the machine at a state the flow can advance from; a
 * terminal entry means the durable session is corrupt beyond recovery.
 */
export function assertRecoverableEntry(entry: OnboardMachineState): OnboardNonTerminalMachineState {
  if (isTerminalOnboardMachineState(entry)) {
    throw new UnrecoverableSessionError(entry);
  }
  return entry;
}

function assertCanonicalRecoveryTimestamp(value: string): string {
  try {
    if (new Date(value).toISOString() === value) return value;
  } catch {
    // Fall through to the stable caller-facing error below.
  }
  throw new TypeError("Session recovery requires a canonical ISO timestamp.");
}

/**
 * Classifies a resumed session and, when recovery is required, computes and
 * validates the single non-terminal entry state to resume from.
 *
 * Pure and side-effect-free: performs no sandbox/provider/policy effects and
 * does not mutate the session. Callers apply the plan with
 * {@link applySessionRecovery}.
 */
export function planSessionRecovery(session: Session): SessionRecoveryPlan {
  const decision = classifyResumeMachineRepair(session);
  if (decision.action === "keep") {
    return decision;
  }
  const entry = assertRecoverableEntry(resumeMachineState(session));
  return { action: "recover", reason: decision.reason, entry };
}

/**
 * Applies {@link planSessionRecovery} to the session in place.
 *
 * When the plan is `recover`, re-seats `session.machine` at the validated
 * non-terminal entry with a bumped revision and a deterministic durable
 * receipt. The receipt lets the next process retry the same completion-event
 * dispatch ID if this process stops after the repaired snapshot is persisted
 * but before the next transition. Observer delivery remains best-effort.
 * Performs no side effects beyond the snapshot mutation and must run before
 * any flow handler.
 */
export function applySessionRecovery(
  session: Session,
  stateEnteredAt: string = new Date().toISOString(),
): SessionRecoveryPlan {
  const plan = planSessionRecovery(session);
  if (plan.action === "recover") {
    const appliedAt = assertCanonicalRecoveryTimestamp(stateEnteredAt);
    const revision = session.machine.revision + 1;
    const id = createSessionRecoveryReceiptId(session.sessionId, revision, plan.reason, plan.entry);
    session.machine = {
      version: MACHINE_SNAPSHOT_VERSION,
      state: plan.entry,
      stateEnteredAt: appliedAt,
      revision,
      recoveryReceipt: {
        id,
        reason: plan.reason,
        entry: plan.entry,
        appliedAt,
        revision,
      },
    };
  }
  return plan;
}
