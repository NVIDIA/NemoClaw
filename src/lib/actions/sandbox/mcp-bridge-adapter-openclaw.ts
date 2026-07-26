// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { shellQuote } from "../../runner";
import type { McpBridgeEntry } from "../../state/registry";
import {
  type AdapterMutationOptions,
  type AdapterRegistrationInspection,
  inspectAdapterRegistrationCommand,
} from "./mcp-bridge-adapter-inspection";
import {
  authorizationValue,
  buildOpenClawMcporterInspectCommand,
  entryHeaders,
  mcporterHeaderMatcherSource,
  pythonJsonLiteral,
} from "./mcp-bridge-adapter-status";
import { McpBridgeError } from "./mcp-bridge-contracts";
import { redactBridgeSecretsForDisplay } from "./mcp-bridge-output";
import { executeSandboxCommand } from "./process-recovery";

export const MCPORTER_VERSION = "0.7.3";

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
): string {
  const args = ["mcporter", "config", "add", entry.server, "--url", entry.url];
  const authorization = authorizationValue(entry);
  if (authorization) args.push("--header", `Authorization=${authorization}`);
  args.push("--scope", "home");
  const addCommand = args.map(shellQuote).join(" ");
  if (replaceExisting) return addCommand;
  const getCommand = ["mcporter", "config", "get", entry.server, "--json"]
    .map(shellQuote)
    .join(" ");
  return [
    `if ${getCommand} >/dev/null 2>&1; then`,
    `  echo ${shellQuote(`MCP server '${entry.server}' already exists in mcporter config and is not managed by NemoClaw.`)} >&2`,
    "  exit 2",
    "fi",
    addCommand,
  ].join("\n");
}

export function buildOpenClawMcporterRemoveCommand(entry: McpBridgeEntry, force = false): string {
  const payload = {
    server: entry.server,
    url: entry.url,
    headers: entryHeaders(entry),
    force,
  };
  return [
    "node - <<'NODE'",
    'const { spawnSync } = require("node:child_process");',
    `const expected = JSON.parse(${pythonJsonLiteral(payload)});`,
    'const get = spawnSync("mcporter", ["config", "get", expected.server, "--json"], { encoding: "utf8" });',
    "if (get.error) { console.error(get.error.message); process.exit(3); }",
    'const getDetail = `${get.stderr || ""}\n${get.stdout || ""}`;',
    "const absent = get.status !== 0 && /not\\s+found|does\\s+not\\s+exist|unknown\\s+server/i.test(getDetail);",
    "if (absent) process.exit(0);",
    "if (get.status !== 0) { console.error(getDetail.trim()); process.exit(3); }",
    "let actual = null; try { actual = JSON.parse(get.stdout); } catch {}",
    'const headers = actual && actual.headers && typeof actual.headers === "object" ? actual.headers : {};',
    mcporterHeaderMatcherSource(),
    'const registered = !!actual && actual.name === expected.server && actual.transport === "http" && actual.baseUrl === expected.url && mcporterHeadersMatchExpected(headers, expected.headers);',
    "if (!registered && !expected.force) { console.error(`Refusing to remove modified mcporter MCP server '${expected.server}'. Use --force to remove it.`); process.exit(2); }",
    'const remove = spawnSync("mcporter", ["config", "remove", expected.server], { encoding: "utf8" });',
    "if (remove.stdout) process.stdout.write(remove.stdout);",
    "if (remove.stderr) process.stderr.write(remove.stderr);",
    "if (remove.error) { console.error(remove.error.message); process.exit(3); }",
    'const removeDetail = `${remove.stderr || ""}\n${remove.stdout || ""}`;',
    "if (remove.status !== 0 && /not\\s+found|does\\s+not\\s+exist|unknown\\s+server/i.test(removeDetail)) process.exit(0);",
    "process.exit(remove.status === null ? 3 : remove.status);",
    "NODE",
  ].join("\n");
}

export function inspectOpenClawAdapterRegistration(
  sandboxName: string,
  entry: McpBridgeEntry,
): AdapterRegistrationInspection {
  return inspectAdapterRegistrationCommand(
    sandboxName,
    entry,
    buildOpenClawMcporterInspectCommand(entry, false),
  );
}

export function registerOpenClawAdapter(
  sandboxName: string,
  entry: McpBridgeEntry,
  envValues: Record<string, string> = {},
  replaceExisting = false,
): void {
  ensureMcporter(sandboxName);
  const result = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterRegisterCommand(entry, replaceExisting),
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
    buildOpenClawMcporterInspectCommand(entry, true),
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
  const result = executeSandboxCommand(
    sandboxName,
    buildOpenClawMcporterRemoveCommand(entry, options.force === true),
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
