// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import YAML from "yaml";

import type { AgentMcpAdapter } from "../../agent/defs";
import { loadAgent } from "../../agent/defs";
import { isObjectRecord } from "../../core/json-types";
import { captureRecordedSandboxBasePolicy } from "../../policy";
import { isBlockedMcpUrlTargetHost } from "../../security/mcp-url-target";
import type { SandboxEntry } from "../../state/registry";
import { buildMcpBridgePolicyKey, buildMcpBridgePolicyName } from "./mcp-bridge-policy-render";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import { McpBridgeError } from "./mcp-bridge-contracts";
import {
  inspectMcpProvider,
  type McpProviderInspectionRuntimeSelection,
} from "./mcp-bridge-provider-inspection";
import { executeSandboxCommand } from "./process-recovery";
import { quoteMcpBridgeShellArg } from "./mcp-bridge-runtime-command";

export interface AgentMcpSourceSnapshot {
  native: Record<string, McpSourceEntry>;
  legacy: Record<string, McpSourceEntry>;
}

type SourceRecord = {
  server: string;
  url: string;
  env: string | null;
  source: "native" | "legacy";
};

const SOURCE_RECORD_MAX = 64;
const SOURCE_OUTPUT_MAX_BYTES = 262_144;

function sourcePayload(value: unknown): string {
  return JSON.stringify(JSON.stringify(value));
}

function commonPythonSourceReader(): string[] {
  return [
    "import json, os, pathlib, stat",
    "MAX_BYTES = 262144",
    "ENV_PREFIX = 'Bearer openshell:resolve:env:'",
    "def read_regular(path):",
    "    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOFOLLOW",
    "    fd = os.open(path, flags)",
    "    try:",
    "        before = os.fstat(fd)",
    "        linked = os.stat(path, follow_symlinks=False)",
    "        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or (before.st_dev, before.st_ino) != (linked.st_dev, linked.st_ino) or before.st_size > MAX_BYTES:",
    "            raise ValueError('unsafe MCP configuration source')",
    "        chunks = []; remaining = before.st_size",
    "        while remaining:",
    "            chunk = os.read(fd, min(65536, remaining))",
    "            if not chunk: break",
    "            chunks.append(chunk); remaining -= len(chunk)",
    "        raw = b''.join(chunks)",
    "        after = os.fstat(fd)",
    "        if remaining or len(raw) != before.st_size or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):",
    "            raise ValueError('MCP configuration changed while reading')",
    "        return raw.decode('utf-8')",
    "    finally:",
    "        os.close(fd)",
    "def env_name(headers):",
    "    if not isinstance(headers, dict): return None",
    "    value = next((value for key, value in headers.items() if isinstance(key, str) and key.lower() == 'authorization'), None)",
    "    if not isinstance(value, str) or not value.startswith(ENV_PREFIX): return None",
    "    suffix = value[len(ENV_PREFIX):]",
    "    if suffix.startswith('v') and '_' in suffix and suffix[1:suffix.index('_')].isdigit(): suffix = suffix[suffix.index('_') + 1:]",
    "    return suffix if suffix and suffix.replace('_', 'A').isalnum() and not suffix[0].isdigit() else None",
  ];
}

function buildDeepAgentsSourceCommand(configDir: string): string {
  const nativePath = path.posix.join(configDir, ".mcp.json");
  const legacyPath = path.posix.join(configDir, ".nemoclaw-mcp.json");
  return [
    "/opt/venv/bin/python3 -I - <<'PY'",
    ...commonPythonSourceReader(),
    `paths = [('native', pathlib.Path(${sourcePayload(nativePath)})), ('legacy', pathlib.Path(${sourcePayload(legacyPath)}))]`,
    "records = []",
    "for source, config_path in paths:",
    "    try: data = json.loads(read_regular(config_path))",
    "    except FileNotFoundError: continue",
    "    servers = data.get('mcpServers', {}) if isinstance(data, dict) else {}",
    "    if not isinstance(servers, dict): raise ValueError('invalid Deep Agents MCP server map')",
    "    for name, value in servers.items():",
    "        if not isinstance(name, str) or not isinstance(value, dict): continue",
    "        url = value.get('url')",
    "        if isinstance(url, str): records.append({'server': name, 'url': url, 'env': env_name(value.get('headers')), 'source': source})",
    "print(json.dumps(records, separators=(',', ':'))) ",
    "PY",
  ].join("\n");
}

