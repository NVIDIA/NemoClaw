// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxEntry } from "../../state/registry";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  inspectMcpProvider,
  type McpProviderInspection,
  type McpProviderInspectionRuntimeSelection,
  providerMatchesManagedCredential,
  providerShapeDetail,
} from "./mcp-bridge-provider";
import { bridgeState, getSandboxOrThrow } from "./mcp-bridge-state";
import { assertAuthenticatedBridgeEntry, validateSandboxName } from "./mcp-bridge-validation";

export interface McpDestroyPreparation {
  entries: McpSourceEntry[];
  runtimeSelection?: McpProviderInspectionRuntimeSelection;
}

export function cloneMcpSourceEntry(entry: McpSourceEntry): McpSourceEntry {
  return {
    ...entry,
    env: [...entry.env],
    ...(entry.allowedIps ? { allowedIps: [...entry.allowedIps] } : {}),
  };
}

function entriesEqual(left: McpSourceEntry, right: McpSourceEntry): boolean {
  return JSON.stringify(cloneMcpSourceEntry(left)) === JSON.stringify(cloneMcpSourceEntry(right));
}

/**
 * Incomplete-add classifications are derived from live sources. There is no
 * local manifest to discard; return the currently registered sandbox.
 */
export async function discardSafeIncompleteMcpAdds(
  sandboxName: string,
  _sandbox: SandboxEntry,
  _options: {
    runtimeSelection?: McpProviderInspectionRuntimeSelection;
    sandboxAbsent?: boolean;
  } = {},
): Promise<SandboxEntry> {
  return getSandboxOrThrow(sandboxName);
}

export function assertMcpDestroySnapshotCurrent(
  sandboxName: string,
  entries: readonly McpSourceEntry[],
): SandboxEntry {
  const sandbox = getSandboxOrThrow(sandboxName);
  const current = bridgeState(sandbox);
  if (
    Object.keys(current).length !== entries.length ||
    entries.some((entry) => !current[entry.server] || !entriesEqual(current[entry.server], entry))
  ) {
    throw new McpBridgeError(
      `MCP source state changed while sandbox '${sandboxName}' was being prepared for deletion. Rerun the command against the current sources.`,
    );
  }
  return sandbox;
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
