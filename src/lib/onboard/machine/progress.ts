// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ONBOARD_MACHINE_STATE_DEFINITIONS,
  type OnboardMachineStateWithProgressDefinition,
} from "./definition";

export interface OnboardProgressStep {
  number: number;
  total: number;
  title: string;
}

export type OnboardMachineProgressStepName = OnboardMachineStateWithProgressDefinition["stepName"];

export type OnboardProgressStepName = OnboardMachineProgressStepName | "messaging";

// Messaging is still emitted inside the sandbox flow rather than represented as
// a session/FSM state. Keep this legacy pseudo-step here only while the progress
// API preserves that visible label; remove it when messaging becomes a real
// FSM-backed onboarding step or the legacy pseudo-step lookup goes away.
const EXTRA_PROGRESS_STEPS = [
  {
    stepName: "messaging",
    progress: { number: 5, total: 8, title: "Messaging channels" },
  },
] as const;

export const ONBOARD_PROGRESS_STEPS = Object.fromEntries([
  ...ONBOARD_MACHINE_STATE_DEFINITIONS.flatMap((definition) =>
    "progress" in definition ? [[definition.stepName, definition.progress]] : [],
  ),
  ...EXTRA_PROGRESS_STEPS.map((definition) => [definition.stepName, definition.progress]),
]) as Readonly<Record<OnboardProgressStepName, OnboardProgressStep>>;

export function getOnboardProgressStep(stepName: string): OnboardProgressStep | null {
  return Object.prototype.hasOwnProperty.call(ONBOARD_PROGRESS_STEPS, stepName)
    ? ONBOARD_PROGRESS_STEPS[stepName as OnboardProgressStepName]
    : null;
}
