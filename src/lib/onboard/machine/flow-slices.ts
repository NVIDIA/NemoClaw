// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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

export async function runInitialOnboardFlowSequence<Context extends OnboardFlowContext>(options: {
  context: Context;
  runtime: OnboardMachineRunnerRuntime;
  phases: readonly OnboardSequencePhase<Context>[];
}) {
  return runOnboardSequenceWithRunner({
    ...options,
    phases: initialOnboardFlowPhases(options.phases),
    stopStates: ["provider_selection"],
  });
}
