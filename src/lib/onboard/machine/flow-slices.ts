// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { formatPhaseTimingsSummary, resetPhaseTimings } from "../phase-timings";
import type { OnboardFlowContext } from "./flow-context";
import { onboardFlowPhaseResult } from "./flow-context";
import { advanceTo } from "./result";
import type { OnboardMachineRunnerRuntime } from "./runner";
import type { OnboardSequencePhase } from "./sequence-runner";
import { runOnboardSequenceWithRunner } from "./sequence-runner";

export function initialOnboardFlowPhases<Context extends OnboardFlowContext>(
  phases: readonly OnboardSequencePhase<Context>[],
): OnboardSequencePhase<Context>[] {
  return [
    {
      state: "init",
      run: (context) => onboardFlowPhaseResult(context, advanceTo("preflight")),
    },
    ...phases.filter((phase) => phase.state === "preflight" || phase.state === "gateway"),
  ];
}

export function coreOnboardFlowPhases<Context extends OnboardFlowContext>(
  phases: readonly OnboardSequencePhase<Context>[],
): OnboardSequencePhase<Context>[] {
  return phases.filter(
    (phase) => phase.state === "provider_selection" || phase.state === "sandbox",
  );
}

export function finalOnboardFlowPhases<Context extends OnboardFlowContext>(
  phases: readonly OnboardSequencePhase<Context>[],
): OnboardSequencePhase<Context>[] {
  return phases.filter((phase) =>
    ["openclaw", "agent_setup", "policies", "finalizing", "post_verify"].includes(phase.state),
  );
}

export async function runInitialOnboardFlowSequence<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
}) {
  // Clear any per-phase timings left over from an earlier onboard run in the
  // same process (e.g. a prior run that failed before finalization reset the
  // registry) so this run's timing summary only reflects this run (#6002).
  resetPhaseTimings();
  return runOnboardSequenceWithRunner({
    ...options,
    phases: initialOnboardFlowPhases(options.phases),
    stopStates: ["provider_selection"],
  });
}

export async function runCoreOnboardFlowSequence<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
}) {
  return runOnboardSequenceWithRunner({
    ...options,
    phases: coreOnboardFlowPhases(options.phases),
    stopStates: ["openclaw", "agent_setup"],
  });
}

export async function runFinalOnboardFlowSequence<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
  emitSummary?: (summary: string) => void;
}) {
  const { emitSummary = (line: string) => console.log(line), ...runnerOptions } = options;
  const result = await runOnboardSequenceWithRunner({
    ...runnerOptions,
    phases: finalOnboardFlowPhases(options.phases),
  });
  // Emit the accumulated per-phase timing summary from the terminal seam —
  // after every wrapped phase in the final slice (finalization, and any
  // post_verify) has recorded — then clear the registry. This is the true
  // "all phases complete" boundary, so the summary can't miss the last phase
  // or leave a stray entry behind, regardless of which phase runs last (#6002).
  const summary = formatPhaseTimingsSummary();
  if (summary) {
    emitSummary(summary);
    resetPhaseTimings();
  }
  return result;
}
