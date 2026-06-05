// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../state/onboard-session";
import type { StepMutationOptions } from "../../state/onboard-step-mutation";
import { OnboardRuntimeBoundary, type OnboardRuntimeBoundaryOptions } from "../runtime-boundary";
import {
  type OnboardMachineRunnerOptions,
  type OnboardMachineRunnerResult,
  runOnboardMachine,
} from "./runner";

export type RecordOnlyOnboardRuntimeBoundaryOptions = Omit<
  OnboardRuntimeBoundaryOptions,
  "stepMutationOptions"
> & {
  stepMutationOptions?: Omit<StepMutationOptions, "updateMachine">;
};

export type RecordOnlyStepRecorders = Pick<
  ReturnType<OnboardRuntimeBoundary["recorders"]>,
  "startRecordedStep" | "recordStepComplete" | "recordStepSkipped" | "recordStepFailed"
>;

export interface RecordOnlyOnboardRuntimeBoundary {
  getRuntime: OnboardRuntimeBoundary["getRuntime"];
  recordOnboardStarted(resumed: boolean): Promise<Session>;
  recorders(): RecordOnlyStepRecorders;
}

export interface RecordOnlyOnboardMachineRunnerOptions<Context>
  extends Omit<OnboardMachineRunnerOptions<Context>, "runtime"> {
  boundary: RecordOnlyOnboardRuntimeBoundary;
  resumed?: boolean;
  emitLifecycleEvent?: boolean;
}

export function createRecordOnlyOnboardRuntimeBoundary(
  options: RecordOnlyOnboardRuntimeBoundaryOptions,
): RecordOnlyOnboardRuntimeBoundary {
  const boundary = new OnboardRuntimeBoundary({
    ...options,
    stepMutationOptions: { ...options.stepMutationOptions, updateMachine: false },
  });
  return {
    getRuntime: boundary.getRuntime.bind(boundary),
    recordOnboardStarted: boundary.recordOnboardStarted.bind(boundary),
    recorders: () => {
      const recorders = boundary.recorders();
      return {
        startRecordedStep: recorders.startRecordedStep,
        recordStepComplete: recorders.recordStepComplete,
        recordStepSkipped: recorders.recordStepSkipped,
        recordStepFailed: recorders.recordStepFailed,
      };
    },
  };
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
