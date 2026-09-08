// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { readSandboxConfig, resolveAgentConfig, writeSandboxConfig } from "../../sandbox/config";
import type { ConfigObject } from "../../security/credential-filter";
import type { McpSourceEntry } from "./mcp-bridge-contracts";
import {
  type AdapterMutationOptions,
  type AdapterRegistrationInspection,
  inspectAdapterRegistrationCommand,
} from "./mcp-bridge-adapter-inspection";
import {
  DEFAULT_OPENCLAW_CONFIG_DIR,
  entryHeaders,
  openClawHeadersMatchExpected,
  openClawHeaderMatcherSource,
  OPENCLAW_MCP_CONFIG_DIR,
  openClawConfigDir,
  pythonJsonLiteral,
} from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import type { McpAttachedCredentialRevision } from "./mcp-bridge-provider-readiness";
import { getAgentConfigDir } from "./mcp-bridge-state";
import { executeSandboxCommand, restartSandboxGateway } from "./process-recovery";

export const MCPORTER_VERSION = "0.7.3";
const OPENCLAW_NATIVE_MCP_PLUGIN_ID = "bundle-mcp";
export { OPENCLAW_MCP_CONFIG_DIR } from "./mcp-bridge-adapter-status";

/** Resolve the OpenClaw agent configuration directory. */
function openClawConfigRootForEntry(entry: McpSourceEntry): string {
  return entry.agent
    ? openClawConfigDir(getAgentConfigDir(entry.agent, DEFAULT_OPENCLAW_CONFIG_DIR))
    : OPENCLAW_MCP_CONFIG_DIR;
}

function openClawConfigPath(root: string): string {
  return path.posix.join(root, "openclaw.json");
}

function atomicOpenClawConfigHelpers(): string[] {
  return [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const crypto = require("node:crypto");',
    "const MAX_BYTES = 1048576;",
    "function fingerprint(value) { return value ? [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode, value.nlink, value.uid] : null; }",
    "function readConfig(configPath) {",
    "  let fd; try { fd = fs.openSync(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch (error) { if (error && error.code === 'ENOENT') return { data: {}, identity: null }; throw error; }",
    "  try { const before = fs.fstatSync(fd); const linked = fs.lstatSync(configPath); if (!before.isFile() || !linked.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || before.dev !== linked.dev || before.ino !== linked.ino || before.size > MAX_BYTES) throw new Error('OpenClaw configuration source is unsafe'); const raw = Buffer.alloc(before.size); let count = 0; while (count < raw.length) { const read = fs.readSync(fd, raw, count, raw.length - count, count); if (read === 0) break; count += read; } const after = fs.fstatSync(fd); if (count !== before.size || JSON.stringify(fingerprint(before)) !== JSON.stringify(fingerprint(after))) throw new Error('OpenClaw configuration changed while reading'); const data = before.size === 0 ? {} : JSON.parse(raw.toString('utf8')); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('OpenClaw configuration must be an object'); return { data, identity: fingerprint(before) }; } finally { fs.closeSync(fd); }",
    "}",
    "function writeConfig(configPath, data, identity) {",
    "  const directory = path.dirname(configPath); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });",
    "  let current = null; try { current = fingerprint(fs.lstatSync(configPath)); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }",
    "  if (JSON.stringify(current) !== JSON.stringify(identity)) throw new Error('OpenClaw configuration changed before publication');",
    "  const tempPath = path.join(directory, `.openclaw.json.nemoclaw-${process.pid}-${crypto.randomBytes(12).toString('hex')}`); let fd;",
    "  try { const content = Buffer.from(JSON.stringify(data, null, 2) + '\\n'); fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); let offset = 0; while (offset < content.length) offset += fs.writeSync(fd, content, offset); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; const staged = fs.lstatSync(tempPath); if (!staged.isFile() || staged.uid !== process.getuid() || staged.nlink !== 1 || (staged.mode & 0o777) !== 0o600) throw new Error('OpenClaw staged configuration is unsafe'); fs.renameSync(tempPath, configPath); const dirfd = fs.openSync(directory, fs.constants.O_RDONLY); try { fs.fsyncSync(dirfd); } finally { fs.closeSync(dirfd); } } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(tempPath); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; } }",
    "}",
  ];
}

export function buildStrictOpenClawMcpInspectCommand(
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
    configPath: openClawConfigPath(root),
  };
  return [
    "node - <<'NODE'",
    ...atomicOpenClawConfigHelpers(),
    `const expected = JSON.parse(${pythonJsonLiteral(payload)});`,
    "let actual; try { const current = readConfig(expected.configPath); actual = current.data && current.data.mcp && current.data.mcp.servers && current.data.mcp.servers[expected.server]; } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(3); }",
    "if (!actual) { console.log('absent'); process.exit(0); }",
    'const headers = actual.headers && typeof actual.headers === "object" ? actual.headers : {};',
    openClawHeaderMatcherSource(),
    "const registered = actual.url === expected.url && openClawHeadersMatchExpected(headers, expected.headers);",
    'console.log(registered ? "registered" : "mismatch");',
    "if (!registered && expected.failOnMismatch) process.exit(2);",
    "NODE",
  ].join("\n");
}

