#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const MARKER = "/* nemoclaw managed transport diagnostics (#7957) */";

/** Client identity that only the compiled bundle-mcp session runtime carries. */
const TARGET_SIGNATURE = '"openclaw-bundle-mcp"';

const STREAMABLE_TRANSPORT_PATTERN = [
  '\tif (resolved.transportType === "streamable-http") return {',
  "\t\ttransport: new StreamableHTTPClientTransport(new URL(resolved.url), {",
  '\t\t\trequestInit: resolved.auth === "oauth" || !headers ? void 0 : { headers },',
  "\t\t\tfetch: httpFetch,",
].join("\n");

const STREAMABLE_TRANSPORT_REPLACEMENT = [
  '\tif (resolved.transportType === "streamable-http") return {',
  "\t\ttransport: new StreamableHTTPClientTransport(new URL(resolved.url), {",
  '\t\t\trequestInit: resolved.auth === "oauth" || !headers ? void 0 : { headers },',
  "\t\t\tfetch: nemoClawManagedTransportFetch(httpFetch, resolved.url),",
].join("\n");

const UNPATCHED_TARGET_PATTERNS = [STREAMABLE_TRANSPORT_PATTERN];
const REQUIRED_PATTERNS = [...UNPATCHED_TARGET_PATTERNS];
const PATCHED_REQUIRED_PATTERNS = [MARKER, STREAMABLE_TRANSPORT_REPLACEMENT];

/**
 * Failure-only managed-transport diagnostics for the remote Streamable HTTP MCP
 * fetch boundary. The wrapper never retries, never alters the request, and never
 * reads a 2xx body, so streaming responses stay behaviorally unchanged.
 */
