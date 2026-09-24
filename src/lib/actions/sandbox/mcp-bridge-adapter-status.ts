// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpSourceEntry } from "./mcp-bridge-contracts";
import type { McpAttachedCredentialRevision } from "./mcp-bridge-provider-readiness";
import {
  DEEPAGENTS_LEGACY_CONFIG_HELPERS,
  DEEPAGENTS_LEGACY_MCP_CONFIG_PATH,
} from "./mcp-bridge/deepagents-legacy-config";
import {
  DEEPAGENTS_NATIVE_MCP_CONFIG_READ_HELPERS,
  DEEPAGENTS_STRICT_JSON_HELPERS,
  DEEPAGENTS_UNSAFE_MCP_CONFIG_TYPES,
} from "./mcp-bridge-adapter-deepagents-native-config";

// This is the agent-native MCP source consumed by the managed Deep Agents
// runtime. Ambient project discovery is disabled so another file cannot layer
// unvalidated credential or endpoint state over it.
export const DEEPAGENTS_MCP_CONFIG_PATH = "/sandbox/.deepagents/.mcp.json";
export const UNSAFE_DEEPAGENTS_MCP_CONFIG_PREFIX = "Unsafe Deep Agents native MCP config path";
export const DEFAULT_OPENCLAW_CONFIG_DIR = "/sandbox/.openclaw";
export const HERMES_MCP_TRANSACTION_HELPER =
  "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py";

/** Build the runtime classifier shared by Deep Agents status, repair, rollback, and teardown. */
export function buildDeepAgentsRuntimeKindCommandLines(
  initialKind: "auto" | "v2" = "auto",
): string[] {
  return [
    `runtime_kind = "${initialKind}"  # NEMOCLAW_DEEPAGENTS_RUNTIME_TEST_ANCHOR`,
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
  ];
}

export function buildDeepAgentsMcpRuntimeKindCommand(): string {
  return [
    "/opt/venv/bin/python3 -I - <<'PY'",
    "import pathlib, sys",
    `managed_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_MCP_CONFIG_PATH)})`,
    `legacy_path = pathlib.Path(${JSON.stringify(DEEPAGENTS_LEGACY_MCP_CONFIG_PATH)})`,
    ...buildDeepAgentsRuntimeKindCommandLines(),
    "print(runtime_kind)",
    "PY",
  ].join("\n");
}

/** Normalize the OpenClaw agent configuration directory. */
export function openClawConfigDir(configDir = DEFAULT_OPENCLAW_CONFIG_DIR): string {
  return configDir.replace(/\/+$/, "");
}
export const OPENCLAW_MCP_CONFIG_DIR = openClawConfigDir();
const DEFAULT_AUTH_HEADER = "Authorization";
const DEFAULT_AUTH_SCHEME = "Bearer";

export interface UnsafeDeepAgentsMcpConfigResult {
  messagePrefix: string;
  path: string;
}

/** Parse only the unsafe native-config result emitted by the Deep Agents status adapter. */
export function parseUnsafeDeepAgentsMcpConfigResult(result: {
  status: number | null;
  stdout: string;
  stderr: string;
}): UnsafeDeepAgentsMcpConfigResult | null {
  if (result.status === 0) return null;
  const detail = (result.stderr || result.stdout || "not found").trim();
  for (const type of DEEPAGENTS_UNSAFE_MCP_CONFIG_TYPES) {
    const messagePrefix = `${UNSAFE_DEEPAGENTS_MCP_CONFIG_PREFIX}: ${type} at `;
    if (!detail.startsWith(messagePrefix)) continue;
    const configPath = detail.slice(messagePrefix.length);
    return configPath && !/[\r\n]/u.test(configPath) ? { messagePrefix, path: configPath } : null;
  }
  return null;
}

function authPlaceholder(
  entry: Pick<McpSourceEntry, "env">,
  credentialRevision?: McpAttachedCredentialRevision,
): string | null {
  const envName = entry.env[0];
  if (!envName) return null;
  const revision = credentialRevision ? `${credentialRevision}_` : "";
  return `openshell:resolve:env:${revision}${envName}`;
}

export function authorizationValue(
  entry: Pick<McpSourceEntry, "env">,
  credentialRevision?: McpAttachedCredentialRevision,
): string | null {
  const placeholder = authPlaceholder(entry, credentialRevision);
  return placeholder ? `${DEFAULT_AUTH_SCHEME} ${placeholder}` : null;
}

export function entryHeaders(
  entry: Pick<McpSourceEntry, "env">,
  credentialRevision?: McpAttachedCredentialRevision,
): Record<string, string> {
  const authorization = authorizationValue(entry, credentialRevision);
  return authorization ? { [DEFAULT_AUTH_HEADER]: authorization } : {};
}

