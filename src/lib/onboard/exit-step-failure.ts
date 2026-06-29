// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";
import {
  LEGACY_MACHINE_STEP_MUTATION_OPTIONS,
  type StepMutationOptions,
} from "../state/onboard-step-mutation";
import { printOnboardResumeHint } from "./resume-hint";

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
  // Repairs the invalid state where onboard/rebuild exits nonzero after a step
  // starts but before normal completion handlers can run. Keep the explicit
  // legacy machine mutation until those process-exit paths have a single
  // terminal lifecycle owner; covered by exit-step-failure, rebuild-flow, and
  // onboard-exit-handler tests.
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
    // A non-null return means a step was in progress, so the session records a
    // resumable point — surface `--resume` for the many exit paths that don't
    // print their own recovery guidance (#6003). When an explicit cancel has
    // already cleared the session (or no step started), this is null and stays
    // silent; printOnboardResumeHint also self-dedupes against tailored hints.
    if (markLastStartedStepFailed(deps, message)) printOnboardResumeHint();
  });
}