export const INJECTED_DIAGNOSTIC_HELPER = [
  "",
  MARKER,
  'const NEMOCLAW_MTD_EVENT = "managed_transport_failure";',
  "const NEMOCLAW_MTD_BODY_LIMIT = 2048;",
  "const NEMOCLAW_MTD_BODY_TIMEOUT_MS = 250;",
  "const NEMOCLAW_MTD_SAFE_HEADERS = [",
  '\t"content-type",',
  '\t"retry-after",',
  '\t"server",',
  '\t"via",',
  '\t"x-envoy-attempt-count",',
  '\t"x-envoy-decorator-operation",',
  '\t"x-envoy-response-flags",',
  '\t"x-envoy-upstream-service-time",',
  '\t"x-request-id"',
  "];",
  'const NEMOCLAW_MTD_BODY_TYPES = ["application/json", "application/problem+json", "text/html", "text/plain"];',
  'const NEMOCLAW_MTD_TLS_CODES = ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "EPROTO", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_TLS_CERT_ALTNAME_INVALID", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"];',
  'const NEMOCLAW_MTD_CONNECT_CODES = ["EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT"];',
  "const NEMOCLAW_MTD_POLICY_RE = /\\b(?:not permitted by policy|not allowed by (?:any )?policy|blocked by deny rule|denied by L7 policy|request denied by policy)\\b/i;",
  "const NEMOCLAW_MTD_CONNECT_DENIED_RE = /CONNECT tunnel failed,\\s*response (?:403|407)/i;",
  "const NEMOCLAW_MTD_CONNECT_RE = /CONNECT tunnel failed/i;",
  "const NEMOCLAW_MTD_SESSION_RE = /\\b((?:mcp[-_ ]?)?session[-_ ]?id)\\b[\"']?\\s*[:=]?\\s*[\"']?[A-Za-z0-9._~-]{4,}/gi;",
  "const NEMOCLAW_MTD_SECRET_RE = /((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:key|token|secret|credential|password|passwd|pass)|(?:x[-_])?api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|token|secret|credential|password|passwd|pass)[\"']?(?:[ \\t]{0,32}[=:][ \\t]{0,32}|[ \\t]{1,32})[\"']?)[^\\s'\"]+((?:\"|')?)/gi;",
  "const NEMOCLAW_MTD_TOKEN_RE = /(?:nvapi-|nvcf-|ghp_|github_pat_|sk-proj-|sk-ant-|sk-|(?:xox[bpas]|xapp)-|hf_|glpat-|gsk_|pypi-|tvly-|lsv2_(?:pt|sk)_)[A-Za-z0-9_-]{10,}/g;",
  "const NEMOCLAW_MTD_BEARER_RE = /\\bBearer\\s+\\S+/gi;",
  "const NEMOCLAW_MTD_PRINTABLE_RE = /^[\\x20-\\x7e]*$/;",
  "function nemoClawMtdRedact(value, maxLength = 240) {",
  '\tif (typeof value !== "string" || value.length === 0) return undefined;',
  '\tconst redacted = value.slice(0, maxLength + 512).replace(NEMOCLAW_MTD_SESSION_RE, "$1 <REDACTED>").replace(NEMOCLAW_MTD_BEARER_RE, "Bearer <REDACTED>").replace(NEMOCLAW_MTD_SECRET_RE, "$1<REDACTED>$2").replace(NEMOCLAW_MTD_TOKEN_RE, "<REDACTED>").replace(/[\\r\\n\\t]/g, " ");',
  "\tconst bytes = new TextEncoder().encode(redacted);",
  "\treturn new TextDecoder().decode(bytes.subarray(0, maxLength), { stream: true });",
  "}",
  "function nemoClawMtdSafeCode(value) {",
  '\treturn typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_.-]+$/.test(value) ? value : undefined;',
  "}",
  "function nemoClawMtdSafeInteger(value, max) {",
  '\treturn typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= max ? value : undefined;',
  "}",
  "function nemoClawMtdCauseChain(error) {",
  "\tconst chain = [];",
  "\tconst seen = new Set();",
  "\tlet current = error;",
  '\twhile (current && typeof current === "object" && chain.length < 8) {',
  "\t\tif (seen.has(current)) break;",
  "\t\tseen.add(current);",
  "\t\tconst cause = {};",
  "\t\tconst name = nemoClawMtdSafeCode(current.name);",
  "\t\tif (name) cause.name = name;",
  "\t\tconst code = nemoClawMtdSafeCode(current.code);",
  "\t\tif (code) cause.code = code;",
  "\t\tconst errno = nemoClawMtdSafeInteger(current.errno, 4294967295);",
  "\t\tif (errno !== undefined) cause.errno = errno;",
  "\t\tconst syscall = nemoClawMtdSafeCode(current.syscall);",
  "\t\tif (syscall) cause.syscall = syscall;",
  "\t\tconst family = nemoClawMtdSafeInteger(current.family, 255);",
  "\t\tif (family !== undefined) cause.family = family;",
  "\t\tconst port = nemoClawMtdSafeInteger(current.port, 65535);",
  "\t\tif (port !== undefined) cause.port = port;",
  "\t\tconst message = nemoClawMtdRedact(current.message);",
  "\t\tif (message) cause.message = message;",
  "\t\tif (Object.keys(cause).length > 0) chain.push(cause);",
  "\t\tcurrent = current.cause;",
  "\t}",
  "\treturn chain;",
  "}",
  "function nemoClawMtdPhase(chain) {",
  '\tconst text = chain.map((cause) => (cause.code || "") + " " + (cause.message || "")).join(" ");',
  '\tif (NEMOCLAW_MTD_POLICY_RE.test(text) || NEMOCLAW_MTD_CONNECT_DENIED_RE.test(text)) return "policy";',
  '\tif (NEMOCLAW_MTD_CONNECT_RE.test(text)) return "connect";',
  '\tif (chain.some((cause) => NEMOCLAW_MTD_TLS_CODES.includes(cause.code))) return "tls";',
  '\tif (chain.some((cause) => NEMOCLAW_MTD_CONNECT_CODES.includes(cause.code))) return "app_connect";',
  '\tif (chain.some((cause) => cause.code === "UND_ERR_HEADERS_TIMEOUT")) return "response_headers";',
  '\treturn "request";',
  "}",
  "function nemoClawMtdHeaders(response) {",
  "\tconst safe = {};",
  "\tif (!response || !response.headers) return safe;",
  "\tfor (const name of NEMOCLAW_MTD_SAFE_HEADERS) {",
  "\t\tconst value = response.headers.get(name);",
  '\t\tif (typeof value !== "string" || value.length === 0 || value.length > 256) continue;',
  "\t\tif (!NEMOCLAW_MTD_PRINTABLE_RE.test(value)) continue;",
  "\t\tconst redacted = nemoClawMtdRedact(value, 256);",
  '\t\tif (redacted) safe[name.replaceAll("-", "_")] = redacted;',
  "\t}",
  "\treturn safe;",
  "}",
  "async function nemoClawMtdErrorBody(response, contentType) {",
  '\tconst normalized = (contentType || "").split(";")[0].trim().toLowerCase();',
  "\tif (!NEMOCLAW_MTD_BODY_TYPES.includes(normalized)) return undefined;",
  "\tlet timer;",
  "\tlet reader;",
  "\ttry {",
  "\t\tconst body = response.clone().body;",
  "\t\tif (!body) return undefined;",
  "\t\treader = body.getReader();",
  "\t\tconst timeout = new Promise((resolve) => {",
  "\t\t\ttimer = setTimeout(() => resolve(null), NEMOCLAW_MTD_BODY_TIMEOUT_MS);",
  "\t\t\ttimer.unref?.();",
  "\t\t});",
  "\t\tconst decoder = new TextDecoder();",
  "\t\tconst chunks = [];",
  "\t\tlet byteLength = 0;",
  "\t\twhile (byteLength < NEMOCLAW_MTD_BODY_LIMIT) {",
  "\t\t\tconst result = await Promise.race([reader.read(), timeout]);",
  "\t\t\tif (!result) return undefined;",
  "\t\t\tif (result.done) break;",
  "\t\t\tconst remaining = NEMOCLAW_MTD_BODY_LIMIT - byteLength;",
  "\t\t\tconst chunk = result.value.subarray(0, remaining);",
  "\t\t\tchunks.push(decoder.decode(chunk, { stream: true }));",
  "\t\t\tbyteLength += chunk.byteLength;",
  "\t\t}",
  '\t\treturn nemoClawMtdRedact(chunks.join("") + decoder.decode(), NEMOCLAW_MTD_BODY_LIMIT);',
  "\t} catch {",
  "\t\treturn undefined;",
  "\t} finally {",
  "\t\tif (timer) clearTimeout(timer);",
  "\t\tif (reader) void reader.cancel().catch(() => {});",
  "\t}",
  "}",
  "function nemoClawMtdEndpoint(value) {",
  "\ttry {",
  "\t\tconst url = new URL(value);",
  '\t\tif (url.protocol !== "http:" && url.protocol !== "https:") return undefined;',
  '\t\tconst port = url.port || (url.protocol === "http:" ? "80" : "443");',
  '\t\treturn url.hostname + ":" + port;',
  "\t} catch {",
  "\t\treturn undefined;",
  "\t}",
  "}",
  "function nemoClawMtdDiagnosticId() {",
  '\treturn globalThis.crypto.randomUUID().replaceAll("-", "");',
  "}",
  "function nemoClawMtdEmit(fields) {",
  "\tconst lines = [NEMOCLAW_MTD_EVENT];",
  "\tfor (const [key, value] of Object.entries(fields)) {",
  "\t\tif (value === undefined) continue;",
  '\t\tconst encoded = typeof value === "object" || key === "error_body" ? JSON.stringify(value) : String(value);',
  '\t\tlines.push(key + "=" + encoded);',
  "\t}",
  '\tprocess.stderr.write("[nemoclaw] " + lines.join("\\n[nemoclaw] ") + "\\n");',
  "}",
  "async function nemoClawMtdEmitResponseFailure(response, fields) {",
  "\tconst headers = nemoClawMtdHeaders(response);",
  "\tconst errorBody = await nemoClawMtdErrorBody(response, headers.content_type);",
  "\tnemoClawMtdEmit({ ...fields, ...headers, error_body: errorBody });",
  "}",
  "function nemoClawManagedTransportFetch(inner, serverUrl) {",
  '\tif (process.env.OPENSHELL_SANDBOX !== "1") return inner;',
  "\tconst proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;",
  "\treturn async (input, init) => {",
  "\t\tconst startedAt = Date.now();",
  '\t\tconst sessionPresent = Boolean(init && init.headers && new Headers(init.headers).get("mcp-session-id"));',
  "\t\ttry {",
  "\t\t\tconst response = await inner(input, init);",
  "\t\t\tif (response && response.ok) return response;",
  "\t\t\tvoid nemoClawMtdEmitResponseFailure(response, {",
  '\t\t\t\tconsumer: "mcp",',
  '\t\t\t\troute: proxy ? "proxy_configured" : "unknown",',
  "\t\t\t\tproxy: proxy ? nemoClawMtdEndpoint(proxy) : undefined,",
  "\t\t\t\ttarget: nemoClawMtdEndpoint(serverUrl),",
  '\t\t\t\ttransport_phase: "response_headers",',
  "\t\t\t\thttp_status: response ? response.status : undefined,",
  "\t\t\t\telapsed_ms: Date.now() - startedAt,",
  "\t\t\t\tsession_present: sessionPresent,",
  "\t\t\t\tdiagnostic_id: nemoClawMtdDiagnosticId()",
  "\t\t\t}).catch(() => {});",
  "\t\t\treturn response;",
  "\t\t} catch (error) {",
  "\t\t\ttry {",
  "\t\t\t\tconst chain = nemoClawMtdCauseChain(error);",
  "\t\t\t\tnemoClawMtdEmit({",
  '\t\t\t\t\tconsumer: "mcp",',
  '\t\t\t\t\troute: proxy ? "proxy_configured" : "unknown",',
  "\t\t\t\t\tproxy: proxy ? nemoClawMtdEndpoint(proxy) : undefined,",
  "\t\t\t\t\ttarget: nemoClawMtdEndpoint(serverUrl),",
  "\t\t\t\t\ttransport_phase: nemoClawMtdPhase(chain),",
  "\t\t\t\t\telapsed_ms: Date.now() - startedAt,",
  "\t\t\t\t\tcause_code: chain[0] && chain[0].code,",
  "\t\t\t\t\tsession_present: sessionPresent,",
  "\t\t\t\t\tcause_chain: chain,",
  "\t\t\t\t\tdiagnostic_id: nemoClawMtdDiagnosticId()",
  "\t\t\t\t});",
  "\t\t\t} catch {}",
  "\t\t\tthrow error;",
  "\t\t}",
  "\t};",
  "}",
  "",
].join("\n");

