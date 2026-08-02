#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const MARKER = "/* nemoclaw mcp transient startup recovery (#7958) */";

/** Client identity that only the compiled bundle-mcp session runtime carries. */
const TARGET_SIGNATURE = '"openclaw-bundle-mcp"';

const TASK_OPEN_PATTERN =
  "\t\t\t\t\ttasks: preparedEntries.map(({ serverName, rawServer, resolved, safeServerName }) => async () => {";
const TASK_CLOSE_PATTERN = [
  "\t\t\t\t\t}),",
  "\t\t\t\t\tlimit: BUNDLE_MCP_CATALOG_CONNECT_CONCURRENCY,",
].join("\n");
const START_FAILURE_RETURN_PATTERN = [
  "\t\t\t\t\t\t\treturn {",
  "\t\t\t\t\t\t\t\tserverName,",
  "\t\t\t\t\t\t\t\tserverEntry: null,",
  "\t\t\t\t\t\t\t\ttoolEntries: [],",
  "\t\t\t\t\t\t\t\tdiagnostics: diags",
  "\t\t\t\t\t\t\t};",
].join("\n");
const ACQUIRE_LEASE_PATTERN = ["\t\tacquireLease() {", "\t\t\tactiveLeases += 1;"].join("\n");
const TRANSPORT_FACTORY_PATTERN = "function resolveMcpTransport(serverName, rawServer) {";
const LOG_WARN_PATTERN = "logWarn(";

/** Anchors this patch rewrites; each must appear exactly once before patching. */
const UNPATCHED_TARGET_PATTERNS = [
  TASK_OPEN_PATTERN,
  TASK_CLOSE_PATTERN,
  START_FAILURE_RETURN_PATTERN,
  ACQUIRE_LEASE_PATTERN,
];
/** Anchors this patch only reads; the retry reuses the upstream transport factory. */
const REQUIRED_PATTERNS = [...UNPATCHED_TARGET_PATTERNS, TRANSPORT_FACTORY_PATTERN];

const TASK_OPEN_REPLACEMENT = [
  "\t\t\t\t\ttasks: preparedEntries.map(({ serverName, rawServer, resolved, safeServerName }) => nemoClawWithMcpStartRetry({",
  "\t\t\t\t\t\tserverName,",
  "\t\t\t\t\t\tinitialResolved: resolved,",
  "\t\t\t\t\t\tresolveTransport: () => resolveMcpTransport(serverName, rawServer),",
  "\t\t\t\t\t\tattempt: async (resolved) => {",
].join("\n");
const TASK_CLOSE_REPLACEMENT = [
  "\t\t\t\t\t\t}",
  "\t\t\t\t\t})),",
  "\t\t\t\t\tlimit: BUNDLE_MCP_CATALOG_CONNECT_CONCURRENCY,",
].join("\n");
const START_FAILURE_RETURN_REPLACEMENT = [
  "\t\t\t\t\t\t\treturn {",
  "\t\t\t\t\t\t\t\tserverName,",
  "\t\t\t\t\t\t\t\tserverEntry: null,",
  "\t\t\t\t\t\t\t\ttoolEntries: [],",
  "\t\t\t\t\t\t\t\tdiagnostics: diags,",
  "\t\t\t\t\t\t\t\t[NEMOCLAW_MCP_START_FAILURE]: {",
  "\t\t\t\t\t\t\t\t\terror,",
  "\t\t\t\t\t\t\t\t\treusedSession",
  "\t\t\t\t\t\t\t\t}",
  "\t\t\t\t\t\t\t};",
].join("\n");
const ACQUIRE_LEASE_REPLACEMENT = [
  "\t\tacquireLease() {",
  "\t\t\tif (activeLeases === 0 && nemoClawCatalogHasStartDiagnostics(catalog)) catalog = null;",
  "\t\t\tactiveLeases += 1;",
].join("\n");

const PATCHED_REQUIRED_PATTERNS = [
  MARKER,
  TASK_OPEN_REPLACEMENT,
  TASK_CLOSE_REPLACEMENT,
  START_FAILURE_RETURN_REPLACEMENT,
  ACQUIRE_LEASE_REPLACEMENT,
];

/**
 * Injected compatibility runtime for OpenClaw `bundle-mcp`.
 *
 * Retries exactly one classified transient Streamable HTTP server *startup*
 * failure with a fresh transport and bounded jitter, and stops a catalog that
 * carries any server diagnostic from becoming the session's stable catalog. A
 * credential, TLS, policy, or configuration rejection is never retried, and
 * keeps its own diagnostic.
 */
