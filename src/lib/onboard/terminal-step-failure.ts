// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../state/onboard-session";
import {
  LEGACY_MACHINE_STEP_MUTATION_OPTIONS,
  type StepMutationOptions,
} from "../state/onboard-step-mutation";

export interface TerminalStepFailureSessionDeps {
  loadSession(): Pick<Session, "lastStepStarted"> | null;
  markStepFailed(stepName: string, message?: string | null, options?: StepMutationOptions): Session;
}

export function markLastStartedStepFailed(
  deps: TerminalStepFailureSessionDeps,
  message: string,
): Session | null {
  const failedStep = deps.loadSession()?.lastStepStarted;
  if (!failedStep) return null;
  return deps.markStepFailed(failedStep, message, LEGACY_MACHINE_STEP_MUTATION_OPTIONS);
}
