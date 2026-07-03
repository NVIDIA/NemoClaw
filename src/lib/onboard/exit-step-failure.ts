// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";

export interface ExitStepFailureSessionDeps {
  loadSession(): Pick<Session, "lastStepStarted"> | null;
  finalizeIncompleteOnboardStep(stepName: string, message?: string | null): Session | null;
}

export interface OnboardExitFailureProcessLike {
  once(event: "exit", listener: (code: number) => void): unknown;
}

export function markLastStartedStepFailed(
  deps: ExitStepFailureSessionDeps,
  message: string,
): Session | null {
  // Repairs the invalid state where onboard/rebuild exits nonzero after a step
  // starts but before normal completion handlers can run. Routes through the
  // single terminal-failure owner (finalizeIncompleteOnboardStep), which
  // validates the failed transition and is idempotent against an already
  // terminal machine, rather than the legacy step-mutation escape hatch.
  // Covered by exit-step-failure, rebuild-flow, and onboard-exit-handler tests.
  const failedStep = deps.loadSession()?.lastStepStarted;
  if (!failedStep) return null;
  return deps.finalizeIncompleteOnboardStep(failedStep, message);
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