export function buildOpenClawMcpRegisterCommand(
  entry: McpSourceEntry,
  replaceExisting = false,
  root = OPENCLAW_MCP_CONFIG_DIR,
  credentialRevision?: McpAttachedCredentialRevision,
): string {
  const headers = entryHeaders(entry, credentialRevision);
  const payload = {
    configPath: openClawConfigPath(root),
    server: entry.server,
    value: { url: entry.url, ...(Object.keys(headers).length > 0 ? { headers } : {}) },
    replaceExisting,
  };
  return [
    "node - <<'NODE'",
    ...atomicOpenClawConfigHelpers(),
    `const payload = JSON.parse(${pythonJsonLiteral(payload)});`,
    "const current = readConfig(payload.configPath);",
    "if (current.data.mcp !== undefined && (!current.data.mcp || typeof current.data.mcp !== 'object' || Array.isArray(current.data.mcp))) throw new Error('OpenClaw mcp configuration must be an object');",
    "const mcp = current.data.mcp || {}; if (mcp.servers !== undefined && (!mcp.servers || typeof mcp.servers !== 'object' || Array.isArray(mcp.servers))) throw new Error('OpenClaw mcp.servers configuration must be an object');",
    'const servers = { ...(mcp.servers || {}) }; if (Object.hasOwn(servers, payload.server) && !payload.replaceExisting) { console.error("MCP server \'" + payload.server + "\' already exists in OpenClaw configuration."); process.exit(2); }',
    "servers[payload.server] = payload.value; current.data.mcp = { ...mcp, servers }; writeConfig(payload.configPath, current.data, current.identity);",
    "NODE",
  ].join("\n");
}

export function buildOpenClawMcpRemoveCommand(
  entry: McpSourceEntry,
  force = false,
  root = OPENCLAW_MCP_CONFIG_DIR,
): string {
  const payload = {
    configPath: openClawConfigPath(root),
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry),
    force,
  };
  return [
    "node - <<'NODE'",
    ...atomicOpenClawConfigHelpers(),
    `const expected = JSON.parse(${pythonJsonLiteral(payload)});`,
    openClawHeaderMatcherSource(),
    "const current = readConfig(expected.configPath); const mcp = current.data.mcp; const servers = mcp && mcp.servers; if (!servers || typeof servers !== 'object' || Array.isArray(servers) || !Object.hasOwn(servers, expected.server)) process.exit(0);",
    'const actual = servers[expected.server]; const exact = actual && typeof actual === "object" && actual.url === expected.url && openClawHeadersMatchExpected(actual.headers || {}, expected.headers || {}); if (!exact && !expected.force) { console.error("Refusing to remove modified OpenClaw MCP server \'" + expected.server + "\'. Use --force to remove it."); process.exit(2); }',
    "delete servers[expected.server]; current.data.mcp = { ...mcp, servers }; writeConfig(expected.configPath, current.data, current.identity);",
    "NODE",
  ].join("\n");
}

export function inspectOpenClawAdapterRegistration(
  sandboxName: string,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): AdapterRegistrationInspection {
  const root = openClawConfigRootForEntry(entry);
  return inspectAdapterRegistrationCommand(
    sandboxName,
    entry,
    buildStrictOpenClawMcpInspectCommand(entry, false, root),
    runtimeSelection,
  );
}

