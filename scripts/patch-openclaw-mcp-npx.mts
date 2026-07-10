#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = "/* nemoclaw mcp npx normalization (#5120) */";

const STDIOTRANSPORT_CONSTRUCTOR = "new StdioClientTransport(";
const PATCHED_TRANSPORT_CONSTRUCTOR = "new NemoClawMcpStdioClientTransport(";
const TIMEOUT_HINT =
  'Hint: npx MCP servers can wait for package install confirmation; NemoClaw starts npx servers with "-y" to avoid interactive prompts. If this still times out, pre-install the package, warm the npm cache, or ensure the server writes only MCP JSON-RPC to stdout.';
const SECRET_ARG_PATTERN = /(?:token|secret|password|passwd|api[-_]?key|auth|credential)/i;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

type PatchStatus =
  | "already-patched"
  | "native-npx-normalization"
  | "not-target"
  | "patched"
  | "patched-no-timeout";

type PatchTextResult = {
  readonly patched: boolean;
  readonly status: PatchStatus;
  readonly text: string;
};

type OpenClawPatchResult = {
  readonly status: string;
  readonly files: string[];
  readonly patchedCount: number;
};

function usage(): string {
  return "Usage: patch-openclaw-mcp-npx.mts <openclaw-dist-dir>";
}

