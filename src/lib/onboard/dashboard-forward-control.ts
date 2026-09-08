// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface DashboardForwardOptions {
  rollbackSandboxOnFailure?: boolean;
  gatewayName?: string;
  allowPortReallocation?: boolean;
  reuseExistingOpenClawForward?: boolean;
  revalidateSandboxIdentity?: (operation: string) => void;
  /**
   * Called when the forward did not start and the sandbox is not rolled
   * back. The launcher still returns the allocated port in that case, so a
   * caller that recorded state for the forward needs this to undo it.
   */
  onForwardFailure?: (diagnostic: string) => void;
}

export function normalizeDashboardForwardOptions(options: DashboardForwardOptions = {}): {
  rollbackSandboxOnFailure: boolean;
  allowPortReallocation: boolean;
  reuseExistingOpenClawForward: boolean;
} {
  return {
    rollbackSandboxOnFailure: options.rollbackSandboxOnFailure === true,
    allowPortReallocation: options.allowPortReallocation !== false,
    reuseExistingOpenClawForward: options.reuseExistingOpenClawForward === true,
  };
}
