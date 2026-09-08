// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import {
  type AdapterMutationOptions,
  type AdapterRegistrationInspection,
  inspectAdapterRegistrationCommand,
} from "./mcp-bridge-adapter-inspection";
import {
  authorizationValue,
  buildOpenClawMcporterInspectCommand,
  DEFAULT_OPENCLAW_CONFIG_DIR,
  entryHeaders,
  mcporterHeaderMatcherSource,
  OPENCLAW_MCPORTER_ROOT,
  openClawMcporterRoot,
  pythonJsonLiteral,
} from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import type { McpProviderInspectionRuntimeSelection } from "./mcp-bridge-provider-inspection";
import type { McpAttachedCredentialRevision } from "./mcp-bridge-provider-readiness";
import { quoteMcpBridgeShellArg } from "./mcp-bridge-runtime-command";
import { getAgentConfigDir } from "./mcp-bridge-state";
import { executeSandboxCommand } from "./process-recovery";

export const MCPORTER_VERSION = "0.7.3";
export { OPENCLAW_MCPORTER_ROOT } from "./mcp-bridge-adapter-status";

/** Build a Mcporter argument vector bound to one project root. */
function mcporterArgs(root: string, ...args: string[]): string[] {
  return ["mcporter", "--root", root, ...args];
}

/** Resolve the Mcporter project root owned by an MCP bridge entry's agent. */
function mcporterRootForEntry(entry: McpBridgeEntry): string {
  return entry.agent
    ? openClawMcporterRoot(getAgentConfigDir(entry.agent, DEFAULT_OPENCLAW_CONFIG_DIR))
    : OPENCLAW_MCPORTER_ROOT;
}

function ensureMcporter(
  sandboxName: string,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): void {
  const check = executeSandboxCommand(sandboxName, "command -v mcporter", { runtimeSelection });
  if (check?.status === 0 && check.stdout.trim()) return;
  throw new McpBridgeError(
    `mcporter is not available in sandbox '${sandboxName}'. Rebuild with a NemoClaw image that includes mcporter@${MCPORTER_VERSION}.`,
  );
}

export function buildOpenClawMcporterRegisterCommand(
  entry: McpBridgeEntry,
  replaceExisting = false,
  root = OPENCLAW_MCPORTER_ROOT,
  credentialRevision?: McpAttachedCredentialRevision,
): string {
  const args = mcporterArgs(root, "config", "add", entry.server, "--url", entry.url);
  const authorization = authorizationValue(entry, credentialRevision);
  if (authorization) args.push("--header", `Authorization=${authorization}`);
  args.push("--scope", "project");
  const addCommand = args.map(quoteMcpBridgeShellArg).join(" ");
  if (replaceExisting) return addCommand;
  const getCommand = mcporterArgs(root, "config", "get", entry.server, "--json")
    .map(quoteMcpBridgeShellArg)
    .join(" ");
  return [
    `if ${getCommand} >/dev/null 2>&1; then`,
    `  echo ${quoteMcpBridgeShellArg(`MCP server '${entry.server}' already exists in mcporter config and is not managed by NemoClaw.`)} >&2`,
    "  exit 2",
    "fi",
    addCommand,
  ].join("\n");
}