function buildHermesSourceCommand(configDir: string): string {
  const configPath = path.posix.join(configDir, "config.yaml");
  return [
    "/opt/hermes/.venv/bin/python - <<'PY'",
    ...commonPythonSourceReader(),
    "import yaml",
    `config_path = pathlib.Path(${sourcePayload(configPath)})`,
    "try: data = yaml.safe_load(read_regular(config_path))",
    "except FileNotFoundError: data = {}",
    "servers = data.get('mcp_servers', {}) if isinstance(data, dict) else {}",
    "if not isinstance(servers, dict): raise ValueError('invalid Hermes MCP server map')",
    "records = []",
    "for name, value in servers.items():",
    "    if not isinstance(name, str) or not isinstance(value, dict): continue",
    "    url = value.get('url')",
    "    if isinstance(url, str): records.append({'server': name, 'url': url, 'env': env_name(value.get('headers')), 'source': 'native'})",
    "print(json.dumps(records, separators=(',', ':'))) ",
    "PY",
  ].join("\n");
}

function buildOpenClawSourceCommand(configDir: string): string {
  const nativePath = path.posix.join(configDir, "openclaw.json");
  const legacyPath = path.posix.join(configDir, "workspace", "config", "mcporter.json");
  const payload = { nativePath, legacyPath };
  return [
    "node - <<'NODE'",
    'const fs = require("node:fs");',
    `const paths = JSON.parse(${sourcePayload(payload)});`,
    "const MAX_BYTES = 262144;",
    "const PREFIX = 'Bearer openshell:resolve:env:';",
    "function read(path) {",
    "  let fd; try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }",
    "  try { const before = fs.fstatSync(fd); const linked = fs.lstatSync(path); if (!before.isFile() || !linked.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || before.dev !== linked.dev || before.ino !== linked.ino || before.size > MAX_BYTES) throw new Error('unsafe MCP configuration source'); const raw = Buffer.alloc(before.size); let count = 0; while (count < raw.length) { const read = fs.readSync(fd, raw, count, raw.length - count, count); if (read === 0) break; count += read; } const after = fs.fstatSync(fd); if (count !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('MCP configuration changed while reading'); return JSON.parse(raw.toString('utf8')); } finally { fs.closeSync(fd); }",
    "}",
    "function envName(headers) { if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return null; const key = Object.keys(headers).find((name) => name.toLowerCase() === 'authorization'); const value = key ? headers[key] : null; if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null; let suffix = value.slice(PREFIX.length); if (/^v[0-9]{1,20}_[A-Z_][A-Z0-9_]*$/.test(suffix)) suffix = suffix.slice(suffix.indexOf('_') + 1); return /^[A-Z_][A-Z0-9_]*$/.test(suffix) ? suffix : null; }",
    "const records = [];",
    "const native = read(paths.nativePath); const nativeServers = native && native.mcp && native.mcp.servers; if (nativeServers && typeof nativeServers === 'object' && !Array.isArray(nativeServers)) for (const [server, value] of Object.entries(nativeServers)) if (value && typeof value === 'object' && typeof value.url === 'string') records.push({ server, url: value.url, env: envName(value.headers), source: 'native' });",
    "const legacy = read(paths.legacyPath); const legacyServers = legacy && legacy.mcpServers; if (legacyServers && typeof legacyServers === 'object' && !Array.isArray(legacyServers)) for (const [server, value] of Object.entries(legacyServers)) if (value && typeof value === 'object' && typeof value.baseUrl === 'string') records.push({ server, url: value.baseUrl, env: envName(value.headers), source: 'legacy' });",
    "process.stdout.write(JSON.stringify(records));",
    "NODE",
  ].join("\n");
}

function sourceCommand(adapter: AgentMcpAdapter, configDir: string): string {
  switch (adapter) {
    case "openclaw-config":
      return buildOpenClawSourceCommand(configDir);
    case "hermes-config":
      return buildHermesSourceCommand(configDir);
    case "deepagents-config":
      return buildDeepAgentsSourceCommand(configDir);
  }
}

