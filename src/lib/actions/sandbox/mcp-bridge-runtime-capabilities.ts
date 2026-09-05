// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import {
  assertAgentMcpMutationRuntimeCapability,
  assertAgentMcpTeardownRuntimeCapability,
} from "./mcp-bridge-adapters";
import { isAgentMcpAdapter } from "./mcp-bridge-contracts";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import { getBridgeAdapter, getSandboxAgent } from "./mcp-bridge-state";

function adaptersForEntries(
  sandbox: SandboxEntry,
  entries: readonly McpBridgeEntry[],
): Set<AgentMcpAdapter> {
  return new Set(
    entries.map((entry) =>
      isAgentMcpAdapter(entry.adapter) ? entry.adapter : getBridgeAdapter(getSandboxAgent(sandbox)),
    ),
  );
}

export function assertMcpAdapterMutationRuntimeCapabilities(
  sandboxName: string,
  sandbox: SandboxEntry,
  entries: readonly McpBridgeEntry[],
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  for (const adapter of adaptersForEntries(sandbox, entries)) {
    assertAgentMcpMutationRuntimeCapability(sandboxName, adapter, runtimeSelection);
  }
}

/**
 * Prove host-visible config mutability without requiring a capability marker
 * from the image being torn down. Deep Agents entries created by an older
 * NemoClaw release remain safe to scrub because their exact persisted adapter
 * definition is still ownership-checked by unregisterAgentAdapter.
 */
export function assertMcpAdapterTeardownRuntimeCapabilities(
  sandboxName: string,
  sandbox: SandboxEntry,
  entries: readonly McpBridgeEntry[],
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  for (const adapter of adaptersForEntries(sandbox, entries)) {
    assertAgentMcpTeardownRuntimeCapability(sandboxName, adapter, runtimeSelection);
  }
}
