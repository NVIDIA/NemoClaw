// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ExitStepFailureSessionDeps,
  OnboardExitFailureProcessLike,
} from "./exit-step-failure";
import { registerIncompleteOnboardExitFailureHandler } from "./exit-step-failure";

const INCOMPLETE_ONBOARD_EXIT_MESSAGE = "Onboarding exited before the step completed.";

export function registerIncompleteOnboardExitHandlerForSession(
  deps: ExitStepFailureSessionDeps,
  isComplete: () => boolean,
  processLike?: OnboardExitFailureProcessLike,
): void {
  registerIncompleteOnboardExitFailureHandler(
    deps,
    isComplete,
    INCOMPLETE_ONBOARD_EXIT_MESSAGE,
    processLike,
  );
}
