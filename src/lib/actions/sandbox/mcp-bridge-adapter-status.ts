// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import type { McpAttachedCredentialRevision } from "./mcp-bridge-provider-readiness";
import {
  DEEPAGENTS_LEGACY_CONFIG_HELPERS,
  DEEPAGENTS_LEGACY_MCP_CONFIG_PATH,
} from "./mcp-bridge/deepagents-legacy-config";
import {
  DEEPAGENTS_MANAGED_PROJECTION_READ_HELPERS,
  DEEPAGENTS_STRICT_JSON_HELPERS,
  DEEPAGENTS_UNSAFE_MCP_PROJECTION_TYPES,
} from "./mcp-bridge-adapter-deepagents-projection";

// NemoClaw owns this dedicated projection. Deep Agents Code's user/project
// `.mcp.json` discovery is disabled in the managed image so user-authored MCP
// state can never be layered over the validated registry projection.
export const DEEPAGENTS_MCP_CONFIG_PATH = "/sandbox/.deepagents/.nemoclaw-mcp.json";
export const UNSAFE_DEEPAGENTS_MCP_PROJECTION_PREFIX =
  "Unsafe managed Deep Agents MCP projection path";
export const DEFAULT_OPENCLAW_CONFIG_DIR = "/sandbox/.openclaw";
export const HERMES_MCP_TRANSACTION_HELPER =
  "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py";

/** Resolve Mcporter's project root beneath an OpenClaw agent configuration directory. */
export function openClawMcporterRoot(configDir = DEFAULT_OPENCLAW_CONFIG_DIR): string {
  return `${configDir.replace(/\/+$/, "")}/workspace`;
}
export const OPENCLAW_MCPORTER_ROOT = openClawMcporterRoot();
const DEFAULT_AUTH_HEADER = "Authorization";
const DEFAULT_AUTH_SCHEME = "Bearer";

export interface UnsafeDeepAgentsMcpProjectionResult {
  messagePrefix: string;
  path: string;
}

/** Parse only the unsafe-projection result emitted by the Deep Agents status adapter. */
export function parseUnsafeDeepAgentsMcpProjectionResult(result: {
  status: number | null;
  stdout: string;
  stderr: string;
}): UnsafeDeepAgentsMcpProjectionResult | null {
  if (result.status === 0) return null;
  const detail = (result.stderr || result.stdout || "not found").trim();
  for (const type of DEEPAGENTS_UNSAFE_MCP_PROJECTION_TYPES) {
    const messagePrefix = `${UNSAFE_DEEPAGENTS_MCP_PROJECTION_PREFIX}: ${type} at `;
    if (!detail.startsWith(messagePrefix)) continue;
    const projectionPath = detail.slice(messagePrefix.length);
    return projectionPath && !/[\r\n]/u.test(projectionPath)
      ? { messagePrefix, path: projectionPath }
      : null;
  }
  return null;
}

function authPlaceholder(
  entry: Pick<McpBridgeEntry, "env">,
  credentialRevision?: McpAttachedCredentialRevision,
): string | null {
  const envName = entry.env[0];
  if (!envName) return null;
  const revision = credentialRevision ? `${credentialRevision}_` : "";
  return `openshell:resolve:env:${revision}${envName}`;
}

export function authorizationValue(
  entry: Pick<McpBridgeEntry, "env">,
  credentialRevision?: McpAttachedCredentialRevision,
): string | null {
  const placeholder = authPlaceholder(entry, credentialRevision);
  return placeholder ? `${DEFAULT_AUTH_SCHEME} ${placeholder}` : null;
}

