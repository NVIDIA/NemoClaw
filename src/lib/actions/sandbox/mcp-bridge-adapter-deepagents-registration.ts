// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox, type McpBridgeEntry } from "../../state/registry";
import { runDeepAgentsAdapterCommand } from "./mcp-bridge-adapter-deepagents-command";
import { inspectDeepAgentsAdapterRegistration } from "./mcp-bridge-adapter-deepagents-inspection";
import { buildDeepAgentsMcpRollbackRegisterCommand } from "./mcp-bridge-adapter-deepagents-legacy";
import {
  DEEPAGENTS_MCP_CONFIG_PATH,
  deepAgentsManagedServerConfig,
  pythonJsonLiteral,
} from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";

const DEEPAGENTS_MCP_MAX_SERVERS = 64;

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
    "python3 - <<'PY'",
    "import json, os, pathlib, sys, tempfile",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `config_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    "data = {}",
    "if os.path.lexists(config_path):",
    "    if config_path.is_symlink():",
    `        print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: managed projection must not be a symlink', file=sys.stderr)`,
    "        raise SystemExit(2)",
    "    try:",
    "        data = json.loads(config_path.read_text(encoding='utf-8') or '{}')",
    "    except json.JSONDecodeError as exc:",
    `        print(f'Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: {exc}', file=sys.stderr)`,
    "        raise SystemExit(2)",
    "if not isinstance(data, dict):",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: expected a JSON object', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "if data and set(data) != {'mcpServers'}:",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: only mcpServers is allowed', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "servers = data.setdefault('mcpServers', {})",
    "if not isinstance(servers, dict):",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: mcpServers must be an object', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "if payload['server'] in servers and not payload['replaceExisting']:",
    `    print(f"MCP server '{payload['server']}' already exists in ${DEEPAGENTS_MCP_CONFIG_PATH} and is not managed by NemoClaw.", file=sys.stderr)`,
    "    raise SystemExit(2)",
    "for name, current in servers.items():",
    "    if name == payload['server'] and payload['replaceExisting']:",
    "        continue",
    "    if payload['expectedServers'].get(name) != current:",
    `        print(f"Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: MCP server '{name}' is not exact registry-owned state", file=sys.stderr)`,
    "        raise SystemExit(2)",
    "data = {'mcpServers': payload['expectedServers']}",
    "config_path.parent.mkdir(parents=True, exist_ok=True)",
    "tmp_fd, tmp_name = tempfile.mkstemp(prefix='.nemoclaw-mcp.', dir=config_path.parent)",
    "try:",
    "    os.fchmod(tmp_fd, 0o600)",
    "    with os.fdopen(tmp_fd, 'w', encoding='utf-8') as tmp_file:",
    "        json.dump(data, tmp_file, indent=2, sort_keys=True)",
    "        tmp_file.write('\\n')",
    "        tmp_file.flush()",
    "        os.fsync(tmp_file.fileno())",
    "    os.replace(tmp_name, config_path)",
    "finally:",
    "    try:",
    "        os.unlink(tmp_name)",
    "    except FileNotFoundError:",
    "        pass",
    "os.chmod(config_path, 0o600)",
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
