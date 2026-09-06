// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import {
  registerAgentAdapterAtCurrentCredentialRevision,
  unregisterAgentAdapter,
} from "./mcp-bridge-adapters";
import { isAgentMcpAdapter, McpBridgeError } from "./mcp-bridge-contracts";
import {
  observeMcpCredentialRevision,
  type McpAttachedCredentialRevision,
} from "./mcp-bridge-provider-readiness";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
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
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): McpScrubbedAdapterEntry {
  const observation = observeMcpCredentialRevision(sandboxName, entry, runtimeSelection);
  if (observation === "absent" || observation === "canonical") {
    throw new McpBridgeError(
      `Could not prove a revision-scoped credential before removing the managed adapter entry for MCP server '${entry.server}'.`,
    );
  }
  const credentialRevision: McpAttachedCredentialRevision = observation;
  const adapter = resolveManagedMcpAdapter(sandbox, entry);
  const removal = unregisterAgentAdapter(sandboxName, adapter, entry, runtimeSelection, {
    envValues: {},
    teardown: true,
  });
  if (removal === "unowned") {
    throw new McpBridgeError(
      `Could not prove removal of the exact managed adapter entry for MCP server '${entry.server}'.`,
    );
  }
  return {
    ...entry,
    ...(credentialRevision ? { credentialRevision } : {}),
  };
}

/** Restore scrubbed adapter entries without hiding failures from provider rollback. */
export function rollbackScrubbedMcpAdapters(
  sandboxName: string,
  sandbox: SandboxEntry,
  entries: readonly McpScrubbedAdapterEntry[],
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    let credentialRevision: McpAttachedCredentialRevision | undefined;
    try {
      const current = observeMcpCredentialRevision(sandboxName, entry, runtimeSelection);
      if (current !== "absent" && current !== "canonical") credentialRevision = current;
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
      registerAgentAdapterAtCurrentCredentialRevision(
        sandboxName,
        resolveManagedMcpAdapter(sandbox, entry),
        entry,
        runtimeSelection,
        {},
        credentialRevision,
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
