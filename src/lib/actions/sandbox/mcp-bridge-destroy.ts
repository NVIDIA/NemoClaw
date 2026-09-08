// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import {
  cloneMcpSourceEntry,
  inspectExactMcpDestroyProvider,
  prepareMcpBridgesForAbsentSandboxDestroy,
  type McpDestroyPreparation,
} from "./mcp-bridge-destroy-preflight";
import { getMcpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider";
import { getSandboxOrThrow } from "./mcp-bridge-state";
import { inspectLegacyBridgeState, inspectSourceBridgeState } from "./mcp-bridge-source";
import { validateSandboxName } from "./mcp-bridge-validation";

export type { McpDestroyPreparation } from "./mcp-bridge-destroy-preflight";
export {
  cloneMcpSourceEntry,
  inspectExactMcpDestroyProvider,
  prepareMcpBridgesForAbsentSandboxDestroy,
};

/**
 * Capture the source-derived MCP inventory before sandbox deletion. OpenShell
 * owns sandbox policy and attachments, so deleting the sandbox removes those
 * resources atomically with it. Workspace providers are intentionally retained.
 */
export async function prepareMcpBridgesForDestroy(
  sandboxName: string,
  options: {
    force?: boolean;
    runtimeSelection?: McpDestroyPreparation["runtimeSelection"];
  } = {},
): Promise<McpDestroyPreparation> {
  validateSandboxName(sandboxName);
  const sandbox = getSandboxOrThrow(sandboxName);
  const runtimeSelection =
    options.runtimeSelection ?? getMcpProviderInspectionRuntimeSelection(sandbox);
  const observed = inspectSourceBridgeState(sandbox, runtimeSelection);
  const legacy =
    Object.keys(observed.sources.legacy).length > 0
      ? inspectLegacyBridgeState(sandbox, runtimeSelection).bridges
      : {};
  const entries = Object.values({ ...legacy, ...observed.bridges }).map(cloneMcpSourceEntry);
  return {
    entries,
    runtimeSelection,
  };
}

/** No MCP source was mutated before deletion, so an aborted delete needs no rollback. */
export async function restoreMcpBridgesAfterDestroyAbort(
  _sandboxName: string,
  _preparation: McpDestroyPreparation,
): Promise<void> {}

/**
 * Provider deletion is deliberately conservative. A source provider can
 * outlive a sandbox; retain it and report the exact names for operator cleanup.
 */
export async function finalizeMcpBridgesAfterSandboxDelete(
  sandboxName: string,
  preparation: McpDestroyPreparation,
  _options: { force?: boolean } = {},
): Promise<void> {
  const providers = [
    ...new Set(
      preparation.entries.flatMap((entry): string[] =>
        entry.providerName ? [entry.providerName] : [],
      ),
    ),
  ].sort();
  if (providers.length > 0) {
    console.warn(
      `  Preserved detached OpenShell MCP provider${providers.length === 1 ? "" : "s"} after deleting '${sandboxName}': ${providers.join(", ")}`,
    );
    console.warn("  Inspect and remove unused providers explicitly after confirming no sandbox uses them.");
  }
}