export function buildOpenClawMcporterRemoveCommand(
  entry: McpBridgeEntry,
  force = false,
  root = OPENCLAW_MCPORTER_ROOT,
): string {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry),
    force,
    root,
  };
  return [
    "node - <<'NODE'",
    'const { spawnSync } = require("node:child_process");',
    'const os = require("node:os");',
    'const path = require("node:path");',
    `const expected = JSON.parse(${pythonJsonLiteral(payload)});`,
    mcporterHeaderMatcherSource(),
    'const detail = (result) => `${result.stderr || ""}\n${result.stdout || ""}`;',
    "const isAbsent = (result) => result.status !== 0 && /not\\s+found|does\\s+not\\s+exist|unknown\\s+server/i.test(detail(result));",
    "const isMissingConfig = (result, configPath) => result.status !== 0 && /ENOENT: no such file or directory/i.test(detail(result)) && detail(result).includes(configPath);",
    'const projectDir = path.join(expected.root, "config");',
    'const xdgHome = path.isAbsolute(process.env.XDG_CONFIG_HOME || "") ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");',
    'const xdgDir = path.join(xdgHome, "mcporter");',
    'const legacyHomeDir = path.join(os.homedir(), ".mcporter");',
    'const configPaths = [...new Set([projectDir, xdgDir, legacyHomeDir].filter(Boolean).flatMap((dir) => [path.join(dir, "mcporter.json"), path.join(dir, "mcporter.jsonc")]))];',
    "const ownedPaths = [];",
    "for (const configPath of configPaths) {",
    '  const get = spawnSync("mcporter", ["--root", expected.root, "config", "--config", configPath, "get", expected.server, "--json"], { encoding: "utf8" });',
    "  if (get.error) { console.error(get.error.message); process.exit(3); }",
    "  if (isAbsent(get) || isMissingConfig(get, configPath)) continue;",
    "  if (get.status !== 0) { console.error(detail(get).trim()); process.exit(3); }",
    "  let actual = null; try { actual = JSON.parse(get.stdout); } catch {}",
    '  const headers = actual && actual.headers && typeof actual.headers === "object" ? actual.headers : {};',
    '  const registered = !!actual && actual.name === expected.server && actual.transport === "http" && actual.baseUrl === expected.url && mcporterHeadersMatchExpected(headers, expected.headers);',
    "  if (!registered && !expected.force) { console.error(`Refusing to remove modified mcporter MCP server '${expected.server}' from ${configPath}. Use --force to remove it.`); process.exit(2); }",
    "  ownedPaths.push(configPath);",
    "}",
    "for (const configPath of ownedPaths) {",
    '  const remove = spawnSync("mcporter", ["--root", expected.root, "config", "--config", configPath, "remove", expected.server], { encoding: "utf8" });',
    "  if (remove.stdout) process.stdout.write(remove.stdout);",
    "  if (remove.stderr) process.stderr.write(remove.stderr);",
    "  if (remove.error) { console.error(remove.error.message); process.exit(3); }",
    "  if (remove.status !== 0 && !isAbsent(remove)) process.exit(remove.status === null ? 3 : remove.status);",
    "}",
    'const effective = spawnSync("mcporter", ["--root", expected.root, "config", "get", expected.server, "--json"], { encoding: "utf8" });',
    "if (effective.error) { console.error(effective.error.message); process.exit(3); }",
    "if (isAbsent(effective)) process.exit(0);",
    "if (effective.status !== 0) { console.error(detail(effective).trim()); process.exit(3); }",
    "console.error(`mcporter MCP server '${expected.server}' still resolves after managed configuration cleanup.`);",
    "process.exit(2);",
    "NODE",
  ].join("\n");
}

export function inspectOpenClawAdapterRegistration(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
): AdapterRegistrationInspection {
  const root = mcporterRootForEntry(entry);
  return inspectAdapterRegistrationCommand(
    sandboxName,
    entry,
    buildOpenClawMcporterInspectCommand(entry, false, root),
    runtimeSelection,
  );
}

export function registerOpenClawAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  envValues: Record<string, string> = {},
  replaceExisting = false,
  credentialRevision?: McpAttachedCredentialRevision,
): void {
  ensureMcporter(sandboxName, runtimeSelection);
  const root = mcporterRootForEntry(entry);
  const result = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterRegisterCommand(entry, replaceExisting, root, credentialRevision),
    { runtimeSelection },
  );
  const output = redactBridgeSecretsForDisplay(
    [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    envValues,
  );
  if (!result || result.status !== 0) {
    throw new McpBridgeError(output || `mcporter config add failed for '${entry.server}'.`);
  }

  // A zero exit from `config add` proves only that mcporter accepted the
  // command. Re-read the persisted definition before claiming ownership so a
  // changed mcporter normalization/schema cannot commit an entry that differs
  // from the URL and opaque OpenShell placeholder NemoClaw intended.
  const verification = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterInspectCommand(entry, true, root, credentialRevision),
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
      `mcporter config verification failed after adding '${entry.server}'${verificationOutput ? `: ${verificationOutput}` : "."}`,
    );
  }
}

export function unregisterOpenClawAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  runtimeSelection: McpProviderInspectionRuntimeSelection,
  options: AdapterMutationOptions = {},
): void {
  const root = mcporterRootForEntry(entry);
  const result = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterRemoveCommand(entry, options.force === true, root),
    { runtimeSelection },
  );
  const output = redactBridgeSecretsForDisplay(
    [result?.stdout, result?.stderr].filter(Boolean).join("\n").trim(),
    entry,
    options.envValues ?? {},
  );
  if (!result || result.status !== 0) {
    if (options.bestEffort) return;
    throw new McpBridgeError(output || `mcporter config remove failed for '${entry.server}'.`);
  }
}
