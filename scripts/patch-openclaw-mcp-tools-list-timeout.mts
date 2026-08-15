#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const MARKER = "/* nemoclaw MCP tools/list timeout override */";
export const TOOLS_LIST_TIMEOUT_ENV = "NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS";
export const TOOLS_LIST_TIMEOUT_MIN_MS = 1500;
export const TOOLS_LIST_TIMEOUT_MAX_MS = 10_000;
export const SUPPORTED_OPENCLAW_VERSION = "2026.7.1";
const LEGACY_FIXTURE_OPENCLAW_VERSIONS = new Set(["2026.3.11", "2026.4.24"]);

/** Client identity that only the compiled bundle-mcp session runtime carries. */
const TARGET_SIGNATURE = '"openclaw-bundle-mcp"';

const DEFAULT_TIMEOUT_PATTERN = "const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 1500;";

const TIMEOUT_RESOLVER_PATTERN = [
  "function getCatalogListTimeoutMs(rawServer, requestTimeoutMs) {",
  "\tif (bundleMcpCatalogListTimeoutMs !== void 0) return bundleMcpCatalogListTimeoutMs;",
  "\treturn hasConfiguredMcpRequestTimeout(rawServer) ? requestTimeoutMs : BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS;",
  "}",
].join("\n");

const TIMEOUT_RESOLVER_REPLACEMENT = [
  "function getCatalogListTimeoutMs(rawServer, requestTimeoutMs) {",
  "\tif (bundleMcpCatalogListTimeoutMs !== void 0) return bundleMcpCatalogListTimeoutMs;",
  "\tif (NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_OVERRIDE_MS !== void 0) return NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_OVERRIDE_MS;",
  "\treturn hasConfiguredMcpRequestTimeout(rawServer) ? requestTimeoutMs : BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS;",
  "}",
].join("\n");

const UNPATCHED_TARGET_PATTERNS = [TIMEOUT_RESOLVER_PATTERN];
const REQUIRED_PATTERNS = [DEFAULT_TIMEOUT_PATTERN, ...UNPATCHED_TARGET_PATTERNS];
const PATCHED_REQUIRED_PATTERNS = [MARKER, DEFAULT_TIMEOUT_PATTERN, TIMEOUT_RESOLVER_REPLACEMENT];

/**
 * Parses one bounded OpenClaw-only runtime override. The default path stays
 * silent and leaves OpenClaw's server-specific or 1,500 ms fallback selection
 * unchanged.
 */
export const INJECTED_TOOLS_LIST_TIMEOUT_HELPER = [
  "",
  MARKER,
  `const NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV = "${TOOLS_LIST_TIMEOUT_ENV}";`,
  `const NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS = ${TOOLS_LIST_TIMEOUT_MIN_MS};`,
  `const NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS = ${TOOLS_LIST_TIMEOUT_MAX_MS};`,
  "function nemoClawMcpToolsListTimeoutOverrideMs() {",
  '\tif (process.env.OPENSHELL_SANDBOX !== "1") return undefined;',
  "\tconst raw = process.env[NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV];",
  '\tif (raw === undefined || raw === "") return undefined;',
  '\tif (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new Error(NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV + " must be an integer from " + NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS + " to " + NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS + " milliseconds");',
  "\tconst timeoutMs = Number(raw);",
  '\tif (!Number.isSafeInteger(timeoutMs) || timeoutMs < NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS || timeoutMs > NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS) throw new Error(NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_ENV + " must be an integer from " + NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MIN_MS + " to " + NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MAX_MS + " milliseconds");',
  '\tprocess.stderr.write("[nemoclaw] mcp_tools_list_timeout_override_ms=" + timeoutMs + "\\n");',
  "\treturn timeoutMs;",
  "}",
  "const NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_OVERRIDE_MS = nemoClawMcpToolsListTimeoutOverrideMs();",
  "",
].join("\n");

type AppliedPatchStatus = "patched" | "already-patched";

type PatchTextResult = {
  patched: boolean;
  status: AppliedPatchStatus;
  text: string;
};

type PatchRunResult =
  | { status: AppliedPatchStatus; file: string; version: string }
  | { status: "skipped-unsupported-version"; version: string };

