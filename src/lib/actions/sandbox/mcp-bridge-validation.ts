// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

import { resolveHostAddresses } from "../../adapters/dns/resolve";
import {
  isBlockedMcpUrlTargetHost,
  isOpenShellMcpHostAlias,
  MCP_SERVER_URL_MAX_LENGTH,
} from "../../security/mcp-url-target";
import { TOKEN_PREFIX_PATTERNS } from "../../security/secret-patterns";
import type { McpBridgeEntry } from "../../state/registry";
import { isSubprocessEnvNameAllowed } from "../../subprocess-env";
import {
  McpBridgeError,
  type ParsedEnvReference,
  type ParsedMcpAddArgs,
} from "./mcp-bridge-contracts";
import childVisibleCredentialManifest from "./openshell-child-visible-credentials.v0.0.72.json";

export { MCP_SERVER_URL_MAX_LENGTH } from "../../security/mcp-url-target";

const VALID_SERVER_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VALID_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VALID_SANDBOX_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
// invalidState: an MCP bearer name aliases a child-visible or process-control
// key and exposes or executes the provider value outside the intended request.
// sourceBoundary: the versioned JSON manifest pins OpenShell-owned keys to the
// shipped source commit; NemoClaw owns host and agent runtime-control rejects.
// whyNotSourceFix: v0.0.72 exposes provider keys to every fresh sandbox exec
// and does not advertise safe credential-name capabilities at runtime.
// regressionTest: mcp-bridge-input.test.ts checks every pinned and runtime key;
// package/workflow contracts require the manifest version to track OpenShell.
// removalCondition: replace these rejects when OpenShell offers endpoint-only
// credentials plus a machine-readable child-environment capability manifest.
const OPENSHELL_RAW_CHILD_ENV_KEYS = new Set(childVisibleCredentialManifest.rawChildValueKeys);
const OPENSHELL_REWRITTEN_CHILD_ENV_KEYS = new Set(
  childVisibleCredentialManifest.rewrittenChildValueKeys,
);
// OpenShell attaches provider keys to every fresh sandbox exec. A placeholder
// under one of these names can alter a loader, shell, or supported agent
// runtime before the requested command starts (for example, PYTHONHOME makes
// Python fail during initialization). Require operators to use a dedicated
// service credential alias instead of a process-control name.
const SANDBOX_RUNTIME_CONTROL_ENV_KEYS = new Set([
  "_JAVA_OPTIONS",
  "ALL_PROXY",
  "all_proxy",
  "API_SERVER_KEY",
  "BASH_ENV",
  "BASHOPTS",
  "CDPATH",
  "CLASSPATH",
  "CONDA_PREFIX",
  "DENO_CERT",
  "ENV",
  "GCONV_PATH",
  "GLOBIGNORE",
  "grpc_proxy",
  "IFS",
  "LOCPATH",
  "NLSPATH",
  "PROMPT_COMMAND",
  "PS4",
  "SHELLOPTS",
  "VIRTUAL_ENV",
  "ZDOTDIR",
]);
const SANDBOX_RUNTIME_CONTROL_ENV_PREFIXES = [
  "DEEPAGENTS_",
  "DYLD_",
  "GATEWAY_",
  "GLIBC_",
  "HERMES_",
  "JAVA_",
  "JDK_",
  "LANGCHAIN_",
  "LANGGRAPH_",
  "LANGSMITH_",
  "LD_",
  "MALLOC_",
  "NEMOCLAW_",
  "NODE_",
  "OPENAI_",
  "OPENCLAW_",
  "PERL",
  "PYTHON",
  "RUBY",
  "UV_",
];
const MCP_PROVIDER_HASH_BYTES = 8;
const MCP_PATH_CREDENTIAL_PATTERNS = TOKEN_PREFIX_PATTERNS.map(
  // Validation rejects a token contained anywhere in a persisted segment.
  // Redaction's word boundaries are inappropriate here because '-' is a valid
  // final Telegram/Discord token character but is not a RegExp "word" byte.
  (pattern) => new RegExp(pattern.source.replaceAll("\\b", ""), pattern.flags.replace("g", "")),
);

/**
 * Reject self-identifying credentials in persisted endpoint path segments.
 *
 * This is deliberately a validation predicate rather than a comparison with
 * presentation-redactor output. In particular, ordinary path segments such as
 * `botanical` and `bots` must not inherit the redactor's broad Telegram URL
 * heuristic. Canonical self-identifying token patterns include only Telegram's
 * narrow numeric-ID, colon, and fixed-length secret shape.
 */
function hasSecretShapedMcpPathSegment(pathname: string): boolean {
  return pathname.split("/").some((segment) => {
    if (!segment) return false;
    return MCP_PATH_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(segment));
  });
}

