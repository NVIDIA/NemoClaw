// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox, type McpBridgeEntry } from "../../state/registry";
import { runDeepAgentsAdapterCommand } from "./mcp-bridge-adapter-deepagents-command";
import { inspectDeepAgentsAdapterRegistration } from "./mcp-bridge-adapter-deepagents-inspection";
import { buildDeepAgentsMcpRollbackRegisterCommand } from "./mcp-bridge-adapter-deepagents-legacy";
import {
  DEEPAGENTS_MANAGED_PROJECTION_HELPERS,
  DEEPAGENTS_MCP_MAX_SERVERS,
  DEEPAGENTS_STRICT_JSON_HELPERS,
} from "./mcp-bridge-adapter-deepagents-projection";
import {
  DEEPAGENTS_MCP_CONFIG_PATH,
  deepAgentsManagedServerConfig,
  pythonJsonLiteral,
} from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";

export function buildDeepAgentsMcpRegisterCommand(
  entry: McpBridgeEntry,
  replaceExisting = false,
  managedEntries: readonly McpBridgeEntry[] = [entry],
  teardownRollback = false,
): string {
  const expectedServers = Object.fromEntries(
    managedEntries
      .map((managedEntry): [string, Record<string, unknown>] => [
        managedEntry.server,
        deepAgentsManagedServerConfig(managedEntry),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const expectedServerCount = Object.keys(expectedServers).length;
  if (!teardownRollback && expectedServerCount > DEEPAGENTS_MCP_MAX_SERVERS) {
    throw new McpBridgeError(
      `Deep Agents managed MCP supports at most ${String(DEEPAGENTS_MCP_MAX_SERVERS)} servers; refusing to render a ${String(expectedServerCount)}-server mutation.`,
    );
  }
  if (teardownRollback) {
    return buildDeepAgentsMcpRollbackRegisterCommand(entry, expectedServers);
  }
  const payload = {
    server: entry.server,
    expected: deepAgentsManagedServerConfig(entry),
    expectedServers,
    replaceExisting,
  };
  return [
    "/opt/venv/bin/python3 -I - <<'PY'",
    "import json, os, pathlib, stat, sys, tempfile",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `config_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    ...DEEPAGENTS_STRICT_JSON_HELPERS,
    ...DEEPAGENTS_MANAGED_PROJECTION_HELPERS,
    "source_descriptor = None",
    "def fail_registration(message):",
    "    close_managed_projection_descriptor(source_descriptor)",
    "    print(message, file=sys.stderr)",
    "    raise SystemExit(2)",
    "try:",
    "    data, source_identity, source_descriptor = load_managed_projection_for_update(config_path)",
    "except (OSError, UnicodeDecodeError, ValueError) as exc:",
    `    fail_registration(f'Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: {exc}')`,
    "if not isinstance(data, dict):",
    `    fail_registration('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: expected a JSON object')`,
    "if data and set(data) != {'mcpServers'}:",
    `    fail_registration('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: only mcpServers is allowed')`,
    "servers = data.setdefault('mcpServers', {})",
    "if not isinstance(servers, dict):",
    `    fail_registration('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: mcpServers must be an object')`,
    "if payload['server'] in servers and not payload['replaceExisting']:",
    `    fail_registration(f"MCP server '{payload['server']}' already exists in ${DEEPAGENTS_MCP_CONFIG_PATH} and is not managed by NemoClaw.")`,
    "for name, current in servers.items():",
    "    if name == payload['server'] and payload['replaceExisting']:",
    "        continue",
    "    if payload['expectedServers'].get(name) != current:",
    `        fail_registration(f"Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: MCP server '{name}' is not exact registry-owned state")`,
    "data = {'mcpServers': payload['expectedServers']}",
    "config_path.parent.mkdir(parents=True, exist_ok=True)",
    "try:",
    "    write_managed_projection(config_path, data, source_identity, source_descriptor)",
    "except (OSError, ValueError) as exc:",
    `    fail_registration(f'Could not publish ${DEEPAGENTS_MCP_CONFIG_PATH}: {exc}')`,
    "PY",
  ].join("\n");
}

function registryOwnedDeepAgentsEntries(
  sandboxName: string,
  entry: McpBridgeEntry,
): McpBridgeEntry[] {
  const entries = new Map<string, McpBridgeEntry>();
  const bridges = getSandbox(sandboxName)?.mcp?.bridges ?? {};
  for (const bridge of Object.values(bridges)) entries.set(bridge.server, bridge);
  entries.set(entry.server, entry);
  return [...entries.values()];
}

function verifyDeepAgentsAdapterRegistration(sandboxName: string, entry: McpBridgeEntry): void {
  const inspection = inspectDeepAgentsAdapterRegistration(sandboxName, entry);
  if (inspection.state === "registered") return;
  const detail = inspection.state === "error" ? inspection.detail : inspection.state;
  throw new McpBridgeError(
    `deepagents-config config verification failed after adding '${entry.server}': ${detail}.`,
  );
}

export function registerDeepAgentsAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  replaceExisting = false,
  teardownRollback = false,
): void {
  const stdout = runDeepAgentsAdapterCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpRegisterCommand(
      entry,
      replaceExisting,
      registryOwnedDeepAgentsEntries(sandboxName, entry),
      teardownRollback,
    ),
    `Deep Agents Code MCP config registration failed for '${entry.server}'.`,
    { envValues },
  );
  if (teardownRollback) {
    if (!stdout.includes("NEMOCLAW_DEEPAGENTS_MCP_ROLLBACK_RESTORED=1")) {
      throw new McpBridgeError(
        `Deep Agents Code MCP rollback verification failed for '${entry.server}'.`,
      );
    }
  } else {
    verifyDeepAgentsAdapterRegistration(sandboxName, entry);
  }
}