function commandBasename(command: unknown): string {
  if (typeof command !== "string") return "";
  return command.trim().replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

export function isNpxCommand(command: unknown): boolean {
  const base = commandBasename(command);
  return base === "npx" || base === "npx.cmd" || base === "npx.exe";
}

export function hasNpxYesFlag(args: unknown): boolean {
  return Array.isArray(args) && args.some((arg) => arg === "-y" || arg === "--yes");
}

export function normalizeMcpServerArgs(command: unknown, args: readonly unknown[] = []): unknown[] {
  const normalizedArgs = Array.isArray(args) ? [...args] : [];
  if (!isNpxCommand(command) || hasNpxYesFlag(normalizedArgs)) return normalizedArgs;
  return ["-y", ...normalizedArgs];
}

export function redactMcpArgs(args: readonly unknown[] = []): string[] {
  const result: string[] = [];
  let redactNext = false;
  for (const rawArg of Array.isArray(args) ? args : []) {
    const arg = String(rawArg);
    if (redactNext) {
      result.push("[redacted]");
      redactNext = false;
      continue;
    }
    if (/^--?[^=\s]+=.*/.test(arg) && SECRET_ARG_PATTERN.test(arg.split("=", 1)[0])) {
      result.push(arg.replace(/=.*/, "=[redacted]"));
      continue;
    }
    if (/^--?/.test(arg) && SECRET_ARG_PATTERN.test(arg)) {
      result.push(arg);
      redactNext = true;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function quoteCommandPart(value: unknown): string {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./\\[\]-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

export function formatMcpCommand(command: unknown, args: readonly unknown[] = []): string {
  const commandPart = command ? quoteCommandPart(command) : "<unknown-command>";
  return [commandPart, ...redactMcpArgs(args).map(quoteCommandPart)].join(" ");
}

export function buildMcpTimeoutMessage(
  serverName: unknown,
  command: unknown,
  args: readonly unknown[] = [],
  timeoutMs: string | number = "unknown",
): string {
  const label = typeof serverName === "string" && serverName.trim() ? ` "${serverName}"` : "";
  const display = formatMcpCommand(command, args);
  return `MCP server${label} (${display}) connection timed out after ${timeoutMs}ms. ${TIMEOUT_HINT}`;
}

const INJECTED_TRANSPORT_HELPER = [
  MARKER,
  "function nemoClawIsNpxCommand(command) {",
  '  if (typeof command !== "string") return false;',
  '  const base = command.trim().replace(/\\\\/g, "/").split("/").pop()?.toLowerCase() ?? "";',
  '  return base === "npx" || base === "npx.cmd" || base === "npx.exe";',
  "}",
  "function nemoClawHasNpxYesFlag(args) {",
  '  return Array.isArray(args) && args.some((arg) => arg === "-y" || arg === "--yes");',
  "}",
  "function nemoClawNormalizeMcpServerArgs(command, args = []) {",
  "  const normalizedArgs = Array.isArray(args) ? [...args] : [];",
  "  if (!nemoClawIsNpxCommand(command) || nemoClawHasNpxYesFlag(normalizedArgs)) return normalizedArgs;",
  '  return ["-y", ...normalizedArgs];',
  "}",
  "const nemoClawSecretArgPattern = /(?:token|secret|password|passwd|api[-_]?key|auth|credential)/i;",
  "function nemoClawRedactMcpArgs(args = []) {",
  "  const result = [];",
  "  let redactNext = false;",
  "  for (const rawArg of Array.isArray(args) ? args : []) {",
  "    const arg = String(rawArg);",
  "    if (redactNext) {",
  '      result.push("[redacted]");',
  "      redactNext = false;",
  "      continue;",
  "    }",
  '    if (/^--?[^=\\s]+=.*/.test(arg) && nemoClawSecretArgPattern.test(arg.split("=", 1)[0])) {',
  '      result.push(arg.replace(/=.*/, "=[redacted]"));',
  "      continue;",
  "    }",
  "    if (/^--?/.test(arg) && nemoClawSecretArgPattern.test(arg)) {",
  "      result.push(arg);",
  "      redactNext = true;",
  "      continue;",
  "    }",
  "    result.push(arg);",
  "  }",
  "  return result;",
  "}",
  "function nemoClawQuoteCommandPart(value) {",
  "  const text = String(value);",
  "  if (/^[A-Za-z0-9_@%+=:,./\\\\[\\]-]+$/.test(text)) return text;",
  "  return JSON.stringify(text);",
  "}",
  "function nemoClawFormatMcpCommand(command, args = []) {",
  '  const commandPart = command ? nemoClawQuoteCommandPart(command) : "<unknown-command>";',
  '  return [commandPart, ...nemoClawRedactMcpArgs(args).map(nemoClawQuoteCommandPart)].join(" ");',
  "}",
  "function nemoClawMcpTimeoutMessage(serverName, command, args, timeoutMs) {",
  '  const label = typeof serverName === "string" && serverName.trim() ? ` "${serverName}"` : "";',
  "  return `MCP server${label} (${nemoClawFormatMcpCommand(command, args)}) connection timed out after ${timeoutMs}ms. " +
    TIMEOUT_HINT +
    "`;",
  "}",
  "class NemoClawMcpStdioClientTransport extends StdioClientTransport {",
  "  constructor(params) {",
  '    if (params && typeof params.command === "string") {',
  "      super({",
  "        ...params,",
  "        args: nemoClawNormalizeMcpServerArgs(params.command, params.args)",
  "      });",
  "      return;",
  "    }",
  "    super(params);",
  "  }",
  "}",
  "",
].join("\n");

function listJsFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read OpenClaw dist directory ${dir}: ${message}`);
  }

  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

function insertAfterImports(source: string, insertion: string): string {
  const importMatch = source.match(/^(?:import[^\n]*\n)+/);
  if (!importMatch) return `${insertion}${source}`;
  return `${source.slice(0, importMatch[0].length)}${insertion}${source.slice(importMatch[0].length)}`;
}

function buildTimeoutReplacement(source: string, expression: string, offset: number): string {
  const timeoutExpression = expression.trim();
  const context = source.slice(Math.max(0, offset - 800), offset + 800);
  if (
    /\bserverName\b/.test(context) &&
    /\bserver\b/.test(context) &&
    (context.includes("server.command") || context.includes("server?.command"))
  ) {
    return `nemoClawMcpTimeoutMessage(serverName, server?.command, server?.args, ${timeoutExpression})`;
  }
  if (/\bname\b/.test(context) && /\bcommand\b/.test(context) && /\bargs\b/.test(context)) {
    return `nemoClawMcpTimeoutMessage(name, command, args, ${timeoutExpression})`;
  }
  throw new Error("MCP timeout message shape lacks server name and command context");
}

function patchTimeoutMessages(
  source: string,
  filePath: string,
): { patched: boolean; text: string } {
  if (source.includes(TIMEOUT_HINT)) return { patched: false, text: source };

  let text = source.replace(
    /`MCP server connection timed out after \$\{([^}]+)\}ms`/g,
    (_match: string, expression: string, offset: number) =>
      buildTimeoutReplacement(source, expression, offset),
  );
  text = text.replace(/"MCP server connection timed out after 30000ms"/g, (_match, offset) =>
    buildTimeoutReplacement(source, "30000", offset),
  );
  text = text.replace(/'MCP server connection timed out after 30000ms'/g, (_match, offset) =>
    buildTimeoutReplacement(source, "30000", offset),
  );
  text = text.replace(
    /"MCP server connection timed out after "\.concat\(([^,]+),\s*"ms"\)/g,
    (_match: string, expression: string, offset: number) =>
      buildTimeoutReplacement(source, expression, offset),
  );
  text = text.replace(
    /"MCP server connection timed out after "\s*\+\s*([^+]+?)\s*\+\s*"ms"/g,
    (_match: string, expression: string, offset: number) =>
      buildTimeoutReplacement(source, expression, offset),
  );

  if (
    source.includes("MCP server connection timed out after") &&
    !text.includes("nemoClawMcpTimeoutMessage(")
  ) {
    throw new Error(`${filePath}: MCP timeout message shape not recognized`);
  }

  return { patched: text !== source, text };
}

function hasNativeNpxNormalization(source: string): boolean {
  return (
    source.includes("StdioClientTransport") &&
    source.includes("-y") &&
    source.includes("--yes") &&
    source.includes("npx")
  );
}

export function patchMcpTransportText(source: string, filePath: string): PatchTextResult {
  if (source.includes(MARKER)) {
    if (!source.includes(PATCHED_TRANSPORT_CONSTRUCTOR)) {
      throw new Error(`${filePath}: MCP npx marker is present but patched transport is missing`);
    }
    if (source.includes(STDIOTRANSPORT_CONSTRUCTOR)) {
      throw new Error(`${filePath}: MCP npx marker is present but original transport remains`);
    }
    return { patched: false, text: source, status: "already-patched" };
  }

  if (hasNativeNpxNormalization(source)) {
    return { patched: false, text: source, status: "native-npx-normalization" };
  }

  if (!source.includes(STDIOTRANSPORT_CONSTRUCTOR)) {
    return { patched: false, text: source, status: "not-target" };
  }

  const withTransport = source.replaceAll(
    STDIOTRANSPORT_CONSTRUCTOR,
    PATCHED_TRANSPORT_CONSTRUCTOR,
  );
  if (!withTransport.includes(PATCHED_TRANSPORT_CONSTRUCTOR)) {
    throw new Error(`${filePath}: MCP stdio transport patch verification failed`);
  }

  const timeout = patchTimeoutMessages(withTransport, filePath);
  const text = insertAfterImports(timeout.text, INJECTED_TRANSPORT_HELPER);
  if (!text.includes(MARKER) || text.includes(STDIOTRANSPORT_CONSTRUCTOR)) {
    throw new Error(`${filePath}: MCP npx patch verification failed`);
  }
  return { patched: true, text, status: timeout.patched ? "patched" : "patched-no-timeout" };
}

export function patchOpenClawMcpNpx(distDir: string): OpenClawPatchResult {
  const resolvedDist = path.resolve(distDir);
  const files = listJsFiles(resolvedDist);
  const results: Array<{ file: string; status: PatchStatus; patched: boolean }> = [];

  for (const file of files) {
    const source = fs.readFileSync(file, "utf-8");
    if (
      !source.includes("StdioClientTransport") &&
      !source.includes(MARKER) &&
      !hasNativeNpxNormalization(source)
    ) {
      continue;
    }

    const result = patchMcpTransportText(source, file);
    if (result.status === "not-target") continue;
    if (result.patched) {
      fs.writeFileSync(file, result.text);
    }
    results.push({ file, status: result.status, patched: result.patched });
  }

  if (results.length === 0) {
    throw new Error(`No OpenClaw MCP stdio transport target found in ${resolvedDist}`);
  }

  const patched = results.filter((result) => result.patched);
  const statuses = [...new Set(results.map((result) => result.status))].join(",");
  return {
    status: patched.length > 0 ? statuses : results[0].status,
    files: results.map((result) => result.file),
    patchedCount: patched.length,
  };
}

function main(argv: readonly string[]): number {
  const distDir = argv[2];
  if (!distDir || argv.length > 3) {
    console.error(usage());
    return 2;
  }
  try {
    const result = patchOpenClawMcpNpx(distDir);
    const files = result.files.map((file) => path.basename(file)).join(", ");
    console.log(`INFO: OpenClaw MCP npx normalization ${result.status}: ${files}`);
    return 0;
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = main(process.argv);
}