function rejectUnsupportedOpenShellMcpHostAlias(hostname: string): void {
  if (!isOpenShellMcpHostAlias(hostname)) return;
  throw new McpBridgeError(
    `Authenticated MCP OpenShell host alias '${hostname}' is unavailable with OpenShell v0.0.72 because that release does not expose an attested driver gateway address for exact policy pinning. Use a normal HTTPS DNS endpoint with public address records.`,
    2,
  );
}

export function validateSandboxName(name: string): void {
  if (!name || name.length > 63 || !VALID_SANDBOX_RE.test(name)) {
    throw new McpBridgeError(
      `Invalid sandbox name '${name}'. Names must be 1-63 lowercase alphanumeric characters with optional internal hyphens.`,
      2,
    );
  }
}

export function validateMcpServerName(name: string): void {
  if (!VALID_SERVER_RE.test(name)) {
    throw new McpBridgeError(
      `Invalid MCP server name '${name}'. Names must start with a letter and contain only letters, digits, hyphens, and underscores.`,
      2,
    );
  }
}

export function validateMcpCredentialEnvName(name: string): void {
  validatePersistedMcpCredentialEnvName(name);
  if (isSubprocessEnvNameAllowed(name)) {
    throw new McpBridgeError(
      `MCP credential environment name '${name}' is reserved for host subprocess control and could be forwarded outside the provider mutation. Use a dedicated secret name such as MY_SERVICE_MCP_TOKEN.`,
      2,
    );
  }
  if (OPENSHELL_RAW_CHILD_ENV_KEYS.has(name)) {
    throw new McpBridgeError(
      `MCP credential environment name '${name}' is materialized as a raw child-process value by OpenShell's Google Cloud compatibility path. Use a distinct secret name to preserve the host-only credential boundary.`,
      2,
    );
  }
  if (OPENSHELL_REWRITTEN_CHILD_ENV_KEYS.has(name)) {
    throw new McpBridgeError(
      `MCP credential environment name '${name}' is rewritten by OpenShell's Google Cloud metadata compatibility path. Use a distinct secret name so credential attachment remains deterministic.`,
      2,
    );
  }
  if (
    SANDBOX_RUNTIME_CONTROL_ENV_KEYS.has(name) ||
    SANDBOX_RUNTIME_CONTROL_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  ) {
    throw new McpBridgeError(
      `MCP credential environment name '${name}' is reserved for sandbox runtime control and could alter or prevent agent commands. Use a dedicated secret name such as MY_SERVICE_MCP_TOKEN.`,
      2,
    );
  }
}

/** Validate syntax only for cleanup of durable entries created by older builds. */
export function validatePersistedMcpCredentialEnvName(name: string): void {
  if (!VALID_ENV_RE.test(name)) {
    throw new McpBridgeError(
      `Invalid environment variable name '${name}'. Names must match [A-Za-z_][A-Za-z0-9_]*.`,
      2,
    );
  }
}