function parseSourceRecords(output: string): SourceRecord[] {
  if (Buffer.byteLength(output, "utf8") > SOURCE_OUTPUT_MAX_BYTES) {
    throw new McpBridgeError("Agent MCP source inspection returned oversized output.");
  }
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new McpBridgeError("Agent MCP source inspection returned invalid JSON.");
  }
  if (!Array.isArray(value) || value.length > SOURCE_RECORD_MAX) {
    throw new McpBridgeError("Agent MCP source inspection returned an invalid server collection.");
  }
  return value.flatMap((record): SourceRecord[] => {
    if (
      !isObjectRecord(record) ||
      typeof record.server !== "string" ||
      typeof record.url !== "string" ||
      (record.env !== null && typeof record.env !== "string") ||
      (record.source !== "native" && record.source !== "legacy")
    ) {
      return [];
    }
    return [record as SourceRecord];
  });
}

function entryFromRecord(
  record: SourceRecord,
  agentName: string,
  adapter: AgentMcpAdapter,
): McpSourceEntry | null {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(record.server)) return null;
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return {
    server: record.server,
    agent: agentName,
    adapter,
    url: url.toString(),
    env: record.env ? [record.env] : [],
    policyName: buildMcpBridgePolicyName(record.server),
    source: record.source,
  };
}

export function inspectAgentMcpSources(
  sandbox: SandboxEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): AgentMcpSourceSnapshot {
  if (sandbox.agent) {
    return inspectAgentMcpSourcesForAgent(sandbox, loadAgent(sandbox.agent), runtimeSelection);
  }
  const candidates = ["openclaw", "hermes", "langchain-deepagents-code"]
    .map((name) => loadAgent(name))
    .filter((agent) => agent.mcpCapability.support === "bridge" && agent.mcpCapability.adapter)
    .map((agent) => ({
      agent,
      sources: inspectAgentMcpSourcesForAgent(sandbox, agent, runtimeSelection),
    }))
    .filter(
      ({ sources }) =>
        Object.keys(sources.native).length > 0 || Object.keys(sources.legacy).length > 0,
    );
  if (candidates.length > 1) {
    throw new McpBridgeError(
      `Sandbox '${sandbox.name}' exposes MCP configuration for multiple agents (${candidates.map(({ agent }) => agent.name).join(", ")}). Select or repair its agent identity before mutation.`,
    );
  }
  const detected = candidates[0];
  if (!detected) return { native: {}, legacy: {} };
  sandbox.agent = detected.agent.name;
  return detected.sources;
}

function inspectAgentMcpSourcesForAgent(
  sandbox: SandboxEntry,
  agent: ReturnType<typeof loadAgent>,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): AgentMcpSourceSnapshot {
  const adapter = agent.mcpCapability.adapter;
  if (agent.mcpCapability.support !== "bridge" || !adapter) return { native: {}, legacy: {} };
  const result = executeSandboxCommand(
    sandbox.name,
    sourceCommand(adapter, agent.configPaths.dir),
    {
      runtimeSelection,
    },
  );
  if (!result) throw new McpBridgeError(`Sandbox '${sandbox.name}' is unreachable.`);
  if (result.status !== 0) {
    throw new McpBridgeError(
      `Could not inspect ${agent.displayName} MCP configuration: ${result.stderr.trim() || "source read failed"}`,
    );
  }
  const native: Record<string, McpSourceEntry> = {};
  const legacy: Record<string, McpSourceEntry> = {};
  for (const record of parseSourceRecords(result.stdout)) {
    const entry = entryFromRecord(record, agent.name, adapter);
    if (!entry) continue;
    (record.source === "native" ? native : legacy)[entry.server] = entry;
  }
  return { native, legacy };
}

function policyEntryForServer(
  policyDocument: string,
  server: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = YAML.parse(policyDocument);
  } catch {
    return null;
  }
  if (!isObjectRecord(parsed) || !isObjectRecord(parsed.network_policies)) return null;
  const value = parsed.network_policies[buildMcpBridgePolicyKey(server)];
  return isObjectRecord(value) ? value : null;
}

