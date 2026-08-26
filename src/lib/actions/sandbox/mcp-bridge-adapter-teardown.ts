// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import { registerAgentAdapter, unregisterAgentAdapter } from "./mcp-bridge-adapters";
import { isAgentMcpAdapter, McpBridgeError } from "./mcp-bridge-contracts";
import {
  observeMcpCredentialRevision,
  type McpAttachedCredentialRevision,
} from "./mcp-bridge-provider-readiness";
import { getBridgeAdapter, getSandboxAgent } from "./mcp-bridge-state";

export type McpScrubbedAdapterEntry = McpBridgeEntry & {
  credentialRevision?: McpAttachedCredentialRevision;
};

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
): McpScrubbedAdapterEntry {
  const observation = observeMcpCredentialRevision(sandboxName, entry);
  if (observation === "absent" || observation === "canonical") {
    throw new McpBridgeError(
      `Could not prove a revision-scoped credential before removing the managed adapter entry for MCP server '${entry.server}'.`,
    );
  }
  const credentialRevision: McpAttachedCredentialRevision = observation;
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
  return { ...entry, credentialRevision };
}

/** Restore scrubbed adapter entries without hiding failures from provider rollback. */
export function rollbackScrubbedMcpAdapters(
  sandboxName: string,
  sandbox: SandboxEntry,
  entries: readonly McpScrubbedAdapterEntry[],
): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    let credentialRevision = entry.credentialRevision;
    try {
      const current = observeMcpCredentialRevision(sandboxName, entry);
      if (current !== "absent" && current !== "canonical") credentialRevision = current;
      if (current === "canonical") credentialRevision = undefined;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (!credentialRevision) {
      failures.push(
        `Could not restore the managed adapter entry for MCP server '${entry.server}' without its observed credential revision.`,
      );
      continue;
    }
    try {
      registerAgentAdapter(
        sandboxName,
        resolveManagedMcpAdapter(sandbox, entry),
        entry,
        {},
        {
          replaceExisting: true,
          teardownRollback: true,
          credentialRevision,
        },
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}
