// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  inspectMcpProvider,
  type McpProviderInspection,
  type McpProviderInspectionRuntimeSelection,
  providerMatchesManagedCredential,
  providerShapeDetail,
} from "./mcp-bridge-provider";
import { assertAuthenticatedBridgeEntry, validateSandboxName } from "./mcp-bridge-validation";

export interface McpDestroyPreparation {
  entries: McpSourceEntry[];
  runtimeSelection?: McpProviderInspectionRuntimeSelection;
}

export function cloneMcpSourceEntry(entry: McpSourceEntry): McpSourceEntry {
  return {
    ...entry,
    env: [...entry.env],
    ...(entry.denyTools ? { denyTools: [...entry.denyTools] } : {}),
    ...(entry.allowedIps ? { allowedIps: [...entry.allowedIps] } : {}),
  };
}

/** Read-only exact-provider qualification retained for rebuild handoff checks. */
export function inspectExactMcpDestroyProvider(
  entry: McpSourceEntry,
  options: {
    allowMissing: boolean;
    force?: boolean;
    runtimeSelection: McpProviderInspectionRuntimeSelection;
  },
): McpProviderInspection {
  assertAuthenticatedBridgeEntry(entry);
  const inspection = inspectMcpProvider(entry.providerName, options.runtimeSelection);
  if (inspection.exists === null) {
    throw new McpBridgeError(
      inspection.error ?? `Could not inspect OpenShell provider '${entry.providerName}'.`,
    );
  }
  if (!inspection.exists) {
    if (options.allowMissing) return inspection;
    throw new McpBridgeError(`OpenShell provider '${entry.providerName}' is missing.`);
  }
  if (
    !entry.providerId ||
    !providerMatchesManagedCredential(inspection, entry.env[0], entry.providerId, {
      allowLegacyGeneric: true,
    })
  ) {
    throw new McpBridgeError(
      `OpenShell provider '${entry.providerName}' is not the current exact provider for MCP server '${entry.server}'. ${providerShapeDetail(inspection, entry.env[0], entry.providerId)} It will be preserved.`,
    );
  }
  return inspection;
}

export async function prepareMcpBridgesForAbsentSandboxDestroy(
  sandboxName: string,
  options: {
    force?: boolean;
    runtimeSelection?: McpProviderInspectionRuntimeSelection;
  } = {},
): Promise<McpDestroyPreparation> {
  validateSandboxName(sandboxName);
  return {
    entries: [],
    runtimeSelection: options.runtimeSelection,
  };
}
