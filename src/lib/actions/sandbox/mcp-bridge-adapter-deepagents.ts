// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { getSandbox, type McpBridgeEntry } from "../../state/registry";
import {
  type AdapterMutationOptions,
  type AdapterRegistrationInspection,
  inspectAdapterRegistrationCommand,
} from "./mcp-bridge-adapter-inspection";
import {
  buildDeepAgentsMcpStatusCommand,
  DEEPAGENTS_MCP_CONFIG_PATH,
  deepAgentsManagedServerConfig,
  pythonJsonLiteral,
} from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import { executeSandboxCommand } from "./process-recovery";

const DEEPAGENTS_MCP_CAPABILITY_MARKER = "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=1";
const DEEPAGENTS_MCP_CAPABILITY_COMMAND =
  "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability";

export function buildDeepAgentsMcpRegisterCommand(
  entry: McpBridgeEntry,
  replaceExisting = false,
  managedEntries: readonly McpBridgeEntry[] = [entry],
): string {
  const expectedServers = Object.fromEntries(
    managedEntries
      .map((managedEntry): [string, Record<string, unknown>] => [
        managedEntry.server,
        deepAgentsManagedServerConfig(managedEntry),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const payload = {
    server: entry.server,
    expected: deepAgentsManagedServerConfig(entry),
    expectedServers,
    replaceExisting,
  };
  return [
    "python3 - <<'PY'",
    "import json, os, pathlib, sys",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `config_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    "data = {}",
    "if config_path.exists():",
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
    "tmp = config_path.with_name(config_path.name + '.nemoclaw-mcp.tmp')",
    "tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + '\\n', encoding='utf-8')",
    "os.chmod(tmp, 0o600)",
    "os.replace(tmp, config_path)",
    "os.chmod(config_path, 0o600)",
    "PY",
  ].join("\n");
}

export function buildDeepAgentsMcpRemoveCommand(entry: McpBridgeEntry, force = false): string {
  const payload = {
    server: entry.server,
    expected: deepAgentsManagedServerConfig(entry),
    force,
  };
  return [
    "python3 - <<'PY'",
    "import json, os, pathlib, sys",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `config_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    "if not config_path.exists():",
    "    raise SystemExit(0)",
    "try:",
    "    data = json.loads(config_path.read_text(encoding='utf-8') or '{}')",
    "except json.JSONDecodeError as exc:",
    `    print(f'Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: {exc}', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "if not isinstance(data, dict):",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: expected a JSON object', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "servers = data.get('mcpServers')",
    "if servers is not None and not isinstance(servers, dict):",
    `    print('Invalid ${DEEPAGENTS_MCP_CONFIG_PATH}: mcpServers must be an object', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "if isinstance(servers, dict):",
    "    present = payload['server'] in servers",
    "    current = servers.get(payload['server'])",
    "    if present and not payload['force']:",
    "        if current != payload['expected']:",
    `            print(f"Refusing to remove modified MCP server '{payload['server']}' from ${DEEPAGENTS_MCP_CONFIG_PATH}. Use --force to remove it.", file=sys.stderr)`,
    "            raise SystemExit(2)",
    "    servers.pop(payload['server'], None)",
    "    if not servers:",
    "        data.pop('mcpServers', None)",
    "        if not data:",
    "            config_path.unlink()",
    "            raise SystemExit(0)",
    "tmp = config_path.with_name(config_path.name + '.nemoclaw-mcp.tmp')",
    "tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + '\\n', encoding='utf-8')",
    "os.chmod(tmp, 0o600)",
    "os.replace(tmp, config_path)",
    "os.chmod(config_path, 0o600)",
    "PY",
  ].join("\n");
}

export function inspectDeepAgentsAdapterRegistration(
  sandboxName: string,
  entry: McpBridgeEntry,
): AdapterRegistrationInspection {
  return inspectAdapterRegistrationCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpStatusCommand(entry),
  );
}

export function assertDeepAgentsMcpMutationRuntimeCapability(sandboxName: string): void {
  const result = executeSandboxCommand(sandboxName, DEEPAGENTS_MCP_CAPABILITY_COMMAND);
  if (result?.status !== 0 || result.stdout.trim() !== DEEPAGENTS_MCP_CAPABILITY_MARKER) {
    throw new McpBridgeError(
      `LangChain Deep Agents Code sandbox '${sandboxName}' does not contain the managed MCP-aware launcher. Rebuild the sandbox before changing authenticated MCP state.`,
    );
  }
}

function runDeepAgentsAdapterCommand(
  sandboxName: string,
  entry: Pick<McpBridgeEntry, "env">,
  command: string,
  failureMessage: string,
  options: AdapterMutationOptions = {},
): void {
  const result = executeSandboxCommand(sandboxName, command);
  const output = redactBridgeSecretsForDisplay(
    [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    options.envValues ?? {},
  );
  if (!result || result.status !== 0) {
    if (options.bestEffort) return;
    throw new McpBridgeError(output || failureMessage);
  }
}

function verifyDeepAgentsAdapterRegistration(sandboxName: string, entry: McpBridgeEntry): void {
  const inspection = inspectDeepAgentsAdapterRegistration(sandboxName, entry);
  if (inspection.state === "registered") return;
  const detail = inspection.state === "error" ? inspection.detail : inspection.state;
  throw new McpBridgeError(
    `deepagents-config config verification failed after adding '${entry.server}': ${detail}.`,
  );
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

export function registerDeepAgentsAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  replaceExisting = false,
): void {
  runDeepAgentsAdapterCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpRegisterCommand(
      entry,
      replaceExisting,
      registryOwnedDeepAgentsEntries(sandboxName, entry),
    ),
    `Deep Agents Code MCP config registration failed for '${entry.server}'.`,
    { envValues },
  );
  verifyDeepAgentsAdapterRegistration(sandboxName, entry);
}

export function unregisterDeepAgentsAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  options: AdapterMutationOptions = {},
): void {
  runDeepAgentsAdapterCommand(
    sandboxName,
    entry,
    buildDeepAgentsMcpRemoveCommand(entry, options.force === true),
    `Deep Agents Code MCP config removal failed for '${entry.server}'.`,
    options,
  );
}
