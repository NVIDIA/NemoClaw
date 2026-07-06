// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import { registerAgentAdapter, unregisterAgentAdapter } from "./mcp-bridge-adapters";
import { isAgentMcpAdapter, McpBridgeError } from "./mcp-bridge-contracts";
import { getBridgeAdapter, getSandboxAgent } from "./mcp-bridge-state";

/** Resolve the exact persisted adapter, falling back only for legacy entries. */
export function resolveManagedMcpAdapter(
  sandbox: SandboxEntry,
  entry: McpBridgeEntry,
): AgentMcpAdapter {
  return isAgentMcpAdapter(entry.adapter)
    ? entry.adapter
    : getBridgeAdapter(getSandboxAgent(sandbox));
}

/** Scrub one registry-owned adapter entry, failing closed when ownership is unproved. */
export function scrubManagedMcpAdapterOrThrow(
  sandboxName: string,
  sandbox: SandboxEntry,
  entry: McpBridgeEntry,
): void {
  const adapter = resolveManagedMcpAdapter(sandbox, entry);
  const removal = unregisterAgentAdapter(sandboxName, adapter, entry, {
    envValues: {},
    teardown: true,
  });
  if (removal === "unowned") {
    throw new McpBridgeError(
      `Could not prove removal of the exact managed adapter entry for MCP server '${entry.server}'.`,
    );
  }
}

/** Restore scrubbed adapter entries without hiding failures from provider rollback. */
export function rollbackScrubbedMcpAdapters(
  sandboxName: string,
  sandbox: SandboxEntry,
  entries: readonly McpBridgeEntry[],
): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      registerAgentAdapter(
        sandboxName,
        resolveManagedMcpAdapter(sandbox, entry),
        entry,
        {},
        {
          replaceExisting: true,
          teardownRollback: true,
        },
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}
