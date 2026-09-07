// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type HermesMcpReconciliationResult,
  inspectHermesMcpRuntimeIntent,
  sanitizeHermesMcpReconciliationDetail,
} from "./mcp-bridge-hermes-reconciliation";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";

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
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): { detail: string } | null {
  const reconciliation =
    inspect === inspectHermesMcpRuntimeIntent
      ? inspectHermesMcpRuntimeIntent(sandboxName, { runtimeSelection })
      : inspect(sandboxName);
  if (reconciliation.ok) return null;
  return { detail: sanitizeHermesMcpReconciliationDetail(reconciliation.detail) };
}

export function processRecoveryMcpReconciliationRefusal(
  sandboxName: string,
  wasRunning: boolean,
  inspect: InspectHermesMcpRuntimeIntent = inspectHermesMcpRuntimeIntent,
  runtimeSelection?: McpProviderInspectionRuntimeSelection,
): McpReconciliationRefusalRecoveryResult | null {
  const refusal = inspectHermesMcpReconciliationRefusal(sandboxName, inspect, runtimeSelection);
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
