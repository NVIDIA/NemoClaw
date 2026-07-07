// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import {
  DEEPAGENTS_MANAGED_PROJECTION_READ_HELPERS,
  DEEPAGENTS_STRICT_JSON_HELPERS,
} from "./mcp-bridge-adapter-deepagents-projection";

// NemoClaw owns this dedicated projection. Deep Agents Code's user/project
// `.mcp.json` discovery is disabled in the managed image so user-authored MCP
// state can never be layered over the validated registry projection.
export const DEEPAGENTS_MCP_CONFIG_PATH = "/sandbox/.deepagents/.nemoclaw-mcp.json";
const DEFAULT_AUTH_HEADER = "Authorization";
const DEFAULT_AUTH_SCHEME = "Bearer";

function authPlaceholder(entry: Pick<McpBridgeEntry, "env">): string | null {
  const envName = entry.env[0];
  return envName ? `openshell:resolve:env:${envName}` : null;
}

export function authorizationValue(entry: Pick<McpBridgeEntry, "env">): string | null {
  const placeholder = authPlaceholder(entry);
  return placeholder ? `${DEFAULT_AUTH_SCHEME} ${placeholder}` : null;
}

export function entryHeaders(entry: Pick<McpBridgeEntry, "env">): Record<string, string> {
  const authorization = authorizationValue(entry);
  return authorization ? { [DEFAULT_AUTH_HEADER]: authorization } : {};
}

export function pythonJsonLiteral(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
}

/**
 * mcporter@0.7.3 normalizes every HTTP definition returned by
 * `config get --json` with an `accept: application/json, text/event-stream`
 * header, even when that header is absent from the persisted config. Treat
 * only that synthesized header as equivalent; every persisted/other header
 * remains part of the ownership fingerprint.
 *
 * This function is also serialized into the in-sandbox inspection commands,
 * so keep it self-contained (no references to module-scope values).
 */
export function mcporterHeadersMatchExpected(
  actual: unknown,
  expected: Record<string, string>,
): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const actualHeaders = actual as Record<string, unknown>;
  for (const [name, value] of Object.entries(expected)) {
    if (actualHeaders[name] !== value) return false;
  }
  const extraNames = Object.keys(actualHeaders).filter((name) => !Object.hasOwn(expected, name));
  if (extraNames.length === 0) return true;
  if (extraNames.length !== 1) return false;
  const [extraName] = extraNames;
  return (
    extraName.toLowerCase() === "accept" &&
    actualHeaders[extraName] === "application/json, text/event-stream"
  );
}

export function mcporterHeaderMatcherSource(): string {
  return `const mcporterHeadersMatchExpected = ${mcporterHeadersMatchExpected.toString()};`;
}

export function hermesManagedServerConfig(entry: McpBridgeEntry): Record<string, unknown> {
  const headers = entryHeaders(entry);
  return {
    url: entry.url,
    enabled: true,
    timeout: 120,
    connect_timeout: 60,
    tools: { resources: true, prompts: true },
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export interface HermesMcpIntentPayload {
  present: Record<string, Record<string, unknown>>;
  absent: string[];
}

/** Render the host registry into the credential-safe shape persisted by Hermes. */
export function buildHermesMcpIntentPayload(
  entries: readonly McpBridgeEntry[],
  managedServerNames: readonly string[],
): HermesMcpIntentPayload {
  const sortedEntries = [...entries].sort((left, right) => left.server.localeCompare(right.server));
  const present = Object.fromEntries(
    sortedEntries.map((entry) => [entry.server, hermesManagedServerConfig(entry)]),
  );
  const presentNames = new Set(Object.keys(present));
  const absent = [...new Set(managedServerNames)].filter((name) => !presentNames.has(name)).sort();
  return { present, absent };
}

export function deepAgentsManagedServerConfig(entry: McpBridgeEntry): Record<string, unknown> {
  const headers = entryHeaders(entry);
  return {
    type: "http",
    url: entry.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export function buildHermesMcpStatusCommand(entry: McpBridgeEntry): string {
  const payload = {
    server: entry.server,
    expected: hermesManagedServerConfig(entry),
  };
  return [
    "/opt/hermes/.venv/bin/python - <<'PY'",
    "import json, pathlib, yaml",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    'config_path = pathlib.Path("/sandbox/.hermes/config.yaml")',
    "data = yaml.safe_load(config_path.read_text(encoding='utf-8')) if config_path.exists() else {}",
    "servers = data.get('mcp_servers') if isinstance(data, dict) else None",
    "present = isinstance(servers, dict) and payload['server'] in servers",
    "server = servers.get(payload['server']) if present else None",
    "ok = server == payload['expected']",
    "print('registered' if ok else ('mismatch' if present else 'absent'))",
    "PY",
  ].join("\n");
}

export function buildDeepAgentsMcpStatusCommand(entry: McpBridgeEntry): string {
  const payload = {
    server: entry.server,
    expected: deepAgentsManagedServerConfig(entry),
  };
  return [
    "/opt/venv/bin/python3 -I - <<'PY'",
    "import json, os, pathlib, stat",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `config_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    ...DEEPAGENTS_STRICT_JSON_HELPERS,
    ...DEEPAGENTS_MANAGED_PROJECTION_READ_HELPERS,
    "try:",
    "    data = read_managed_projection(config_path)[0]",
    "except Exception:",
    "    data = {}",
    "servers = data.get('mcpServers') if isinstance(data, dict) else None",
    "present = isinstance(servers, dict) and payload['server'] in servers",
    "server = servers.get(payload['server']) if present else None",
    "ok = server == payload['expected']",
    "print('registered' if ok else ('mismatch' if present else 'absent'))",
    "PY",
  ].join("\n");
}

export function buildOpenClawMcporterInspectCommand(
  entry: McpBridgeEntry,
  failOnMismatch: boolean,
): string {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry),
    failOnMismatch,
  };
  return [
    "node - <<'NODE'",
    'const { spawnSync } = require("node:child_process");',
    `const expected = JSON.parse(${pythonJsonLiteral(payload)});`,
    'const result = spawnSync("mcporter", ["config", "get", expected.server, "--json"], { encoding: "utf8" });',
    "if (result.error) { console.error(result.error.message); process.exit(3); }",
    "if (result.status !== 0) {",
    '  const detail = `${result.stderr || ""}\n${result.stdout || ""}`;',
    "  if (/not\\s+found|does\\s+not\\s+exist|unknown\\s+server/i.test(detail)) { console.log('absent'); process.exit(0); }",
    "  console.error(detail.trim() || `mcporter config get exited ${result.status}`);",
    "  process.exit(3);",
    "}",
    "let actual = null;",
    "try { actual = JSON.parse(result.stdout); } catch {}",
    'const headers = actual && actual.headers && typeof actual.headers === "object" ? actual.headers : {};',
    mcporterHeaderMatcherSource(),
    'const registered = !!actual && actual.name === expected.server && actual.transport === "http" && actual.baseUrl === expected.url && mcporterHeadersMatchExpected(headers, expected.headers);',
    'console.log(registered ? "registered" : "mismatch");',
    "if (!registered && expected.failOnMismatch) process.exit(2);",
    "NODE",
  ].join("\n");
}