type PatchStatus = "patched" | "already-patched";

type PatchTextResult = {
  patched: boolean;
  status: PatchStatus;
  text: string;
};

function usage(): string {
  return "Usage: patch-openclaw-managed-transport-diagnostics.mts [--audit] <openclaw-dist-dir>";
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

/** Fail closed: a recognized bundle-mcp runtime must expose the fetch boundary exactly once. */
export function patchManagedTransportDiagnosticsText(
  source: string,
  filePath: string,
): PatchTextResult {
  if (source.includes(MARKER)) {
    for (const pattern of PATCHED_REQUIRED_PATTERNS) {
      const count = countOccurrences(source, pattern);
      if (count !== 1) {
        throw new Error(
          `${filePath}: managed transport diagnostics patch is partial or ambiguous; expected exactly one patched target, found ${count}`,
        );
      }
    }
    for (const pattern of UNPATCHED_TARGET_PATTERNS) {
      if (source.includes(pattern)) {
        throw new Error(
          `${filePath}: managed transport diagnostics marker is present but an unpatched target remains`,
        );
      }
    }
    return { patched: false, status: "already-patched", text: source };
  }

  for (const pattern of REQUIRED_PATTERNS) {
    const count = countOccurrences(source, pattern);
    if (count !== 1) {
      throw new Error(
        `${filePath}: expected exactly one Streamable HTTP MCP fetch boundary, found ${count}`,
      );
    }
  }

  const importMatch = source.match(/^(?:import[^\n]*\n)+/);
  if (!importMatch) {
    throw new Error(`${filePath}: bundle-mcp runtime has no import prologue to anchor the helper`);
  }

  let text = `${source.slice(0, importMatch[0].length)}${INJECTED_DIAGNOSTIC_HELPER}${source.slice(
    importMatch[0].length,
  )}`;
  text = text.replace(STREAMABLE_TRANSPORT_PATTERN, STREAMABLE_TRANSPORT_REPLACEMENT);

  for (const pattern of PATCHED_REQUIRED_PATTERNS) {
    const count = countOccurrences(text, pattern);
    if (count !== 1) {
      throw new Error(
        `${filePath}: managed transport diagnostics patch verification failed; expected exactly one patched target, found ${count}`,
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

export function patchOpenClawManagedTransportDiagnostics(distDir: string): {
  status: PatchStatus;
  file: string;
  version: string;
} {
  const resolvedDist = path.resolve(distDir);
  const version = readOpenClawVersion(resolvedDist);
  const target = resolveBundleMcpRuntimeFile(resolvedDist);
  const result = patchManagedTransportDiagnosticsText(fs.readFileSync(target, "utf-8"), target);
  if (result.patched) fs.writeFileSync(target, result.text);
  return { status: result.status, file: target, version };
}

export function auditOpenClawManagedTransportDiagnostics(distDir: string): {
  file: string;
  version: string;
} {
  const resolvedDist = path.resolve(distDir);
  const version = readOpenClawVersion(resolvedDist);
  const target = resolveBundleMcpRuntimeFile(resolvedDist);
  const source = fs.readFileSync(target, "utf-8");
  if (!source.includes(MARKER)) {
    throw new Error(`${target}: managed transport diagnostics patch is not applied`);
  }
  const result = patchManagedTransportDiagnosticsText(source, target);
  if (result.status !== "already-patched") {
    throw new Error(`${target}: managed transport diagnostics patch state is not stable`);
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
      const result = auditOpenClawManagedTransportDiagnostics(distDir);
      console.log(
        `INFO: OpenClaw managed transport diagnostics audit ok: ${result.file} (openclaw ${result.version})`,
      );
      return 0;
    }
    const result = patchOpenClawManagedTransportDiagnostics(distDir);
    console.log(
      `INFO: OpenClaw managed transport diagnostics ${result.status}: ${result.file} (openclaw ${result.version})`,
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