export function registerOpenClawAdapter(
  sandboxName: string,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  envValues: Record<string, string> = {},
  replaceExisting = false,
  credentialRevision?: McpAttachedCredentialRevision,
): void {
  const root = openClawConfigRootForEntry(entry);
  try {
    const target = resolveAgentConfig(sandboxName);
    if (target.agentName !== "openclaw" || target.configPath !== openClawConfigPath(root)) {
      throw new Error("OpenClaw MCP config target does not match the registered agent source");
    }
    const current = readSandboxConfig(sandboxName, target);
    if (
      current.mcp !== undefined &&
      (!current.mcp || typeof current.mcp !== "object" || Array.isArray(current.mcp))
    ) {
      throw new Error("OpenClaw mcp configuration must be an object");
    }
    const mcp = (current.mcp ?? {}) as ConfigObject;
    if (
      mcp.servers !== undefined &&
      (!mcp.servers || typeof mcp.servers !== "object" || Array.isArray(mcp.servers))
    ) {
      throw new Error("OpenClaw mcp.servers configuration must be an object");
    }
    const servers = { ...((mcp.servers ?? {}) as ConfigObject) };
    if (Object.hasOwn(servers, entry.server) && !replaceExisting) {
      throw new Error(`MCP server '${entry.server}' already exists in OpenClaw configuration`);
    }
    const headers = entryHeaders(entry, credentialRevision);
    servers[entry.server] = {
      url: entry.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
    current.mcp = { ...mcp, servers };
    if (
      current.tools !== undefined &&
      (!current.tools || typeof current.tools !== "object" || Array.isArray(current.tools))
    ) {
      throw new Error("OpenClaw tools configuration must be an object");
    }
    const tools = (current.tools ?? {}) as ConfigObject;
    if (
      tools.alsoAllow !== undefined &&
      (!Array.isArray(tools.alsoAllow) ||
        !tools.alsoAllow.every((tool): tool is string => typeof tool === "string"))
    ) {
      throw new Error("OpenClaw tools.alsoAllow configuration must be a string array");
    }
    current.tools = {
      ...tools,
      alsoAllow: [
        ...new Set([...(tools.alsoAllow as string[] | undefined ?? []), OPENCLAW_NATIVE_MCP_PLUGIN_ID]),
      ],
    };
    writeSandboxConfig(sandboxName, target, current);
  } catch (error) {
    const output = redactBridgeSecretsForDisplay(
      error instanceof Error ? error.message : String(error),
      entry,
      envValues,
    );
    throw new McpBridgeError(output || `OpenClaw MCP config add failed for '${entry.server}'.`);
  }

  // Re-read the native definition before reporting success so a raced or
  // normalized write cannot commit an entry that differs from the URL and
  // opaque OpenShell placeholder NemoClaw intended.
  const verification = executeSandboxCommand(
    sandboxName,
    buildStrictOpenClawMcpInspectCommand(entry, true, root, credentialRevision),
    { runtimeSelection },
  );
  const verificationOutput = redactBridgeSecretsForDisplay(
    [verification?.stdout, verification?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    envValues,
  );
  if (
    !verification ||
    verification.status !== 0 ||
    verification.stdout.trim().split(/\r?\n/).at(-1) !== "registered"
  ) {
    throw new McpBridgeError(
      `OpenClaw MCP config verification failed after adding '${entry.server}'${verificationOutput ? `: ${verificationOutput}` : "."}`,
    );
  }
}

/** Make a verified config mutation visible to the long-lived OpenClaw gateway. */
export function reloadOpenClawGatewayAfterMcpMutation(sandboxName: string): void {
  const result = restartSandboxGateway(sandboxName, { quiet: true });
  if (result.ok) return;
  throw new McpBridgeError(
    `OpenClaw gateway did not activate the native MCP configuration (${result.failureLayer}: ${result.detail}).`,
  );
}

export function unregisterOpenClawAdapter(
  sandboxName: string,
  entry: McpSourceEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  options: AdapterMutationOptions = {},
): void {
  const root = openClawConfigRootForEntry(entry);
  try {
    const target = resolveAgentConfig(sandboxName);
    if (target.agentName !== "openclaw" || target.configPath !== openClawConfigPath(root)) {
      throw new Error("OpenClaw MCP config target does not match the registered agent source");
    }
    const current = readSandboxConfig(sandboxName, target);
    const mcp = current.mcp;
    const servers =
      mcp && typeof mcp === "object" && !Array.isArray(mcp)
        ? (mcp as ConfigObject).servers
        : undefined;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
    const entries = { ...(servers as ConfigObject) };
    if (!Object.hasOwn(entries, entry.server)) return;
    const actual = entries[entry.server];
    const actualRecord =
      actual && typeof actual === "object" && !Array.isArray(actual)
        ? (actual as Record<string, unknown>)
        : undefined;
    const headers =
      actualRecord?.headers &&
      typeof actualRecord.headers === "object" &&
      !Array.isArray(actualRecord.headers)
        ? actualRecord.headers
        : {};
    const exact =
      actualRecord?.url === entry.url &&
      openClawHeadersMatchExpected(headers, entryHeaders(entry));
    if (!exact && options.force !== true) {
      throw new Error(
        `Refusing to remove modified OpenClaw MCP server '${entry.server}'. Use --force to remove it.`,
      );
    }
    delete entries[entry.server];
    current.mcp = { ...(mcp as ConfigObject), servers: entries };
    writeSandboxConfig(sandboxName, target, current);
  } catch (error) {
    if (options.bestEffort) return;
    const output = redactBridgeSecretsForDisplay(
      error instanceof Error ? error.message : String(error),
      entry,
      options.envValues ?? {},
    );
    throw new McpBridgeError(output || `OpenClaw MCP config remove failed for '${entry.server}'.`);
  }
}