export const INJECTED_START_RETRY_HELPER = [
  MARKER,
  'const NEMOCLAW_MCP_START_FAILURE = Symbol.for("nemoclaw.bundleMcpStartFailure");',
  "const NEMOCLAW_MCP_RETRY_BASE_DELAY_MS = 120;",
  "const NEMOCLAW_MCP_RETRY_JITTER_MS = 180;",
  "const NEMOCLAW_MCP_RETRY_CONNECT_TIMEOUT_MS = 1e4;",
  "const NEMOCLAW_MCP_ERROR_CHAIN_LIMIT = 8;",
  'const NEMOCLAW_MCP_TRANSIENT_DIAGNOSTIC_SUFFIX = " (temporary MCP transport failure; NemoClaw retried this startup once with a fresh transport. Credentials and configuration were not rejected. The server is retried on the next agent run.)";',
  // A refused, unreachable, or unresolvable destination is excluded because an
  // OpenShell L4 policy denial reaches the client as a refused connection.
  // Retrying refusals could therefore repeat a policy denial, so only in-flight
  // transport faults after a reachable connect are transient.
  "const NEMOCLAW_MCP_TRANSIENT_CODES = new Set([",
  '\t"ECONNABORTED",',
  '\t"ECONNRESET",',
  '\t"ENETRESET",',
  '\t"EPIPE",',
  '\t"ERR_STREAM_PREMATURE_CLOSE",',
  '\t"ETIMEDOUT",',
  '\t"UND_ERR_BODY_TIMEOUT",',
  '\t"UND_ERR_CONNECT_TIMEOUT",',
  '\t"UND_ERR_HEADERS_TIMEOUT",',
  '\t"UND_ERR_SOCKET"',
  "]);",
  "const NEMOCLAW_MCP_BLOCKED_CODE_PATTERN = /^(?:CERT_|DEPTH_ZERO|EPROTO|ERR_INVALID_URL|ERR_SSL|ERR_TLS|SELF_SIGNED|UNABLE_TO_)/;",
  "const NEMOCLAW_MCP_BLOCKED_TEXT_PATTERN = /\\bunauthorized\\b|\\bforbidden\\b|invalid[_ ](?:client|grant|token)|\\bcertificate\\b|self[- ]signed|\\btls\\b|\\bssrf\\b|blocked by|not allowed|\\bdenied\\b|\\bhttp 4\\d\\d\\b/i;",
  // `TypeError: fetch failed` is deliberately absent. undici reports every
  // failure that way, including refused, unreachable, and TLS-rejected
  // destinations, so classification reads the cause chain instead.
  "const NEMOCLAW_MCP_TRANSIENT_TEXT_PATTERN = /socket hang up|other side closed|premature close|before headers|connection reset|request timed out|-32001|mcp server connection timed out after \\d+ms/i;",
  "function nemoClawMcpErrorChain(error) {",
  "\tconst chain = [];",
  "\tlet current = error;",
  "\tfor (let depth = 0; depth < NEMOCLAW_MCP_ERROR_CHAIN_LIMIT && current; depth += 1) {",
  '\t\tif (typeof current !== "object" && typeof current !== "string") break;',
  "\t\tchain.push(current);",
  '\t\tcurrent = typeof current === "object" ? current.cause : void 0;',
  "\t}",
  "\tif (current !== void 0 && current !== null) return [];",
  "\treturn chain;",
  "}",
  "function nemoClawMcpErrorText(entry) {",
  '\tif (typeof entry === "string") return entry;',
  '\tconst name = typeof entry.name === "string" ? entry.name : "";',
  '\tconst message = typeof entry.message === "string" ? entry.message : "";',
  "\treturn `${name} ${message}`;",
  "}",
  "function nemoClawMcpErrorCodes(entry) {",
  '\tif (typeof entry !== "object") return [];',
  '\treturn [entry.code, entry.errno].filter((value) => typeof value === "string");',
  "}",
  "function nemoClawIsTransientMcpStartFailure(error) {",
  "\tconst chain = nemoClawMcpErrorChain(error);",
  "\tif (chain.length === 0) return false;",
  "\tfor (const entry of chain) {",
  "\t\tfor (const code of nemoClawMcpErrorCodes(entry)) {",
  "\t\t\tif (NEMOCLAW_MCP_BLOCKED_CODE_PATTERN.test(code)) return false;",
  "\t\t}",
  "\t\tif (NEMOCLAW_MCP_BLOCKED_TEXT_PATTERN.test(nemoClawMcpErrorText(entry))) return false;",
  "\t}",
  "\tfor (const entry of chain) {",
  '\t\tif (typeof entry === "object" && entry.code === -32001) return true;',
  "\t\tfor (const code of nemoClawMcpErrorCodes(entry)) {",
  "\t\t\tif (NEMOCLAW_MCP_TRANSIENT_CODES.has(code)) return true;",
  "\t\t}",
  "\t\tif (NEMOCLAW_MCP_TRANSIENT_TEXT_PATTERN.test(nemoClawMcpErrorText(entry))) return true;",
  "\t}",
  "\treturn false;",
  "}",
  "function nemoClawMcpRetryDelay() {",
  "\tconst delayMs = NEMOCLAW_MCP_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * NEMOCLAW_MCP_RETRY_JITTER_MS);",
  "\treturn new Promise((resolve) => setTimeout(resolve, delayMs));",
  "}",
  // The suffix is the user-facing attribution for an exhausted retry. Add it
  // only when the surviving failure is itself transient, so a retry that lands
  // on a real 401, TLS, or policy rejection keeps its own diagnostic instead of
  // claiming that credentials were not rejected.
  "function nemoClawFinalizeMcpStartResult(result, retried) {",
  '\tif (!result || typeof result !== "object") return result;',
  "\tconst failure = result[NEMOCLAW_MCP_START_FAILURE];",
  "\tif (!failure) return result;",
  "\tconst next = { ...result };",
  "\tdelete next[NEMOCLAW_MCP_START_FAILURE];",
  "\tconst transient = retried && nemoClawIsTransientMcpStartFailure(failure.error);",
  "\tif (transient && Array.isArray(next.diagnostics)) next.diagnostics = next.diagnostics.map((diagnostic) => ({",
  "\t\t...diagnostic,",
  "\t\tmessage: `${diagnostic.message}${NEMOCLAW_MCP_TRANSIENT_DIAGNOSTIC_SUFFIX}`",
  "\t}));",
  "\treturn next;",
  "}",
  "function nemoClawWithMcpStartRetry(params) {",
  "\treturn async () => {",
  "\t\tconst first = await params.attempt(params.initialResolved);",
  '\t\tconst failure = first && typeof first === "object" ? first[NEMOCLAW_MCP_START_FAILURE] : void 0;',
  "\t\tif (!failure || failure.reusedSession) return nemoClawFinalizeMcpStartResult(first, false);",
  '\t\tif (params.initialResolved.transportType !== "streamable-http") return nemoClawFinalizeMcpStartResult(first, false);',
  "\t\tif (!nemoClawIsTransientMcpStartFailure(failure.error)) return nemoClawFinalizeMcpStartResult(first, false);",
  "\t\tlet retryResolved;",
  "\t\ttry {",
  "\t\t\tretryResolved = params.resolveTransport();",
  "\t\t} catch {",
  "\t\t\tretryResolved = null;",
  "\t\t}",
  "\t\tif (!retryResolved) return nemoClawFinalizeMcpStartResult(first, false);",
  '\t\tlogWarn(`bundle-mcp: retrying transient startup failure for server "${params.serverName}" once with a fresh transport.`);',
  "\t\tawait nemoClawMcpRetryDelay();",
  "\t\tconst second = await params.attempt({",
  "\t\t\t...retryResolved,",
  "\t\t\tconnectionTimeoutMs: Math.min(retryResolved.connectionTimeoutMs, NEMOCLAW_MCP_RETRY_CONNECT_TIMEOUT_MS)",
  "\t\t});",
  "\t\treturn nemoClawFinalizeMcpStartResult(second, true);",
  "\t};",
  "}",
  // A catalog carrying any server diagnostic is degraded, so it must not become
  // the session's stable catalog. Upstream fills `catalog.diagnostics` only from
  // a per-server start or refresh failure and omits the key entirely when no
  // server produced a diagnostic.
  "function nemoClawCatalogHasStartDiagnostics(catalog) {",
  "\tif (!catalog || !Array.isArray(catalog.diagnostics)) return false;",
  "\treturn catalog.diagnostics.length > 0;",
  "}",
  "",
].join("\n");

