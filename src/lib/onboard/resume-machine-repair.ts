// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";
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
  if (startedState && (startedStep?.status === "failed" || startedStep?.status === "in_progress")) {
    return startedState;
  }

  return null;
}

/**
 * Computes the nonterminal state where a failed durable session should resume.
 *
 * This derives the resume entry from the legacy step-level source of truth and
 * is one of the building blocks for the single recovery pass in
 * `session-recovery.ts` (`planSessionRecovery` / `applySessionRecovery`), which
 * classifies, validates, and applies the recovery. Remove this bridge once step
 * fields stop being used to derive resume state (#6227).
 */
export function resumeMachineState(session: Session): OnboardMachineState {
  return (
    activeStepMachineState(session) ??
    nextMachineStateAfterCompletedStep(session.lastCompletedStep, session) ??
    "init"
  );
}
