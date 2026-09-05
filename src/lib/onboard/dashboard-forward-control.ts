// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface DashboardForwardOptions {
  rollbackSandboxOnFailure?: boolean;
  gatewayName?: string;
  allowPortReallocation?: boolean;
  /**
   * Preserve a bound port only when the caller has durable evidence that this
   * onboarding attempt reused the registered sandbox and will run deployment
   * verification before reporting success.
   */
  preserveRegisteredForward?: boolean;
  revalidateSandboxIdentity?: (operation: string) => void;
}

export function normalizeDashboardForwardOptions(options: DashboardForwardOptions = {}): {
  rollbackSandboxOnFailure: boolean;
  allowPortReallocation: boolean;
  preserveRegisteredForward: boolean;
} {
  return {
    rollbackSandboxOnFailure: options.rollbackSandboxOnFailure === true,
    allowPortReallocation: options.allowPortReallocation !== false,
    preserveRegisteredForward: options.preserveRegisteredForward === true,
  };
}
