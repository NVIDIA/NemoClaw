// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { StepMutationOptions } from "../../state/onboard-session";
import { OnboardRuntimeBoundary, type OnboardRuntimeBoundaryOptions } from "../runtime-boundary";
import {
  runOnboardMachine,
  type OnboardMachineRunnerOptions,
  type OnboardMachineRunnerResult,
} from "./runner";

export type RecordOnlyOnboardRuntimeBoundaryOptions = Omit<
  OnboardRuntimeBoundaryOptions,
  "stepMutationOptions"
> & {
  stepMutationOptions?: Omit<StepMutationOptions, "updateMachine">;
};

export interface RecordOnlyOnboardMachineRunnerOptions<Context>
  extends Omit<OnboardMachineRunnerOptions<Context>, "runtime"> {
  boundary: OnboardRuntimeBoundary;
  resumed?: boolean;
  emitLifecycleEvent?: boolean;
}

export function createRecordOnlyOnboardRuntimeBoundary(
  options: RecordOnlyOnboardRuntimeBoundaryOptions,
): OnboardRuntimeBoundary {
  return new OnboardRuntimeBoundary({
    ...options,
    stepMutationOptions: { ...options.stepMutationOptions, updateMachine: false },
  });
}

/**
 * Run the FSM with step recorders configured for status-only mutations.
 *
 * This is the adapter path for the post-legacy architecture: handlers may keep
 * using step boundary helpers for resumability, but those helpers do not move
 * `session.machine`; the runner applies every machine transition explicitly via
 * `OnboardRuntime.applyResult()`.
 */
export async function runOnboardMachineWithRecordOnlySteps<Context>({
  boundary,
  resumed = false,
  emitLifecycleEvent = true,
  ...options
}: RecordOnlyOnboardMachineRunnerOptions<Context>): Promise<OnboardMachineRunnerResult<Context>> {
  if (emitLifecycleEvent) await boundary.recordOnboardStarted(resumed);
  return runOnboardMachine({
    ...options,
    runtime: boundary.getRuntime(),
  });
}
