// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface StepMutationOptions {
  /**
   * Transitional FSM migration escape hatch for fresh-flow slices where the
   * runtime applies explicit OnboardStateResult transitions immediately after
   * legacy step helpers record status. Production record-only writes should be
   * paired with an explicit runtime result through OnboardRuntimeBoundary-owned
   * adapters so the runtime remains the durable machine source of truth. Remove
   * this option once all live phase bodies return explicit FSM results without
   * relying on step helper machine mutation.
   */
  updateMachine?: boolean;
}

export function shouldUpdateMachine(options: StepMutationOptions | undefined): boolean {
  return options?.updateMachine !== false;
}