export function normalizeMcpServerUrl(rawUrl: string): string {
  if (rawUrl.length > MCP_SERVER_URL_MAX_LENGTH) {
    throw new McpBridgeError(
      `MCP server URL must be at most ${MCP_SERVER_URL_MAX_LENGTH} characters.`,
      2,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new McpBridgeError(`Invalid MCP server URL '${rawUrl}'.`, 2);
  }
  if (parsed.protocol !== "https:") {
    throw new McpBridgeError(
      "Authenticated MCP server URLs must use https:// so the configured MCP client uses TLS when OpenShell forwards credential-bearing requests.",
      2,
    );
  }
  if (!parsed.hostname) {
    throw new McpBridgeError("MCP server URL must include a hostname.", 2);
  }
  if (/[*{};]/.test(parsed.hostname)) {
    throw new McpBridgeError(
      "MCP server URL hosts must be literal; wildcard and glob hostnames are not supported.",
      2,
    );
  }
  if (parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")) {
    throw new McpBridgeError(
      "IPv6-literal MCP server URLs are not supported by the current OpenShell proxy target parser. Use a DNS hostname with public A/AAAA records.",
      2,
    );
  }
  if (parsed.username || parsed.password) {
    throw new McpBridgeError(
      "MCP server URL must not embed credentials. Use --env KEY so OpenShell resolves host-only credentials.",
      2,
    );
  }
  if (rawUrl.includes("?") || parsed.search) {
    throw new McpBridgeError(
      "MCP server URLs must not include a query string because URLs are persisted and displayed. Put credentials in --env and use a stable endpoint path.",
      2,
    );
  }
  if (rawUrl.includes("#") || parsed.hash) {
    throw new McpBridgeError(
      "MCP server URLs must not include a fragment because fragments are not sent to the server.",
      2,
    );
  }
  if (parsed.port === "0") {
    throw new McpBridgeError("MCP server URL port must be between 1 and 65535.", 2);
  }
  if (
    /%[0-9a-f]{2}/i.test(rawUrl) ||
    /%[0-9a-f]{2}/i.test(parsed.pathname) ||
    rawUrl.includes("\\") ||
    /\/{2,}/.test(parsed.pathname) ||
    /[\*\[\]\{\};]/.test(parsed.pathname)
  ) {
    throw new McpBridgeError(
      "MCP server URL paths must be literal and canonical; percent escapes, backslashes, semicolons, and glob metacharacters are not supported.",
      2,
    );
  }
  if (hasSecretShapedMcpPathSegment(parsed.pathname)) {
    throw new McpBridgeError(
      "MCP server URL paths must not contain secret-shaped credential material because the full URL is persisted and displayed. Put the bearer credential in --env KEY.",
      2,
    );
  }
  rejectUnsupportedOpenShellMcpHostAlias(parsed.hostname);
  validateMcpServerUrlTarget(parsed);
  if (parsed.hostname.endsWith(".")) {
    throw new McpBridgeError(
      "MCP server URL hostnames must use canonical spelling without a trailing dot.",
      2,
    );
  }
  if (!parsed.pathname) parsed.pathname = "/";
  const normalized = parsed.toString();
  if (normalized.length > MCP_SERVER_URL_MAX_LENGTH) {
    throw new McpBridgeError(
      `MCP server URL must be at most ${MCP_SERVER_URL_MAX_LENGTH} characters after normalization.`,
      2,
    );
  }
  return normalized;
}

function validateMcpServerUrlTarget(parsed: URL): void {
  if (isBlockedMcpUrlTargetHost(parsed.hostname)) {
    throw new McpBridgeError(
      `MCP server URL host '${parsed.hostname}' is a private, local, or special-use IP address. Use a normal HTTPS DNS endpoint with public address records.`,
      2,
    );
  }
}

export async function validateMcpServerUrlResolvedTarget(parsed: URL): Promise<string[]> {
  // invalidState: a hostname is public at add time but later rebinds to an
  // unpinned address. sourceBoundary: NemoClaw pins the add-time public answers;
  // OpenShell v0.0.72 resolves, validates every answer against allowed_ips, and
  // connects with that same SocketAddr list. whyNotSourceFix: duplicating DNS
  // resolution here before each remote connection would create a second,
  // non-authoritative TOCTOU boundary outside OpenShell's data plane.
  // regressionTest: e2e/support/mcp-bridge-sandbox.test.ts pins the exact
  // upstream source contract, and live/mcp-bridge.test.ts remaps DNS and proves
  // a 403 plus zero upstream requests for all three adapters.
  // removalCondition: revisit only when the pinned OpenShell implementation or
  // its allowed_ips resolve-validate-connect contract changes.
  rejectUnsupportedOpenShellMcpHostAlias(parsed.hostname);
  if (isBlockedMcpUrlTargetHost(parsed.hostname)) {
    validateMcpServerUrlTarget(parsed);
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolveHostAddresses(parsed.hostname);
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
    throw new McpBridgeError(
      `MCP server URL host '${parsed.hostname}' could not be resolved before policy registration.${detail}`,
      2,
    );
  }
  if (addresses.length === 0) {
    throw new McpBridgeError(
      `MCP server URL host '${parsed.hostname}' resolved without any addresses before policy registration.`,
      2,
    );
  }
  for (const { address } of addresses) {
    if (isBlockedMcpUrlTargetHost(address)) {
      throw new McpBridgeError(
        `MCP server URL host '${parsed.hostname}' resolves to private, local, or special-use address '${address}'. Use a normal HTTPS DNS endpoint with public address records.`,
        2,
      );
    }
  }
  return [...new Set(addresses.map(({ address }) => address.toLowerCase()))].sort();
}

export function parseMcpUrl(rawUrl: string): URL {
  return new URL(normalizeMcpServerUrl(rawUrl));
}

export function parseMcpAddArgs(argv: string[]): ParsedMcpAddArgs {
  const env: ParsedEnvReference[] = [];
  let server = "";
  let url = "";

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      throw new McpBridgeError(
        "Host stdio MCP commands are not supported. Use --url so OpenShell can enforce MCP traffic and provider credentials.",
        2,
      );
    }
    if (token === "--env" || token === "-e") {
      const raw = argv[++i] ?? "";
      const eq = raw.indexOf("=");
      const name = eq >= 0 ? raw.slice(0, eq) : raw;
      validateMcpCredentialEnvName(name);
      if (eq >= 0) {
        throw new McpBridgeError(
          "Inline --env KEY=VALUE is not accepted because it exposes the secret in the NemoClaw process arguments and shell history. Export KEY, then pass --env KEY.",
          2,
        );
      }
      env.push({ name });
      continue;
    }
    if (token?.startsWith("--env=")) {
      const raw = token.slice("--env=".length);
      const eq = raw.indexOf("=");
      const name = eq >= 0 ? raw.slice(0, eq) : raw;
      validateMcpCredentialEnvName(name);
      if (eq >= 0) {
        throw new McpBridgeError(
          "Inline --env KEY=VALUE is not accepted because it exposes the secret in the NemoClaw process arguments and shell history. Export KEY, then pass --env KEY.",
          2,
        );
      }
      env.push({ name });
      continue;
    }
    if (token === "--url") {
      url = normalizeMcpServerUrl(argv[++i] ?? "");
      continue;
    }
    if (token?.startsWith("--url=")) {
      url = normalizeMcpServerUrl(token.slice("--url=".length));
      continue;
    }
    if (token?.startsWith("-")) {
      throw new McpBridgeError(`Unknown mcp add option: ${token}`, 2);
    }
    if (!server) {
      server = token ?? "";
      validateMcpServerName(server);
      continue;
    }
    throw new McpBridgeError(
      "Usage: nemoclaw <sandbox> mcp add <server> --url <https-mcp-url> --env KEY",
      2,
    );
  }

  if (!server) {
    throw new McpBridgeError(
      "Usage: nemoclaw <sandbox> mcp add <server> --url <https-mcp-url> --env KEY",
      2,
    );
  }
  if (!url) {
    throw new McpBridgeError("MCP server URL is required. Pass --url <https-mcp-url>.", 2);
  }
  if (env.length !== 1) {
    throw new McpBridgeError(
      "Authenticated MCP requires exactly one --env KEY bearer credential reference.",
      2,
    );
  }

  return { server, url, env };
}