export function pythonJsonLiteral(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
}

/** Compare native OpenClaw headers, tolerating only a revisioned or stable-handle form of the same resolver key. */
export function openClawHeadersMatchExpected(
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
        `^${canonicalPrefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:v[0-9]{1,20}|s[a-f0-9]{64})_${escapedEnvName}$`,
        "u",
      ).test(actualValue)
    ) {
      return false;
    }
  }
  return Object.keys(actualHeaders).every((name) => Object.hasOwn(expected, name));
}

export function openClawHeaderMatcherSource(): string {
  return `const openClawHeadersMatchExpected = ${openClawHeadersMatchExpected.toString()};`;
}

export function hermesManagedServerConfig(
  entry: McpSourceEntry,
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
  entries: readonly McpSourceEntry[],
  expectedServerNames: readonly string[],
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
  const absent = [...new Set(expectedServerNames)].filter((name) => !presentNames.has(name)).sort();
  return { present, absent };
}

export function deepAgentsManagedServerConfig(
  entry: McpSourceEntry,
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
  entry: McpSourceEntry,
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
  "        suffix = '_' + env_name",
  "        if not env_name or not isinstance(actual_value, str) or not actual_value.startswith(canonical_prefix) or not actual_value.endswith(suffix):",
  "            return False",
  "        generation = actual_value[len(canonical_prefix):-len(suffix)]",
  "        revisioned = generation.startswith('v') and generation[1:].isdigit() and 1 <= len(generation[1:]) <= 20",
  "        stable = generation.startswith('s') and len(generation[1:]) == 64 and all(char in '0123456789abcdef' for char in generation[1:])",
  "        if not revisioned and not stable:",
  "            return False",
  "    return True",
];

export function buildDeepAgentsMcpStatusCommand(
  entry: McpSourceEntry,
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
    ...DEEPAGENTS_NATIVE_MCP_CONFIG_READ_HELPERS,
    ...DEEPAGENTS_LEGACY_CONFIG_HELPERS,
    ...MANAGED_HTTP_SERVER_MATCH_HELPERS,
    ...buildDeepAgentsRuntimeKindCommandLines(),
    "is_v2 = runtime_kind == 'v2'",
    "config_path = managed_path if is_v2 else legacy_path",
    "try:",
    "    data = read_native_mcp_config(config_path)[0] if is_v2 else read_legacy_config(config_path)[0]",
    "except UnsafeNativeMcpConfigError as exc:",
    `    print(f'${UNSAFE_DEEPAGENTS_MCP_CONFIG_PREFIX}: {exc} at {config_path}', file=sys.stderr)`,
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

export function buildOpenClawMcpInspectCommand(
  entry: McpSourceEntry,
  failOnMismatch: boolean,
  root = OPENCLAW_MCP_CONFIG_DIR,
  credentialRevision?: McpAttachedCredentialRevision,
): string {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry, credentialRevision),
    failOnMismatch,
    configPath: `${root}/openclaw.json`,
  };
  return [
    "node - <<'NODE'",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const expected = JSON.parse(${pythonJsonLiteral(payload)});`,
    "let actual = null; try { const configPath = path.resolve(expected.configPath); const fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); try { const before = fs.fstatSync(fd); const linked = fs.lstatSync(configPath); if (!before.isFile() || !linked.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || before.dev !== linked.dev || before.ino !== linked.ino || before.size > 1048576) throw new Error('OpenClaw configuration source is unsafe'); const raw = Buffer.alloc(before.size); let count = 0; while (count < raw.length) { const read = fs.readSync(fd, raw, count, raw.length - count, count); if (read === 0) break; count += read; } if (count !== before.size) throw new Error('OpenClaw configuration read was incomplete'); const data = JSON.parse(raw.toString('utf8')); actual = data && data.mcp && data.mcp.servers && data.mcp.servers[expected.server]; } finally { fs.closeSync(fd); } } catch (error) { if (error && error.code === 'ENOENT') { console.log('absent'); process.exit(0); } console.error(error instanceof Error ? error.message : String(error)); process.exit(3); }",
    "if (!actual) { console.log('absent'); process.exit(0); }",
    'const headers = actual && actual.headers && typeof actual.headers === "object" ? actual.headers : {};',
    openClawHeaderMatcherSource(),
    "const registered = !!actual && actual.url === expected.url && openClawHeadersMatchExpected(headers, expected.headers);",
    'console.log(registered ? "registered" : "mismatch");',
    "if (!registered && expected.failOnMismatch) process.exit(2);",
    "NODE",
  ].join("\n");
}
