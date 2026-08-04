// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createPhaseProgressReporter } from "./phase-progress";
import type { OnboardStateResult } from "./result";
import type { OnboardMachineRunnerRuntime, OnboardStateHandlerResult } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";
import { assertValidOnboardMachineTransition, isOnboardMachineState } from "./transitions";
import type { OnboardMachineEventType, OnboardMachineState } from "./types";

type RepairEventType = Extract<
  OnboardMachineEventType,
  "state.repair.started" | "state.repair.completed" | "state.repair.failed"
>;

export type OnboardPrerequisiteRepairEventRecorder = (
  type: RepairEventType,
  options: {
    state?: OnboardMachineState | null;
    error?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) => Promise<unknown>;

export interface OnboardPrerequisiteRepairResult<Context> {
  readonly context: Context;
  readonly results: readonly OnboardStateResult[];
  readonly finalState: OnboardMachineState;
}

function resultArray(
  result: OnboardStateHandlerResult,
  state: OnboardSequencePhase<unknown>["state"],
): readonly OnboardStateResult[] {
  const results = Array.isArray(result)
    ? (result as readonly OnboardStateResult[])
    : [result as OnboardStateResult];
  if (results.length === 0) {
    throw new Error(`Onboarding prerequisite repair for '${state}' returned no results`);
  }
  return results;
}

function validateRepairResults(
  results: readonly OnboardStateResult[],
  phaseState: OnboardSequencePhase<unknown>["state"],
  expectedFinalStates: readonly OnboardMachineState[],
): OnboardMachineState {
  let state: OnboardMachineState = phaseState;
  for (const result of results) {
    const source = result.metadata?.state;
    if (
      result.type !== "transition" ||
      result.updates !== undefined ||
      !isOnboardMachineState(source) ||
      source !== state
    ) {
      throw new Error(
        `Invalid onboarding prerequisite repair result for '${phaseState}'; expected an update-free transition from '${state}'`,
      );
    }
    const transition = assertValidOnboardMachineTransition(state, result.next);
    if (result.transitionKind !== transition.kind) {
      throw new Error(
        `Invalid onboarding prerequisite repair result for '${phaseState}'; expected transition kind '${transition.kind}' from '${state}' to '${result.next}'`,
      );
    }
    state = result.next;
  }
  if (!expectedFinalStates.includes(state)) {
    throw new Error(
      `Invalid onboarding prerequisite repair result for '${phaseState}'; expected final state ${expectedFinalStates.join(" or ")}, got '${state}'`,
    );
  }
  return state;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runOnboardPrerequisiteRepair<Context>(options: {
  context: Context;
  durableEntryState: OnboardMachineState;
  phase: OnboardSequencePhase<Context>;
  expectedFinalStates: readonly OnboardMachineState[];
  repair: string;
  runtime: OnboardMachineRunnerRuntime;
  recordRepairEvent: OnboardPrerequisiteRepairEventRecorder;
}): Promise<OnboardPrerequisiteRepairResult<Context>> {
  const metadata = {
    repair: options.repair,
    entryState: options.durableEntryState,
  };
  const phase = createPhaseProgressReporter().wrap(options.phase);
  try {
    await options.recordRepairEvent("state.repair.started", {
      state: phase.state,
      metadata,
    });
    const phaseResult = await phase.run(options.context);
    const results = resultArray(phaseResult.result, phase.state);
    const finalState = validateRepairResults(results, phase.state, options.expectedFinalStates);
    const current = await options.runtime.session();
    if (current.machine.state !== options.durableEntryState) {
      throw new Error(
        `Onboarding prerequisite repair for '${phase.state}' changed durable entry state from '${options.durableEntryState}' to '${current.machine.state}'`,
      );
    }
    await options.recordRepairEvent("state.repair.completed", {
      state: phase.state,
      metadata,
    });
    return { context: phaseResult.context, results, finalState };
  } catch (error) {
    await options
      .recordRepairEvent("state.repair.failed", {
        state: phase.state,
        error: errorMessage(error),
        metadata,
      })
      .catch(() => undefined);
    throw error;
  }
}
