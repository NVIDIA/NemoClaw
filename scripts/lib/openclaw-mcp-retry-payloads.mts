// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const MARKER = "/* nemoclaw mcp transient startup recovery (#7958) */";

export const ABORTABLE_RETRY_HELPER = `function nemoClawMcpAbortableRetryDelay(signal) {
 signal.throwIfAborted();
 return new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => {
   signal.removeEventListener("abort", abort);
   resolve();
  }, NEMOCLAW_MCP_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * NEMOCLAW_MCP_RETRY_JITTER_MS));
  signal.addEventListener("abort", abort, { once: true });
 });
}
`;

/**
 * Injected compatibility runtime for OpenClaw `bundle-mcp`.
 *
 * Retries exactly one classified transient Streamable HTTP server *startup*
 * failure with a fresh transport and bounded jitter. Legacy layouts also give
 * a tool-capable Streamable HTTP server that returns an empty initial list one
 * idempotent list retry on the established transport. OpenClaw 2026.9.1 uses
 * its newer listAllTools lifecycle instead. The patch also stops a catalog
 * that carries any server diagnostic from becoming the session's stable
 * catalog. A credential, TLS, policy, or configuration rejection is never
 * retried, and keeps its own diagnostic.
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