function enrichFromPolicy(
  entry: McpSourceEntry,
  policy: Record<string, unknown> | null,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): McpSourceEntry {
  const {
    providerName: _legacyProviderName,
    providerId: _legacyProviderId,
    allowedIps: _legacyAllowedIps,
    trustedPrivateHost: _legacyTrustedPrivateHost,
    ...sourceEntry
  } = entry;
  if (!policy || !Array.isArray(policy.endpoints)) return sourceEntry;
  const endpoints = policy.endpoints.filter(isObjectRecord);
  const endpoint = endpoints.find((candidate) => candidate.protocol === "mcp");
  if (!endpoint) return sourceEntry;
  const allowedIps = Array.isArray(endpoint.allowed_ips)
    ? endpoint.allowed_ips.filter((value): value is string => typeof value === "string")
    : undefined;
  const binding = isObjectRecord(endpoint.credential_binding)
    ? endpoint.credential_binding.provider
    : undefined;
  const providerName = typeof binding === "string" && binding ? binding : undefined;
  const provider = inspectMcpProvider(providerName, runtimeSelection);
  const host = typeof endpoint.host === "string" ? endpoint.host.toLowerCase() : "";
  const sourceUrl = new URL(entry.url);
  const sourcePort = Number.parseInt(
    sourceUrl.port || (sourceUrl.protocol === "https:" ? "443" : "80"),
    10,
  );
  const sourcePath = sourceUrl.pathname || "/";
  const policyConflict =
    host !== sourceUrl.hostname.toLowerCase() ||
    endpoint.port !== sourcePort ||
    endpoint.path !== sourcePath
      ? `Agent URL '${entry.url}' differs from live policy endpoint '${host}:${String(endpoint.port ?? "unknown")}${String(endpoint.path ?? "")}'.`
      : undefined;
  const trustedPrivateHost =
    allowedIps?.some((address) => isBlockedMcpUrlTargetHost(address)) &&
    host === new URL(entry.url).hostname.toLowerCase()
      ? host
      : undefined;
  return {
    ...sourceEntry,
    ...(allowedIps && allowedIps.length > 0 ? { allowedIps } : {}),
    ...(trustedPrivateHost ? { trustedPrivateHost } : {}),
    ...(providerName ? { providerName } : {}),
    ...(provider.exists === true && provider.id ? { providerId: provider.id } : {}),
    ...(policyConflict ? { policyConflict } : {}),
  };
}

export function joinMcpEntriesToOpenShell(
  sandbox: SandboxEntry,
  entries: Readonly<Record<string, McpSourceEntry>>,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  operation = "inspect current MCP source state",
): Record<string, McpSourceEntry> {
  const policyDocument = captureRecordedSandboxBasePolicy(
    sandbox.name,
    operation,
    runtimeSelection,
  );
  return Object.fromEntries(
    Object.entries(entries).map(([server, entry]) => [
      server,
      enrichFromPolicy(entry, policyEntryForServer(policyDocument, server), runtimeSelection),
    ]),
  );
}

export function inspectPolicyOnlyMcpEntry(
  sandbox: SandboxEntry,
  server: string,
  agentName: string,
  adapter: AgentMcpAdapter,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): McpSourceEntry | null {
  const policyDocument = captureRecordedSandboxBasePolicy(
    sandbox.name,
    "inspect orphaned MCP policy state",
    runtimeSelection,
  );
  const policy = policyEntryForServer(policyDocument, server);
  if (!policy || !Array.isArray(policy.endpoints)) return null;
  const endpoint = policy.endpoints
    .filter(isObjectRecord)
    .find((value) => value.protocol === "mcp");
  if (!endpoint || typeof endpoint.host !== "string") return null;
  const port =
    typeof endpoint.port === "number" && Number.isSafeInteger(endpoint.port) ? endpoint.port : 443;
  const pathValue =
    typeof endpoint.path === "string" && endpoint.path.startsWith("/") ? endpoint.path : "/";
  let url: string;
  try {
    url = new URL(
      `https://${endpoint.host}${port === 443 ? "" : `:${String(port)}`}${pathValue}`,
    ).toString();
  } catch {
    return null;
  }
  const binding = isObjectRecord(endpoint.credential_binding)
    ? endpoint.credential_binding.provider
    : undefined;
  const providerName = typeof binding === "string" && binding ? binding : undefined;
  const provider = inspectMcpProvider(providerName, runtimeSelection);
  const env =
    provider.exists === true && provider.credentialKeys?.length === 1
      ? [provider.credentialKeys[0]]
      : [];
  return enrichFromPolicy(
    {
      server,
      agent: agentName,
      adapter,
      url,
      env,
      policyName: buildMcpBridgePolicyName(server),
      source: "policy",
    },
    policy,
    runtimeSelection,
  );
}