function usage(): string {
  return "Usage: patch-openclaw-mcp-tools-list-timeout.mts [--audit] <openclaw-dist-dir>";
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function readOpenClawVersion(distDir: string): string {
  const packageJsonPath = path.resolve(distDir, "..", "package.json");
  let payload: { version?: unknown };
  try {
    payload = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Could not read OpenClaw package metadata at ${packageJsonPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (typeof payload.version !== "string") {
    throw new Error(`OpenClaw package metadata missing string version at ${packageJsonPath}`);
  }
  return payload.version;
}

function listJsFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Could not read OpenClaw dist directory ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
  }
  return files.sort();
}

/** Fail closed when the reviewed catalog-timeout boundary changes. */
export function patchMcpToolsListTimeoutText(source: string, filePath: string): PatchTextResult {
  if (source.includes(MARKER)) {
    for (const pattern of PATCHED_REQUIRED_PATTERNS) {
      const count = countOccurrences(source, pattern);
      if (count !== 1) {
        throw new Error(
          `${filePath}: MCP tools/list timeout patch is partial or ambiguous; expected exactly one patched target, found ${count}`,
        );
      }
    }
    for (const pattern of UNPATCHED_TARGET_PATTERNS) {
      if (source.includes(pattern)) {
        throw new Error(
          `${filePath}: MCP tools/list timeout marker is present but an unpatched target remains`,
        );
      }
    }
    return { patched: false, status: "already-patched", text: source };
  }

  for (const pattern of REQUIRED_PATTERNS) {
    const count = countOccurrences(source, pattern);
    if (count !== 1) {
      throw new Error(
        `${filePath}: expected exactly one reviewed MCP tools/list timeout boundary, found ${count}`,
      );
    }
  }

  const importMatch = source.match(/^(?:import[^\n]*\n)+/);
  if (!importMatch) {
    throw new Error(`${filePath}: bundle-mcp runtime has no import prologue to anchor the helper`);
  }

  let text = `${source.slice(0, importMatch[0].length)}${INJECTED_TOOLS_LIST_TIMEOUT_HELPER}${source.slice(
    importMatch[0].length,
  )}`;
  text = text.replace(TIMEOUT_RESOLVER_PATTERN, TIMEOUT_RESOLVER_REPLACEMENT);

  for (const pattern of PATCHED_REQUIRED_PATTERNS) {
    const count = countOccurrences(text, pattern);
    if (count !== 1) {
      throw new Error(
        `${filePath}: MCP tools/list timeout patch verification failed; expected exactly one patched target, found ${count}`,
      );
    }
  }
  return { patched: true, status: "patched", text };
}

function resolveBundleMcpRuntimeFile(distDir: string): string {
  const targets = listJsFiles(distDir).filter((file) =>
    fs.readFileSync(file, "utf-8").includes(TARGET_SIGNATURE),
  );
  if (targets.length !== 1) {
    throw new Error(
      `Expected exactly one OpenClaw bundle-mcp runtime in ${distDir}, found ${targets.length}`,
    );
  }
  return targets[0];
}

export function patchOpenClawMcpToolsListTimeout(distDir: string): PatchRunResult {
  const resolvedDist = path.resolve(distDir);
  const version = readOpenClawVersion(resolvedDist);
  if (version !== SUPPORTED_OPENCLAW_VERSION) {
    if (LEGACY_FIXTURE_OPENCLAW_VERSIONS.has(version)) {
      return { status: "skipped-unsupported-version", version };
    }
    throw new Error(
      `OpenClaw ${version} is not reviewed for the MCP tools/list timeout compatibility patch`,
    );
  }
  const target = resolveBundleMcpRuntimeFile(resolvedDist);
  const result = patchMcpToolsListTimeoutText(fs.readFileSync(target, "utf-8"), target);
  if (result.patched) fs.writeFileSync(target, result.text);
  return { status: result.status, file: target, version };
}

export function auditOpenClawMcpToolsListTimeout(distDir: string): {
  file: string;
  version: string;
} {
  const resolvedDist = path.resolve(distDir);
  const version = readOpenClawVersion(resolvedDist);
  const target = resolveBundleMcpRuntimeFile(resolvedDist);
  const source = fs.readFileSync(target, "utf-8");
  if (!source.includes(MARKER)) {
    throw new Error(`${target}: MCP tools/list timeout patch is not applied`);
  }
  const result = patchMcpToolsListTimeoutText(source, target);
  if (result.status !== "already-patched") {
    throw new Error(
      `${target}: MCP tools/list timeout audit unexpectedly produced a new patch state`,
    );
  }
  return { file: target, version };
}

function main(argv: readonly string[]): number {
  const args = argv.slice(2);
  const audit = args[0] === "--audit";
  const distDir = audit ? args[1] : args[0];
  if (!distDir || args.length > (audit ? 2 : 1)) {
    console.error(usage());
    return 2;
  }
  try {
    if (audit) {
      const result = auditOpenClawMcpToolsListTimeout(distDir);
      console.log(
        `INFO: OpenClaw MCP tools/list timeout audit ok: ${result.file} (openclaw ${result.version})`,
      );
      return 0;
    }
    const result = patchOpenClawMcpToolsListTimeout(distDir);
    if (result.status === "skipped-unsupported-version") {
      console.log(
        `INFO: OpenClaw MCP tools/list timeout skipped for unsupported legacy fixture version ${result.version}`,
      );
    } else {
      console.log(
        `INFO: OpenClaw MCP tools/list timeout ${result.status}: ${result.file} (openclaw ${result.version})`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = main(process.argv);
}
