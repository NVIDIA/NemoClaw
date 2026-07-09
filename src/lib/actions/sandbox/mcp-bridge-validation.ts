// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import crypto from "node:crypto";

import { resolveOpenshell } from "../../adapters/openshell/resolve";
import type { McpBridgeEntry } from "../../state/registry";
import { buildSubprocessEnv, isSubprocessEnvNameAllowed } from "../../subprocess-env";
import {
  McpBridgeError,
  type ParsedEnvReference,
  type ParsedMcpAddArgs,
} from "./mcp-bridge-contracts";
import { normalizeMcpServerUrl } from "./mcp-bridge-url-validation";
// This static import is intentionally fail-closed: TypeScript/build packaging
// must reject a missing or malformed security manifest instead of letting the
// CLI start with a weakened credential-name denylist. Input, package, image,
// and workflow contracts pin its structure, installed path, and version.
import childVisibleCredentialManifest from "./openshell-child-visible-credentials.v0.0.72.json";

export {
  MCP_SERVER_URL_MAX_LENGTH,
  normalizeMcpServerUrl,
  parseMcpUrl,
  validateMcpServerUrlResolvedTarget,
} from "./mcp-bridge-url-validation";

const VALID_SERVER_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VALID_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VALID_SANDBOX_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const OPENSHELL_VERSION_OUTPUT_RE =
  /^openshell\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const OPENSHELL_VERSION_PROBE_TIMEOUT_MS = 5_000;
const OPENSHELL_VERSION_PROBE_MAX_BUFFER_BYTES = 16 * 1_024;
export const MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION =
  childVisibleCredentialManifest.openshellVersion;

export type McpCredentialBoundaryRuntimeVersionErrorReason =
  | "binary-missing"
  | "probe-failed"
  | "probe-nonzero"
  | "unparseable-output"
  | "version-mismatch";

/**
 * Adds in-process classification metadata without changing the established
 * McpBridgeError message, name, or generic exit code contract.
 */
export class McpCredentialBoundaryRuntimeVersionError extends McpBridgeError {
  constructor(
    readonly actualVersion: string,
    readonly detail: string,
    readonly reason: McpCredentialBoundaryRuntimeVersionErrorReason,
  ) {
    super(
      `OpenShell credential boundary runtime version check failed: expected ${MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION}, actual ${actualVersion} (${detail}). Install OpenShell ${MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION}, or point NEMOCLAW_OPENSHELL_BIN to that version, then retry.`,
    );
  }
}

type OpenshellVersionCommandResult = Pick<
  SpawnSyncReturns<string>,
  "error" | "status" | "stderr" | "stdout"
>;

export interface McpCredentialBoundaryRuntimeDeps {
  resolveOpenshell?: () => string | null;
  runVersionCommand?: (binary: string) => OpenshellVersionCommandResult;
}

function runOpenshellVersionCommand(binary: string): OpenshellVersionCommandResult {
  return spawnSync(binary, ["--version"], {
    encoding: "utf8",
    env: buildSubprocessEnv(),
    maxBuffer: OPENSHELL_VERSION_PROBE_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: OPENSHELL_VERSION_PROBE_TIMEOUT_MS,
  });
}

function credentialBoundaryVersionError(
  actual: string,
  detail: string,
  reason: McpCredentialBoundaryRuntimeVersionErrorReason,
): McpCredentialBoundaryRuntimeVersionError {
  return new McpCredentialBoundaryRuntimeVersionError(actual, detail, reason);
}

/**
 * Bind the static child-visible credential manifest to the host OpenShell CLI
 * that will establish a provider credential. Credential-establishing lifecycle
 * boundaries call this once immediately before their first side effect;
 * deliberately avoiding a cache ensures a long-running CLI process cannot
 * retain stale approval after the binary changes. Teardown skips this check so
 * a version mismatch cannot strand detach/delete cleanup that only revokes
 * credential access.
 */
export function assertMcpCredentialBoundaryRuntimeVersion(
  deps: McpCredentialBoundaryRuntimeDeps = {},
): void {
  const binary = (deps.resolveOpenshell ?? resolveOpenshell)();
  if (!binary) {
    throw credentialBoundaryVersionError(
      "<missing>",
      "openshell binary not found",
      "binary-missing",
    );
  }

  const result = (deps.runVersionCommand ?? runOpenshellVersionCommand)(binary);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const detail = code === "ENOENT" ? "openshell binary not found" : "openshell --version failed";
    throw credentialBoundaryVersionError("<unavailable>", detail, "probe-failed");
  }
  if (result.status !== 0) {
    throw credentialBoundaryVersionError(
      "<unavailable>",
      `openshell --version exited with status ${String(result.status)}`,
      "probe-nonzero",
    );
  }

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const actualVersion = output.match(OPENSHELL_VERSION_OUTPUT_RE)?.[1];
  if (!actualVersion) {
    throw credentialBoundaryVersionError(
      "<unparseable>",
      "invalid openshell --version output",
      "unparseable-output",
    );
  }
  if (actualVersion !== MCP_CREDENTIAL_BOUNDARY_OPENSHELL_VERSION) {
    throw credentialBoundaryVersionError(actualVersion, "version mismatch", "version-mismatch");
  }
}

// invalidState: an MCP bearer name aliases a child-visible or process-control
// key and exposes or executes the provider value outside the intended request.
// sourceBoundary: the versioned JSON manifest pins OpenShell-owned keys to the
// shipped source commit; NemoClaw owns host and agent runtime-control rejects.
// whyNotSourceFix: v0.0.72 exposes provider keys to every fresh sandbox exec
// and does not advertise safe credential-name capabilities at runtime.
// regressionTest: the mcp-bridge-input validation/runtime suites check every
// pinned and runtime key; package contracts require version alignment.
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
const SANDBOX_RUNTIME_CONTROL_ENV_KEYS = new Set(childVisibleCredentialManifest.runtimeControlKeys);
const SANDBOX_RUNTIME_CONTROL_ENV_PREFIXES = childVisibleCredentialManifest.runtimeControlPrefixes;
const MCP_PROVIDER_HASH_BYTES = 8;
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