export function entryHeaders(
  entry: Pick<McpBridgeEntry, "env">,
  credentialRevision?: McpAttachedCredentialRevision,
): Record<string, string> {
  const authorization = authorizationValue(entry, credentialRevision);
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
 * remains part of the ownership fingerprint. When the expected placeholder is
 * canonical, a strictly bounded revisioned form of the same credential is also
 * equivalent. A revisioned expectation remains exact.
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
    if (actualHeaders[name] === value) continue;
    const canonicalPrefix = "Bearer openshell:resolve:env:";
    const envName = value.startsWith(canonicalPrefix) ? value.slice(canonicalPrefix.length) : "";
    const actualValue = actualHeaders[name];
    if (
      name.toLowerCase() !== "authorization" ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(envName) ||
      typeof actualValue !== "string"
    ) {
      return false;
    }
    const escapedEnvName = envName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (
      !new RegExp(
        `^${canonicalPrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}v[0-9]{1,20}_${escapedEnvName}$`,
        "u",
      ).test(actualValue)
    ) {
      return false;
    }
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

export function hermesManagedServerConfig(
  entry: McpBridgeEntry,
  credentialRevision?: McpAttachedCredentialRevision,
): Record<string, unknown> {
  const headers = entryHeaders(entry, credentialRevision);
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
  credentialRevisions: ReadonlyMap<string, McpAttachedCredentialRevision> = new Map(),
): HermesMcpIntentPayload {
  const sortedEntries = [...entries].sort((left, right) => left.server.localeCompare(right.server));
  const present = Object.fromEntries(
    sortedEntries.map((entry) => [
      entry.server,
      hermesManagedServerConfig(entry, credentialRevisions.get(entry.server)),
    ]),
  );
  const presentNames = new Set(Object.keys(present));
  const absent = [...new Set(managedServerNames)].filter((name) => !presentNames.has(name)).sort();
  return { present, absent };
}

export function deepAgentsManagedServerConfig(
  entry: McpBridgeEntry,
  credentialRevision?: McpAttachedCredentialRevision,
): Record<string, unknown> {
  const headers = entryHeaders(entry, credentialRevision);
  return {
    type: "http",
    url: entry.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export function buildHermesMcpStatusCommand(
  entry: McpBridgeEntry,
  credentialRevision?: McpAttachedCredentialRevision,
): string {
  const payload = {
    server: entry.server,
    expected: hermesManagedServerConfig(entry, credentialRevision),
    allowRevisioned: credentialRevision === undefined,
  };
  return [
    "/opt/hermes/.venv/bin/python - <<'PY'",
    "import json, pathlib, yaml",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    ...MANAGED_HTTP_SERVER_MATCH_HELPERS,
    'config_path = pathlib.Path("/sandbox/.hermes/config.yaml")',
    "data = yaml.safe_load(config_path.read_text(encoding='utf-8')) if config_path.exists() else {}",
    "servers = data.get('mcp_servers') if isinstance(data, dict) else None",
    "present = isinstance(servers, dict) and payload['server'] in servers",
    "server = servers.get(payload['server']) if present else None",
    "ok = managed_http_server_matches(server, payload['expected'], payload['allowRevisioned'])",
    "print('registered' if ok else ('mismatch' if present else 'absent'))",
    "PY",
  ].join("\n");
}

export const MANAGED_HTTP_SERVER_MATCH_HELPERS = [
  "def managed_http_server_matches(actual, expected, allow_revisioned):",
  "    if actual == expected:",
  "        return True",
  "    if not allow_revisioned or not isinstance(actual, dict) or not isinstance(expected, dict):",
  "        return False",
  "    if set(actual) != set(expected):",
  "        return False",
  "    for name, value in expected.items():",
  "        if name != 'headers' and actual.get(name) != value:",
  "            return False",
  "    actual_headers = actual.get('headers')",
  "    expected_headers = expected.get('headers')",
  "    if not isinstance(actual_headers, dict) or not isinstance(expected_headers, dict):",
  "        return False",
  "    if set(actual_headers) != set(expected_headers):",
  "        return False",
  "    for name, value in expected_headers.items():",
  "        actual_value = actual_headers.get(name)",
  "        if actual_value == value:",
  "            continue",
  "        canonical_prefix = 'Bearer openshell:resolve:env:'",
  "        env_name = value[len(canonical_prefix):] if name.lower() == 'authorization' and isinstance(value, str) and value.startswith(canonical_prefix) else ''",
  "        revision_prefix = canonical_prefix + 'v'",
  "        suffix = '_' + env_name",
  "        if not env_name or not isinstance(actual_value, str) or not actual_value.startswith(revision_prefix) or not actual_value.endswith(suffix):",
  "            return False",
  "        revision = actual_value[len(revision_prefix):-len(suffix)]",
  "        if not revision.isdigit() or not (1 <= len(revision) <= 20):",
  "            return False",
  "    return True",
];

export function buildDeepAgentsMcpStatusCommand(
  entry: McpBridgeEntry,
  credentialRevision?: McpAttachedCredentialRevision,
): string {
  const payload = {
    server: entry.server,
    expected: deepAgentsManagedServerConfig(entry, credentialRevision),
    allowRevisioned: credentialRevision === undefined,
  };
  return [
    "/opt/venv/bin/python3 -I - <<'PY'",
    "import json, os, pathlib, stat, sys",
    `payload = json.loads(${pythonJsonLiteral(payload)})`,
    `managed_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    `legacy_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_LEGACY_MCP_CONFIG_PATH)})`,
    ...DEEPAGENTS_STRICT_JSON_HELPERS,
    ...DEEPAGENTS_MANAGED_PROJECTION_READ_HELPERS,
    ...DEEPAGENTS_LEGACY_CONFIG_HELPERS,
    ...MANAGED_HTTP_SERVER_MATCH_HELPERS,
    `runtime_kind = "auto"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR`,
    "if runtime_kind == 'auto':",
    "    runtime_kind = 'unknown'",
    "    try:",
    "        from deepagents_code import _nemoclaw_managed as managed",
    "        runtime_path = str(getattr(managed, '_MCP_CONFIG_FILE', ''))",
    "        if runtime_path == str(managed_path):",
    "            runtime_kind = 'v2'",
    "        elif runtime_path == str(legacy_path):",
    "            runtime_kind = 'legacy'",
    "    except Exception:",
    "        pass",
    "if runtime_kind not in ('v2', 'legacy'):",
    "    print('Could not identify the managed Deep Agents MCP runtime', file=sys.stderr)",
    "    raise SystemExit(2)",
    "is_v2 = runtime_kind == 'v2'",
    "config_path = managed_path if is_v2 else legacy_path",
    "try:",
    "    data = read_managed_projection(config_path)[0] if is_v2 else read_legacy_config(config_path)[0]",
    "except UnsafeManagedProjectionError as exc:",
    `    print(f'${UNSAFE_DEEPAGENTS_MCP_PROJECTION_PREFIX}: {exc} at {config_path}', file=sys.stderr)`,
    "    raise SystemExit(2)",
    "except FileNotFoundError:",
    "    data = {}",
    "except (OSError, UnicodeDecodeError, ValueError) as exc:",
    "    print(f'Could not inspect managed Deep Agents MCP state at {config_path}: {exc}', file=sys.stderr)",
    "    raise SystemExit(2)",
    "servers = data.get('mcpServers') if isinstance(data, dict) else None",
    "present = isinstance(servers, dict) and payload['server'] in servers",
    "server = servers.get(payload['server']) if present else None",
    "ok = managed_http_server_matches(server, payload['expected'], payload['allowRevisioned'])",
    "print('registered' if ok else ('mismatch' if present else 'absent'))",
    "PY",
  ].join("\n");
}

export function buildOpenClawMcporterInspectCommand(
  entry: McpBridgeEntry,
  failOnMismatch: boolean,
  root = OPENCLAW_MCPORTER_ROOT,
  credentialRevision?: McpAttachedCredentialRevision,
): string {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry, credentialRevision),
    failOnMismatch,
    root,
  };
  return [
    "node - <<'NODE'",
    'const { spawnSync } = require("node:child_process");',
    `const expected = JSON.parse(${pythonJsonLiteral(payload)});`,
    'const result = spawnSync("mcporter", ["--root", expected.root, "config", "get", expected.server, "--json"], { encoding: "utf8" });',
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
