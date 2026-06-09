// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  MACHINE_SNAPSHOT_VERSION,
  type Session,
} from "../state/onboard-session";
import { nextMachineStateAfterCompletedStep } from "../state/onboard-step-state";
import { machineStateFromOnboardSessionStep } from "./machine/events";
import type { OnboardMachineState } from "./machine/types";

/**
 * Reads the legacy step-level source of truth for interrupted sessions whose
 * durable FSM snapshot was already collapsed to the terminal failed state.
 */
function activeStepMachineState(session: Session): OnboardMachineState | null {
  const failedStepName = session.failure?.step ?? null;
  const failedStep = failedStepName ? session.steps[failedStepName] : null;
  const failedState = machineStateFromOnboardSessionStep(failedStepName);
  if (failedState && (failedStep?.status === "failed" || failedStep?.status === "in_progress")) {
    return failedState;
  }

  const startedStepName = session.lastStepStarted;
  const startedStep = startedStepName ? session.steps[startedStepName] : null;
  const startedState = machineStateFromOnboardSessionStep(startedStepName);
  if (
    startedState &&
    (startedStep?.status === "failed" || startedStep?.status === "in_progress")
  ) {
    return startedState;
  }

  return null;
}

/**
 * Computes the nonterminal state where a failed durable session should resume.
 */
export function resumeMachineState(session: Session): OnboardMachineState {
  return activeStepMachineState(session) ?? nextMachineStateAfterCompletedStep(
    session.lastCompletedStep,
    session,
  ) ?? "init";
}

function shouldRepairTerminalMachineSnapshot(session: Session): boolean {
  if (session.machine.state === "failed") return true;
  return (
    session.machine.state === "complete" &&
    (session.status !== "complete" || session.resumable !== false)
  );
}

/**
 * Repairs legacy terminal-session/FSM boundaries during --resume.
 *
 * Source fix constraint: terminal -> resume is not a modeled FSM transition
 * yet, and legacy step fields still act as the secondary durable source for
 * resume. Remove this bridge once terminal-session recovery is represented by
 * explicit FSM recovery results or step fields stop being used to derive resume
 * state.
 */
export function repairResumeMachineSnapshot(
  session: Session,
  stateEnteredAt = new Date().toISOString(),
): Session {
  if (!shouldRepairTerminalMachineSnapshot(session)) return session;
  const state = resumeMachineState(session);
  session.machine = {
    version: MACHINE_SNAPSHOT_VERSION,
    state,
    stateEnteredAt,
    revision: session.machine.revision + 1,
  };
  return session;
}