export function inspectSourceBridgeState(
  sandbox: SandboxEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): { bridges: Record<string, McpSourceEntry>; sources: AgentMcpSourceSnapshot } {
  const sources = inspectAgentMcpSources(sandbox, runtimeSelection);
  const bridges = joinMcpEntriesToOpenShell(sandbox, sources.native, runtimeSelection);
  return { bridges, sources };
}

export function inspectLegacyBridgeState(
  sandbox: SandboxEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): { bridges: Record<string, McpSourceEntry>; sources: AgentMcpSourceSnapshot } {
  const sources = inspectAgentMcpSources(sandbox, runtimeSelection);
  const bridges = joinMcpEntriesToOpenShell(
    sandbox,
    sources.legacy,
    runtimeSelection,
    "inspect legacy MCP migration state",
  );
  return { bridges, sources };
}

function deepAgentsLegacyRemovalCommand(configDir: string, server: string): string {
  const configPath = path.posix.join(configDir, ".nemoclaw-mcp.json");
  return [
    "/opt/venv/bin/python3 -I - <<'PY'",
    "import json, os, pathlib, secrets, stat",
    `config_path = pathlib.Path(${sourcePayload(configPath)})`,
    `server = ${sourcePayload(server)}`,
    "flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOFOLLOW",
    "try: fd = os.open(config_path, flags)",
    "except FileNotFoundError: raise SystemExit(0)",
    "try:",
    "    before = os.fstat(fd); linked = os.stat(config_path, follow_symlinks=False)",
    "    if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_nlink != 1 or (before.st_dev, before.st_ino) != (linked.st_dev, linked.st_ino) or before.st_size > 262144: raise ValueError('legacy MCP source is unsafe')",
    "    chunks = []; remaining = before.st_size",
    "    while remaining:",
    "        chunk = os.read(fd, min(65536, remaining))",
    "        if not chunk: break",
    "        chunks.append(chunk); remaining -= len(chunk)",
    "    raw = b''.join(chunks)",
    "finally: os.close(fd)",
    "if remaining: raise ValueError('legacy MCP source read was incomplete')",
    "data = json.loads(raw.decode('utf-8')); servers = data.get('mcpServers') if isinstance(data, dict) else None",
    "if not isinstance(servers, dict) or server not in servers: raise SystemExit(0)",
    "del servers[server]",
    "current = os.stat(config_path, follow_symlinks=False)",
    "if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns, current.st_ctime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns): raise ValueError('legacy MCP source changed before cleanup')",
    "if not servers:",
    "    os.unlink(config_path); raise SystemExit(0)",
    "payload = (json.dumps(data, indent=2, sort_keys=True) + '\\n').encode('utf-8')",
    "temp = config_path.with_name('.nemoclaw-mcp.migrate-' + secrets.token_hex(12)); out = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)",
    "try:",
    "    offset = 0",
    "    while offset < len(payload): offset += os.write(out, payload[offset:])",
    "    os.fsync(out)",
    "finally: os.close(out)",
    "os.replace(temp, config_path)",
    "parent = os.open(config_path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)",
    "try: os.fsync(parent)",
    "finally: os.close(parent)",
    "PY",
  ].join("\n");
}

export function removeLegacyAgentMcpEntry(
  sandbox: SandboxEntry,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  const agent = loadAgent(sandbox.agent || "openclaw");
  const adapter = agent.mcpCapability.adapter;
  let command: string;
  if (adapter === "openclaw-config") {
    const root = path.posix.join(agent.configPaths.dir, "workspace");
    command = ["mcporter", "--root", root, "config", "remove", entry.server]
      .map(quoteMcpBridgeShellArg)
      .join(" ");
  } else if (adapter === "deepagents-config") {
    command = deepAgentsLegacyRemovalCommand(agent.configPaths.dir, entry.server);
  } else {
    return;
  }
  const result = executeSandboxCommand(sandbox.name, command, { runtimeSelection });
  if (!result || result.status !== 0) {
    throw new McpBridgeError(
      `Native MCP migration succeeded for '${entry.server}', but legacy source cleanup failed. Rerun migration after inspecting the legacy agent configuration.`,
    );
  }
}
