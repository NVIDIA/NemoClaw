// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as onboardSession from "../state/onboard-session";
import { LEGACY_MACHINE_STEP_MUTATION_OPTIONS } from "../state/onboard-step-mutation";

export function markLastStartedStepFailed(session: typeof onboardSession, message: string): void {
  const failedStep = session.loadSession()?.lastStepStarted;
  if (!failedStep) return;
  session.markStepFailed(failedStep, message, LEGACY_MACHINE_STEP_MUTATION_OPTIONS);
}
