// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface DashboardForwardOptions {
  rollbackSandboxOnFailure?: boolean;
  gatewayName?: string;
  allowPortReallocation?: boolean;
  reuseExistingOpenClawForward?: boolean;
  revalidateSandboxIdentity?: (operation: string) => void;
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
