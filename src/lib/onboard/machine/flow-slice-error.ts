// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OnboardMachineState } from "./types";

export class UnexpectedOnboardFlowSliceStateError extends Error {
  constructor(
    readonly state: OnboardMachineState,
    readonly runStates: readonly OnboardMachineState[],
    readonly repairStates: readonly OnboardMachineState[],
  ) {
    super(`Unexpected onboarding flow state before slice entry: ${state}`);
    this.name = "UnexpectedOnboardFlowSliceStateError";
  }
}
