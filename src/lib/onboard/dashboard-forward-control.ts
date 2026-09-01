// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface DashboardForwardOptions {
  rollbackSandboxOnFailure?: boolean;
  gatewayName?: string;
  /** Exact live sandbox identity used to own a direct ForwardTcp process. */
  sandboxIdentityFingerprint?: string;
  preserveSandboxPorts?: Array<number | string>;
  allowPortReallocation?: boolean;
  revalidateSandboxIdentity?: (operation: string) => void;
  onForwardStarted?: (port: number) => void;
}

export function normalizeDashboardForwardOptions(options: DashboardForwardOptions = {}): {
  rollbackSandboxOnFailure: boolean;
  allowPortReallocation: boolean;
} {
  return {
    rollbackSandboxOnFailure: options.rollbackSandboxOnFailure === true,
    allowPortReallocation: options.allowPortReallocation !== false,
  };
}
