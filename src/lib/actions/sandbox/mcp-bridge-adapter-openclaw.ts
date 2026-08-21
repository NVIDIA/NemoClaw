// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { McpBridgeEntry } from "../../state/registry";
import {
  type AdapterMutationOptions,
  type AdapterRegistrationInspection,
  inspectAdapterRegistrationCommand,
} from "./mcp-bridge-adapter-inspection";
import {
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
import { getAgentConfigDir } from "./mcp-bridge-state";
import { executeSandboxCommand } from "./process-recovery";

export const MCPORTER_VERSION = "0.7.3";
export { OPENCLAW_MCPORTER_ROOT } from "./mcp-bridge-adapter-status";

/** Resolve the Mcporter project root owned by an MCP bridge entry's agent. */
function mcporterRootForEntry(entry: McpBridgeEntry): string {
  return entry.agent
    ? openClawMcporterRoot(getAgentConfigDir(entry.agent, DEFAULT_OPENCLAW_CONFIG_DIR))
    : OPENCLAW_MCPORTER_ROOT;
}

function ensureMcporter(sandboxName: string): void {
  const check = executeSandboxCommand(sandboxName, "command -v mcporter");
  if (check?.status === 0 && check.stdout.trim()) return;
  throw new McpBridgeError(
    `mcporter is not available in sandbox '${sandboxName}'. Rebuild with a NemoClaw image that includes mcporter@${MCPORTER_VERSION}.`,
  );
}

export function buildOpenClawMcporterRegisterCommand(
  entry: McpBridgeEntry,
  replaceExisting = false,
  root = OPENCLAW_MCPORTER_ROOT,
): string {
  const payload = {
    root,
    server: entry.server,
    url: entry.url,
    envName: entry.env[0] ?? "",
    replaceExisting,
  };
  return [
    "node - <<'NODE'",
    'const { spawnSync } = require("node:child_process");',
    `const payload = JSON.parse(${pythonJsonLiteral(payload)});`,
    'const run = (args) => spawnSync("mcporter", args, { encoding: "utf8" });',
    "if (!payload.replaceExisting) {",
    '  const existing = run(["--root", payload.root, "config", "get", payload.server, "--json"]);',
    "  if (existing.error) { console.error(existing.error.message); process.exit(3); }",
    "  if (existing.status === 0) {",
    "    console.error(`MCP server '${payload.server}' already exists in mcporter config and is not managed by NemoClaw.`);",
    "    process.exit(2);",
    "  }",
    "}",
    'const args = ["--root", payload.root, "config", "add", payload.server, "--url", payload.url];',
    "if (payload.envName) {",
    '  const runtimePlaceholder = process.env[payload.envName] || "";',
    '  const escapedEnvName = payload.envName.replace(/[.*+?^${}()|[\\]\\\\]/gu, "\\\\$&");',
    '  const expected = new RegExp(`^openshell:resolve:env:(?:v[0-9]{1,20}_)?${escapedEnvName}$`, "u");',
    "  if (!expected.test(runtimePlaceholder)) {",
    "    console.error(`Fresh OpenShell credential placeholder for '${payload.envName}' is unavailable.`);",
    "    process.exit(3);",
    "  }",
    '  args.push("--header", `Authorization=Bearer ${runtimePlaceholder}`);',
    "}",
    'args.push("--scope", "project");',
    "const added = run(args);",
    "if (added.stdout) process.stdout.write(added.stdout);",
    "if (added.stderr) process.stderr.write(added.stderr);",
    "if (added.error) { console.error(added.error.message); process.exit(3); }",
    "process.exit(added.status === null ? 3 : added.status);",
    "NODE",
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
): AdapterRegistrationInspection {
  const root = mcporterRootForEntry(entry);
  return inspectAdapterRegistrationCommand(
    sandboxName,
    entry,
    buildOpenClawMcporterInspectCommand(entry, false, root),
  );
}

export function registerOpenClawAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  replaceExisting = false,
): void {
  ensureMcporter(sandboxName);
  const root = mcporterRootForEntry(entry);
  const result = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterRegisterCommand(entry, replaceExisting, root),
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
    buildOpenClawMcporterInspectCommand(entry, true, root),
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
  options: AdapterMutationOptions = {},
): void {
  const root = mcporterRootForEntry(entry);
  const result = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterRemoveCommand(entry, options.force === true, root),
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
