// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardMachineRunnerOptions, OnboardStateHandlerResult } from "./runner";
import {
  runOnboardMachine,
  type OnboardMachineRunnerRuntime,
  type OnboardStateHandlers,
} from "./runner";
import type { OnboardNonTerminalMachineState } from "./types";

export interface OnboardSequencePhaseResult<Context> {
  context: Context;
  result: OnboardStateHandlerResult;
}

export interface OnboardSequencePhase<Context> {
  state: OnboardNonTerminalMachineState;
  run(
    context: Context,
  ): Promise<OnboardSequencePhaseResult<Context>> | OnboardSequencePhaseResult<Context>;
}

export interface OnboardSequenceRunnerOptions<Context> {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  maxTransitions?: OnboardMachineRunnerOptions<Context>["maxTransitions"];
  sequenceOwnership?: OnboardMachineRunnerOptions<Context>["sequenceOwnership"];
  stopStates?: OnboardMachineRunnerOptions<Context>["stopStates"];
}

export class DuplicateOnboardSequencePhaseError extends Error {
  readonly state: OnboardNonTerminalMachineState;

  constructor(state: OnboardNonTerminalMachineState) {
    super(`Duplicate onboarding sequence phase for state: ${state}`);
    this.name = "DuplicateOnboardSequencePhaseError";
    this.state = state;
  }
}

export function buildOnboardSequenceHandlers<Context>(
  phases: readonly OnboardSequencePhase<Context>[],
  setPendingContext: (context: Context) => void,
): OnboardStateHandlers<Context> {
  const handlers: OnboardStateHandlers<Context> = {};
  for (const phase of phases) {
    if (handlers[phase.state]) throw new DuplicateOnboardSequencePhaseError(phase.state);
    handlers[phase.state] = async (context) => {
      const phaseResult = await phase.run(context);
      setPendingContext(phaseResult.context);
      return phaseResult.result;
    };
  }
  return handlers;
}

/**
 * Adapter for migrating the existing manual onboard sequence onto the strict
 * FSM runner.
 *
 * Each phase can keep constructing its rich next context while returning one or
 * more explicit FSM results. The generic runner remains responsible for
 * applying those results and validating transitions.
 */
export async function runOnboardSequenceWithRunner<Context>({
  context: initialContext,
  runtime,
  phases,
  maxTransitions,
  sequenceOwnership,
  stopStates,
}: OnboardSequenceRunnerOptions<Context>) {
  let pendingContext = initialContext;
  return runOnboardMachine({
    context: initialContext,
    runtime,
    maxTransitions,
    sequenceOwnership,
    stopStates,
    handlers: buildOnboardSequenceHandlers(phases, (context) => {
      pendingContext = context;
    }),
    updateContext: () => pendingContext,
  });
}
