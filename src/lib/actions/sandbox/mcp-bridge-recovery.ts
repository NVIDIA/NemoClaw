// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type HermesMcpReconciliationResult,
  inspectHermesMcpRuntimeIntent,
  sanitizeHermesMcpReconciliationDetail,
} from "./mcp-bridge-hermes-reconciliation";

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

type InspectHermesMcpRuntimeIntent = (sandboxName: string) => HermesMcpReconciliationResult;

export function inspectHermesMcpReconciliationRefusal(
  sandboxName: string,
  inspect: InspectHermesMcpRuntimeIntent = inspectHermesMcpRuntimeIntent,
): { detail: string } | null {
  const reconciliation = inspect(sandboxName);
  if (reconciliation.ok) return null;
  return { detail: sanitizeHermesMcpReconciliationDetail(reconciliation.detail) };
}

export function processRecoveryMcpReconciliationRefusal(
  sandboxName: string,
  wasRunning: boolean,
  inspect: InspectHermesMcpRuntimeIntent = inspectHermesMcpRuntimeIntent,
): McpReconciliationRefusalRecoveryResult | null {
  const refusal = inspectHermesMcpReconciliationRefusal(sandboxName, inspect);
  if (!refusal) return null;
  return {
    checked: true,
    wasRunning,
    recovered: false,
    forwardRecovered: false,
    mcpReconciliationRefused: true,
    mcpReconciliationReason: refusal.detail,
  };
}
