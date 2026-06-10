// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardStateResult } from "./result";
import type {
  OnboardMachineRunnerResult,
  OnboardMachineRunnerRuntime,
  OnboardStateHandlerResult,
} from "./runner";
import { DuplicateOnboardSequencePhaseError, type OnboardSequencePhase } from "./sequence-runner";
import type { OnboardMachineState } from "./types";

export interface LiveOnboardFlowSliceOptions<Context> {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  resume: boolean;
  runWhenState: readonly OnboardMachineState[];
  runSlice(options: {
    context: Context;
    runtime: OnboardMachineRunnerRuntime;
    phases: readonly OnboardSequencePhase<Context>[];
  }): Promise<OnboardMachineRunnerResult<Context>>;
  applyCompatibleResult(result: OnboardStateResult): Promise<unknown>;
}

export class EmptyLiveOnboardFlowSliceResultError extends Error {
  constructor(readonly state: OnboardSequencePhase<unknown>["state"]) {
    super(`Onboarding live flow phase '${state}' returned no results`);
    this.name = "EmptyLiveOnboardFlowSliceResultError";
  }
}

function assertUniquePhases<Context>(phases: readonly OnboardSequencePhase<Context>[]): void {
  const states = new Set<OnboardSequencePhase<Context>["state"]>();
  for (const phase of phases) {
    if (states.has(phase.state)) throw new DuplicateOnboardSequencePhaseError(phase.state);
    states.add(phase.state);
  }
}

function asResultArray(
  result: OnboardStateHandlerResult,
  state: OnboardSequencePhase<unknown>["state"],
): readonly OnboardStateResult[] {
  const results = Array.isArray(result)
    ? (result as readonly OnboardStateResult[])
    : [result as OnboardStateResult];
  if (results.length === 0) throw new EmptyLiveOnboardFlowSliceResultError(state);
  return results;
}

/**
 * Run a live onboard flow slice through the strict runner when the current
 * machine state is exactly at the slice entry point. Resume/ahead-state flows
 * use the compatibility path so repair/backstop phase bodies still execute even
 * when a saved session has already advanced beyond the slice. Callers supply
 * the compatibility recorder so each live slice keeps using the runtime
 * boundary that validates or intentionally skips stale legacy step results.
 */
export async function runLiveOnboardFlowSlice<Context>({
  context,
  runtime,
  phases,
  resume,
  runWhenState,
  runSlice,
  applyCompatibleResult,
}: LiveOnboardFlowSliceOptions<Context>): Promise<OnboardMachineRunnerResult<Context>> {
  const current = await runtime.session();
  if (!resume && runWhenState.includes(current.machine.state)) {
    return runSlice({ context, runtime, phases });
  }

  assertUniquePhases(phases);
  let nextContext = context;
  for (const phase of phases) {
    const phaseResult = await phase.run(nextContext);
    for (const result of asResultArray(phaseResult.result, phase.state)) {
      await applyCompatibleResult(result);
    }
    nextContext = phaseResult.context;
  }
  return { context: nextContext, session: await runtime.session() };
}