type PatchStatus = "already-patched" | "patched";

type PatchTextResult = {
  readonly patched: boolean;
  readonly status: PatchStatus;
  readonly text: string;
};

function usage(): string {
  return "Usage: patch-openclaw-mcp-reliability.mts [--audit] <openclaw-dist-dir>";
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

/** Fail closed: a recognized bundle-mcp runtime must expose every patch anchor exactly once. */
export function patchBundleMcpRuntimeText(source: string, filePath: string): PatchTextResult {
  if (source.includes(MARKER)) {
    for (const pattern of PATCHED_REQUIRED_PATTERNS) {
      const count = countOccurrences(source, pattern);
      if (count !== 1) {
        throw new Error(
          `${filePath}: MCP startup recovery patch is partial or ambiguous; expected exactly one patched target, found ${count}`,
        );
      }
    }
    for (const pattern of UNPATCHED_TARGET_PATTERNS) {
      if (source.includes(pattern)) {
        throw new Error(
          `${filePath}: MCP startup recovery marker is present but an unpatched target remains`,
        );
      }
    }
    return { patched: false, status: "already-patched", text: source };
  }

  if (!source.includes(LOG_WARN_PATTERN)) {
    throw new Error(`${filePath}: bundle-mcp runtime lacks the expected logWarn diagnostic helper`);
  }
  for (const pattern of REQUIRED_PATTERNS) {
    const count = countOccurrences(source, pattern);
    if (count !== 1) {
      throw new Error(
        `${filePath}: expected exactly one MCP startup recovery target, found ${count}`,
      );
    }
  }

  const importMatch = source.match(/^(?:import[^\n]*\n)+/);
  if (!importMatch) {
    throw new Error(`${filePath}: bundle-mcp runtime has no import prologue to anchor the helper`);
  }

  let text = `${source.slice(0, importMatch[0].length)}${INJECTED_START_RETRY_HELPER}${source.slice(
    importMatch[0].length,
  )}`;
  text = text.replace(TASK_OPEN_PATTERN, TASK_OPEN_REPLACEMENT);
  text = text.replace(TASK_CLOSE_PATTERN, TASK_CLOSE_REPLACEMENT);
  text = text.replace(START_FAILURE_RETURN_PATTERN, START_FAILURE_RETURN_REPLACEMENT);
  text = text.replace(ACQUIRE_LEASE_PATTERN, ACQUIRE_LEASE_REPLACEMENT);

  for (const pattern of PATCHED_REQUIRED_PATTERNS) {
    const count = countOccurrences(text, pattern);
    if (count !== 1) {
      throw new Error(
        `${filePath}: MCP startup recovery patch verification failed; expected exactly one patched target, found ${count}`,
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

export function patchOpenClawMcpReliability(distDir: string): {
  status: PatchStatus;
  file: string;
  version: string;
} {
  const resolvedDist = path.resolve(distDir);
  const version = readOpenClawVersion(resolvedDist);
  const target = resolveBundleMcpRuntimeFile(resolvedDist);
  const result = patchBundleMcpRuntimeText(fs.readFileSync(target, "utf-8"), target);
  if (result.patched) fs.writeFileSync(target, result.text);
  return { status: result.status, file: target, version };
}

export function auditOpenClawMcpReliability(distDir: string): { file: string; version: string } {
  const resolvedDist = path.resolve(distDir);
  const version = readOpenClawVersion(resolvedDist);
  const target = resolveBundleMcpRuntimeFile(resolvedDist);
  const source = fs.readFileSync(target, "utf-8");
  if (!source.includes(MARKER)) {
    throw new Error(`${target}: MCP startup recovery patch is not applied`);
  }
  const result = patchBundleMcpRuntimeText(source, target);
  if (result.status !== "already-patched") {
    throw new Error(`${target}: MCP startup recovery patch state is not stable`);
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
      const result = auditOpenClawMcpReliability(distDir);
      console.log(
        `INFO: OpenClaw MCP startup recovery audit ok: ${result.file} (openclaw ${result.version})`,
      );
      return 0;
    }
    const result = patchOpenClawMcpReliability(distDir);
    console.log(
      `INFO: OpenClaw MCP startup recovery ${result.status}: ${result.file} (openclaw ${result.version})`,
    );
    return 0;
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  process.exitCode = main(process.argv);
}
