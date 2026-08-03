// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface StepMutationOptions {
  /**
   * Transitional FSM migration escape hatch for paths where legacy step helpers
   * still move session.machine. Runtime-owned onboarding should use record-only
   * step writes paired with explicit OnboardStateResult transitions so the
   * runtime remains the durable machine source of truth. Remove this option once
   * direct step helpers no longer own machine transitions.
   */
  updateMachine?: boolean;
}

export const LEGACY_MACHINE_STEP_MUTATION_OPTIONS: Readonly<StepMutationOptions> = Object.freeze({
  updateMachine: true,
});

export const RECORD_ONLY_STEP_MUTATION_OPTIONS: Readonly<StepMutationOptions> = Object.freeze({
  updateMachine: false,
});

export function shouldUpdateMachine(options: StepMutationOptions | undefined): boolean {
  return options?.updateMachine !== false;
}