export function uniqueEnvNames(env: readonly ParsedEnvReference[] | readonly string[]): string[] {
  const names = env.map((entry) => (typeof entry === "string" ? entry : entry.name));
  return [...new Set(names)];
}

export function assertAuthenticatedCredentialReference(env: readonly ParsedEnvReference[]): void {
  if (env.length !== 1) {
    throw new McpBridgeError(
      "Authenticated MCP requires exactly one --env KEY bearer credential reference.",
      2,
    );
  }
  validateMcpCredentialEnvName(env[0].name);
}

export function assertPersistedAuthenticatedBridgeEntry(entry: McpBridgeEntry): void {
  if (!Array.isArray(entry.env) || entry.env.length !== 1 || !entry.providerName) {
    throw new McpBridgeError(
      `MCP server '${entry.server}' has no complete authenticated credential binding. Remove it with --force, then add it again with --env KEY.`,
      2,
    );
  }
  validatePersistedMcpCredentialEnvName(entry.env[0]);
}

export function assertAuthenticatedBridgeEntry(entry: McpBridgeEntry): void {
  assertPersistedAuthenticatedBridgeEntry(entry);
  validateMcpCredentialEnvName(entry.env[0]);
}

/**
 * Read values only for local display redaction while cleaning legacy state.
 * Never pass this map to a subprocess environment or provider mutation.
 */
export function resolvePersistedCredentialEnvForRedaction(
  envNames: readonly string[],
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const name of envNames) {
    validatePersistedMcpCredentialEnvName(name);
    const value = process.env[name];
    if (value !== undefined && value !== "") resolved[name] = value;
  }
  return resolved;
}

export function resolveCredentialEnv(env: readonly ParsedEnvReference[]): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const entry of env) {
    validateMcpCredentialEnvName(entry.name);
    const value = entry.value ?? process.env[entry.name];
    if (value !== undefined && value !== "") {
      resolved[entry.name] = value;
    }
  }
  return resolved;
}

export function buildMcpBridgeProviderName(
  sandboxName: string,
  server: string,
  instanceId?: string,
): string {
  validateSandboxName(sandboxName);
  validateMcpServerName(server);
  if (instanceId !== undefined && !/^[a-f0-9]{16}$/.test(instanceId)) {
    throw new McpBridgeError("Invalid MCP provider instance ID.");
  }
  const serverSlug = server
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "-");
  const rawBase = `${sandboxName}-mcp-${server}${instanceId ? `-${instanceId}` : ""}`;
  const base = `${sandboxName}-mcp-${serverSlug}${instanceId ? `-${instanceId}` : ""}`
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (base.length <= 63 && base === rawBase) return base;
  const hash = crypto
    .createHash("sha256")
    .update(`${sandboxName}:${server}:${instanceId ?? "stable"}`)
    .digest("hex")
    .slice(0, MCP_PROVIDER_HASH_BYTES * 2);
  const suffix = `-${hash}`;
  return `${base.slice(0, 63 - suffix.length).replace(/-+$/g, "")}${suffix}`;
}
