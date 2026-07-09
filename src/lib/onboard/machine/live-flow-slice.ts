// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createPhaseProgressReporter, type PhaseProgressReporter } from "./phase-progress";
import type { OnboardStateResult } from "./result";
import type {
  OnboardMachineRunnerResult,
  OnboardMachineRunnerRuntime,
  OnboardStateHandlerResult,
} from "./runner";
import { DuplicateOnboardSequencePhaseError, type OnboardSequencePhase } from "./sequence-runner";
import type { OnboardMachineState } from "./types";

export type InvalidatedOnboardStateResultRecorder = (
  result: OnboardStateResult,
  options: {
    reason: "already_at_target" | "source_state_mismatch";
    currentState: OnboardMachineState;
    sourceState?: string | null;
  },
) => Promise<unknown>;

export interface LiveOnboardFlowSliceOptions<Context> {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  runWhenState: readonly OnboardMachineState[];
  compatibilityWhenState?: readonly OnboardMachineState[];
  phaseProgress?: PhaseProgressReporter;
  runSlice(options: {
    context: Context;
    runtime: OnboardMachineRunnerRuntime;
    phases: readonly OnboardSequencePhase<Context>[];
  }): Promise<OnboardMachineRunnerResult<Context>>;
  recordStateResult(result: OnboardStateResult): Promise<unknown>;
  recordInvalidatedStateResult?: InvalidatedOnboardStateResultRecorder;
}

export class EmptyLiveOnboardFlowSliceResultError extends Error {
  constructor(readonly state: OnboardSequencePhase<unknown>["state"]) {
    super(`Onboarding live flow phase '${state}' returned no results`);
    this.name = "EmptyLiveOnboardFlowSliceResultError";
  }
}

export class UnexpectedLiveOnboardFlowSliceStateError extends Error {
  constructor(
    readonly state: OnboardMachineState,
    readonly runWhenState: readonly OnboardMachineState[],
    readonly compatibilityWhenState: readonly OnboardMachineState[],
  ) {
    super(`Unexpected onboarding live flow state before slice entry: ${state}`);
    this.name = "UnexpectedLiveOnboardFlowSliceStateError";
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

function resultSourceState(result: OnboardStateResult): string | null {
  const source = result.metadata?.state;
  return typeof source === "string" ? source : null;
}

function missingInvalidatedRecorder(): never {
  throw new Error("Missing onboarding state result invalidation recorder");
}

/**
 * Result of a single recomputed phase-result recording pass. Callers use
 * `applied` to decide whether the phase's recomputed context is safe to
 * propagate forward: any invalidated transition (already-at-target or
 * source-state mismatch) leaves the phase's context untrusted because the
 * phase computed it under an assumed transition that the durable machine
 * state rejects.
 */
type RecomputedResultOutcome = { applied: boolean };

async function recordRecomputedResult<Context>(
  options: Pick<
    LiveOnboardFlowSliceOptions<Context>,
    "runtime" | "recordStateResult" | "recordInvalidatedStateResult"
  > & { phaseState: OnboardSequencePhase<Context>["state"]; result: OnboardStateResult },
): Promise<RecomputedResultOutcome> {
  if (options.result.type !== "transition") {
    await options.recordStateResult(options.result);
    return { applied: true };
  }

  const current = await options.runtime.session();
  const sourceState = resultSourceState(options.result) ?? options.phaseState;
  if (current.machine.state === options.result.next) {
    await (options.recordInvalidatedStateResult ?? missingInvalidatedRecorder)(options.result, {
      reason: "already_at_target",
      currentState: current.machine.state,
      sourceState,
    });
    return { applied: false };
  }
  if (sourceState && current.machine.state !== sourceState) {
    // Covers both (a) explicit source metadata mismatching current and
    // (b) fallback phaseState mismatching current when a phase was
    // recomputed at an ahead-state through compatibilityWhenState. Together
    // with the boundary's assertValidOnboardMachineTransition on the apply
    // path, this rejects stale phase output before it can advance state.
    await (options.recordInvalidatedStateResult ?? missingInvalidatedRecorder)(options.result, {
      reason: "source_state_mismatch",
      currentState: current.machine.state,
      sourceState,
    });
    return { applied: false };
  }
  await options.recordStateResult(options.result);
  return { applied: true };
}

/**
 * Run a live onboard flow slice through the strict runner when the current
 * machine state is exactly at the slice entry point. Declared compatibility
 * states use the recompute path so repair/backstop phase bodies still execute
 * during resume or when a saved session has already advanced beyond the slice.
 * Recomputed results are applied only when they still match the durable machine
 * state; stale transition results are explicitly invalidated with source/target
 * diagnostics. Compatibility is limited to caller-declared states so earlier or
 * unexpected machine states fail before running slice side effects out of order.
 */
export async function runLiveOnboardFlowSlice<Context>({
  context,
  runtime,
  phases,
  runWhenState,
  compatibilityWhenState = [],
  phaseProgress = createPhaseProgressReporter(),
  runSlice,
  recordStateResult,
  recordInvalidatedStateResult,
}: LiveOnboardFlowSliceOptions<Context>): Promise<OnboardMachineRunnerResult<Context>> {
  const current = await runtime.session();
  if (
    runWhenState.includes(current.machine.state) &&
    !compatibilityWhenState.includes(current.machine.state)
  ) {
    return runSlice({ context, runtime, phases });
  }
  if (!compatibilityWhenState.includes(current.machine.state)) {
    throw new UnexpectedLiveOnboardFlowSliceStateError(
      current.machine.state,
      runWhenState,
      compatibilityWhenState,
    );
  }

  assertUniquePhases(phases);
  let nextContext = context;
  for (const rawPhase of phases) {
    const phase = phaseProgress.wrap(rawPhase);
    const phaseResult = await phase.run(nextContext);
    let phaseAllApplied = true;
    for (const result of asResultArray(phaseResult.result, phase.state)) {
      const outcome = await recordRecomputedResult({
        runtime,
        recordStateResult,
        recordInvalidatedStateResult,
        phaseState: phase.state,
        result,
      });
      if (!outcome.applied) phaseAllApplied = false;
    }
    // Only propagate the phase's recomputed context when every result was
    // applied. Otherwise the context was computed under an invalidated
    // transition and must not be forwarded to later phases, matching #6227's
    // "stale state results cannot be silently accepted" acceptance clause.
    if (phaseAllApplied) nextContext = phaseResult.context;
  }
  return { context: nextContext, session: await runtime.session() };
}
