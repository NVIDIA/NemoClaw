// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardStateResult } from "./result";
import type { OnboardMachineRunnerRuntime, OnboardStateHandlerResult } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";
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
  }): Promise<{ context: Context; session: unknown }>;
  applyCompatibleResult(result: OnboardStateResult): Promise<unknown>;
}

function asResultArray(result: OnboardStateHandlerResult): readonly OnboardStateResult[] {
  return Array.isArray(result) ? (result as readonly OnboardStateResult[]) : [result as OnboardStateResult];
}

/**
 * Run a live onboard flow slice through the strict runner when the current
 * machine state is exactly at the slice entry point. Resume/ahead-state flows
 * use the compatibility path so repair/backstop phase bodies still execute even
 * when a saved session has already advanced beyond the slice.
 */
export async function runLiveOnboardFlowSlice<Context>({
  context,
  runtime,
  phases,
  resume,
  runWhenState,
  runSlice,
  applyCompatibleResult,
}: LiveOnboardFlowSliceOptions<Context>): Promise<{ context: Context; session: unknown }> {
  const current = await runtime.session();
  if (!resume && runWhenState.includes(current.machine.state)) {
    return runSlice({ context, runtime, phases });
  }

  let nextContext = context;
  for (const phase of phases) {
    const phaseResult = await phase.run(nextContext);
    for (const result of asResultArray(phaseResult.result)) {
      await applyCompatibleResult(result);
    }
    nextContext = phaseResult.context;
  }
  return { context: nextContext, session: await runtime.session() };
}
