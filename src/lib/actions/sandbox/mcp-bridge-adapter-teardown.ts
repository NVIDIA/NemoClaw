// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentMcpAdapter } from "../../agent/defs";
import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";
import { registerAgentAdapter, unregisterAgentAdapter } from "./mcp-bridge-adapters";
import { isAgentMcpAdapter, McpBridgeError } from "./mcp-bridge-contracts";
import {
  type McpAttachedCredentialRevision,
  observeMcpCredentialRevision,
} from "./mcp-bridge-provider-readiness";
import { getBridgeAdapter, getSandboxAgent } from "./mcp-bridge-state";

export type ScrubbedMcpAdapter = McpBridgeEntry & {
  credentialRevision?: McpAttachedCredentialRevision;
};

/** Capture the attached revision required for a fail-closed adapter rollback. */
export function captureMcpAdapterRollbackState(
  sandboxName: string,
  sandbox: SandboxEntry,
  entry: McpBridgeEntry,
): ScrubbedMcpAdapter {
  const adapter = resolveManagedMcpAdapter(sandbox, entry);
  if (adapter !== "hermes-config") return entry;
  const credentialRevision = observeMcpCredentialRevision(sandboxName, entry);
  if (credentialRevision === "absent") {
    throw new McpBridgeError(
      `Could not prove an attached credential revision before changing Hermes MCP adapter '${entry.server}'.`,
    );
  }
  return { ...entry, credentialRevision };
}

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
): ScrubbedMcpAdapter {
  const adapter = resolveManagedMcpAdapter(sandbox, entry);
  const rollbackState = captureMcpAdapterRollbackState(sandboxName, sandbox, entry);
  const removal = unregisterAgentAdapter(sandboxName, adapter, entry, {
    envValues: {},
    teardown: true,
  });
  if (removal === "unowned") {
    throw new McpBridgeError(
      `Could not prove removal of the exact managed adapter entry for MCP server '${entry.server}'.`,
    );
  }
  return rollbackState;
}

/** Restore scrubbed adapter entries without hiding failures from provider rollback. */
export function rollbackScrubbedMcpAdapters(
  sandboxName: string,
  sandbox: SandboxEntry,
  scrubbedAdapters: readonly ScrubbedMcpAdapter[],
): string[] {
  const failures: string[] = [];
  for (const scrubbedAdapter of scrubbedAdapters) {
    try {
      const { credentialRevision, ...entry } = scrubbedAdapter;
      const adapter = resolveManagedMcpAdapter(sandbox, entry);
      if (adapter === "hermes-config" && credentialRevision === undefined) {
        throw new McpBridgeError(
          `Could not prove an attached credential revision while rolling back MCP adapter '${entry.server}'.`,
        );
      }
      registerAgentAdapter(
        sandboxName,
        adapter,
        entry,
        {},
        {
          replaceExisting: true,
          teardownRollback: true,
          ...(credentialRevision === undefined ? {} : { credentialRevision }),
        },
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}
