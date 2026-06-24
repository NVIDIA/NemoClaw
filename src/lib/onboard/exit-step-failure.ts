// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";
import {
  LEGACY_MACHINE_STEP_MUTATION_OPTIONS,
  type StepMutationOptions,
} from "../state/onboard-step-mutation";

export interface ExitStepFailureSessionDeps {
  loadSession(): Pick<Session, "lastStepStarted"> | null;
  markStepFailed(stepName: string, message?: string | null, options?: StepMutationOptions): Session;
}

export interface OnboardExitFailureProcessLike {
  once(event: "exit", listener: (code: number) => void): unknown;
}

export function markLastStartedStepFailed(
  deps: ExitStepFailureSessionDeps,
  message: string,
): Session | null {
  const failedStep = deps.loadSession()?.lastStepStarted;
  if (!failedStep) return null;
  return deps.markStepFailed(failedStep, message, LEGACY_MACHINE_STEP_MUTATION_OPTIONS);
}

export function registerIncompleteOnboardExitFailureHandler(
  deps: ExitStepFailureSessionDeps,
  isComplete: () => boolean,
  message: string,
  processLike: OnboardExitFailureProcessLike = process,
): void {
  processLike.once("exit", (code) => {
    if (isComplete() || code === 0) return;
    markLastStartedStepFailed(deps, message);
  });
}
