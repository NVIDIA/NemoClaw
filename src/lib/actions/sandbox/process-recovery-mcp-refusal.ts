// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type McpReconciliationRefusalRecoveryResult = {
  checked: true;
  wasRunning: boolean;
  recovered: false;
  forwardRecovered: false;
  forwardRecoveryFailed?: undefined;
  forwardRecoveryFailureDetail?: undefined;
  mcpReconciliationRefused: true;
  mcpReconciliationReason: string;
};

export function mcpReconciliationRefusalResult(
  wasRunning: boolean,
  reason: string,
): McpReconciliationRefusalRecoveryResult {
  return {
    checked: true,
    wasRunning,
    recovered: false,
    forwardRecovered: false,
    mcpReconciliationRefused: true,
    mcpReconciliationReason: reason,
  };
}
