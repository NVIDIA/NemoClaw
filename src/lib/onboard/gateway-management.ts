// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public, versioned contract describing who owns the OpenShell gateway
 * lifecycle on this host (#6576).
 *
 * Platform profiles (#6404) and downstream automation declare a gateway
 * management mode; core NemoClaw consumes only what is declared here. The
 * declaration is deliberately platform-neutral: it carries an endpoint, a
 * state location, an expected service/runtime identity, and the capabilities
 * the gateway must provide. It carries no Brev/GCP control-plane concepts and,
 * by construction, no credentials — unknown keys are rejected rather than
 * ignored, so a secret cannot be smuggled through this surface into persisted
 * ownership metadata, diagnostics, or machine events.
 *
 * Parsing is fail-closed. An unrecognized version, an unknown capability, or a
 * malformed field is an error, never a silent downgrade to "no declaration" —
 * treating a bad declaration as absent is exactly how a host ends up with two
 * gateway authorities.
 */

import fs from "node:fs";
import path from "node:path";
import {
  type GatewayCapability,
  SUPPORTED_GATEWAY_CAPABILITIES,
} from "../core/gateway-capabilities";

export {
  type GatewayCapability,
  SUPPORTED_GATEWAY_CAPABILITIES,
} from "../core/gateway-capabilities";

/** Bump only for a breaking change to the declaration shape. */
export const GATEWAY_MANAGEMENT_CONTRACT_VERSION = 1;

/** Environment variable naming a JSON file holding the declaration. */
export const GATEWAY_MANAGEMENT_ENV_VAR = "NEMOCLAW_GATEWAY_MANAGEMENT";

export type GatewayManagementMode = "nemoclaw-managed" | "externally-supervised";

/**
 * Supervisor kinds NemoClaw can authoritatively bind a listening PID to. Only
 * systemd is supported in v1: an opaque "external" supervisor offers no way to
 * prove the listener belongs to it, so declaring it could never attach. The
 * contract is versioned, so a proven external-identity mechanism can be added
 * later without a breaking change (#6576).
 */
export const SUPPORTED_GATEWAY_SUPERVISOR_KINDS = ["systemd-system", "systemd-user"] as const;

export type GatewaySupervisorKind = (typeof SUPPORTED_GATEWAY_SUPERVISOR_KINDS)[number];

/** How the external supervisor runs the gateway, and how to recognize it. */
export interface GatewaySupervisorDeclaration {
  kind: GatewaySupervisorKind;
  /** Unit (or equivalent) name the platform supervisor manages. */
  serviceName: string;
  /** Absolute path of the gateway executable the supervisor runs. Required. */
  execPath: string;
}

export interface GatewayManagementDeclaration {
  version: typeof GATEWAY_MANAGEMENT_CONTRACT_VERSION;
  mode: GatewayManagementMode;
  /** Required only when an external supervisor owns the gateway. */
  endpoint: string | null;
  /** External gateway state root; for HTTPS, contains the client TLS bundle. */
  stateDir: string | null;
  /** Required for `externally-supervised`; must be absent for `nemoclaw-managed`. */
  supervisor: GatewaySupervisorDeclaration | null;
  requiredCapabilities: readonly GatewayCapability[];
}

export type GatewayManagementParseResult =
  | { ok: true; declaration: GatewayManagementDeclaration }
  | { ok: false; reason: string };

const DECLARATION_KEYS = new Set([
  "version",
  "mode",
  "endpoint",
  "stateDir",
  "supervisor",
  "requiredCapabilities",
]);

const SUPERVISOR_KEYS = new Set(["kind", "serviceName", "execPath"]);

const SUPERVISOR_KINDS = new Set<string>(SUPPORTED_GATEWAY_SUPERVISOR_KINDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, where: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    // Fail closed rather than ignore: an unknown key is either a newer contract
    // this build cannot honor, or an attempt to route data (a credential, a
    // control-plane detail) through a surface that gets persisted and emitted.
    return `unknown ${where} field(s): ${unknown.sort().join(", ")}`;
  }
  return null;
}

function requireNonEmptyString(value: unknown, field: string): string | { error: string } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { error: `${field} must be a non-empty string` };
  }
  return value.trim();
}

/**
 * Numeric hosts a declared gateway endpoint may name. The gateway is supervised
 * on this machine, so the endpoint is always loopback. DNS names are excluded:
 * even `localhost` can be redirected by resolver configuration between parsing
 * and the readiness request.
 */
const SUPPORTED_GATEWAY_ENDPOINT_HOSTS = new Set(["127.0.0.1", "[::1]", "::1"]);

/**
 * The endpoint is persisted, emitted in diagnostics, and — for an externally
 * supervised gateway — used as the target of a readiness request. So it must
 * neither carry a secret nor be able to point NemoClaw at an arbitrary host.
 *
 * Reject embedded credentials, queries, and fragments; keep it to a bare origin;
 * and constrain it to the supported local gateway origins, so a declaration
 * cannot direct a request at a remote, link-local, or cloud-metadata address.
 */
function parseEndpoint(value: unknown): string | { error: string } {
  const raw = requireNonEmptyString(value, "endpoint");
  if (typeof raw !== "string") return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "endpoint is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "endpoint must use http or https" };
  }
  if (url.username || url.password) {
    return { error: "endpoint must not embed credentials" };
  }
  if (url.search || url.hash) {
    return { error: "endpoint must not carry a query string or fragment" };
  }
  if ((url.pathname && url.pathname !== "/") || raw.includes("@")) {
    return { error: "endpoint must be a bare origin (no path)" };
  }
  if (!SUPPORTED_GATEWAY_ENDPOINT_HOSTS.has(url.hostname)) {
    return {
      error:
        `endpoint host is not a supported local gateway origin; ` +
        `the declared gateway is supervised on this machine, so the endpoint must be loopback ` +
        `(one of: ${[...SUPPORTED_GATEWAY_ENDPOINT_HOSTS].join(", ")})`,
    };
  }
  return url.origin;
}

// Declared paths are kept verbatim rather than normalized: they name locations
// on the host the declaration describes, and normalizing them through the
// running platform's path rules would rewrite a POSIX path on a Windows host.
function parseStateDir(value: unknown): string | { error: string } {
  const raw = requireNonEmptyString(value, "stateDir");
  if (typeof raw !== "string") return raw;
  if (!path.isAbsolute(raw)) {
    return { error: "stateDir must be an absolute path" };
  }
  return raw;
}

function parseCapabilities(value: unknown): readonly GatewayCapability[] | { error: string } {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return { error: "requiredCapabilities must be an array" };
  }
  const supported = new Set<string>(SUPPORTED_GATEWAY_CAPABILITIES);
  const capabilities: GatewayCapability[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !supported.has(entry)) {
      return {
        error:
          `unsupported capability; ` +
          `this NemoClaw build provides: ${SUPPORTED_GATEWAY_CAPABILITIES.join(", ")}`,
      };
    }
    if (!capabilities.includes(entry as GatewayCapability)) {
      capabilities.push(entry as GatewayCapability);
    }
  }
  return capabilities;
}

function parseSupervisor(
  value: unknown,
  mode: GatewayManagementMode,
): GatewaySupervisorDeclaration | null | { error: string } {
  if (mode === "nemoclaw-managed") {
    if (value !== undefined && value !== null) {
      return {
        error: "supervisor must not be declared for mode nemoclaw-managed",
      };
    }
    return null;
  }
  if (!isRecord(value)) {
    return { error: "supervisor is required for mode externally-supervised" };
  }
  const unknown = rejectUnknownKeys(value, SUPERVISOR_KEYS, "supervisor");
  if (unknown) return { error: unknown };

  const kind = value.kind;
  if (typeof kind !== "string" || !SUPERVISOR_KINDS.has(kind as GatewaySupervisorKind)) {
    return {
      error: `supervisor.kind must be one of: ${[...SUPERVISOR_KINDS].join(", ")}`,
    };
  }
  const serviceName = requireNonEmptyString(value.serviceName, "supervisor.serviceName");
  if (typeof serviceName !== "string") return serviceName;
  if (!/^[A-Za-z0-9][A-Za-z0-9:_.@-]*\.service$/.test(serviceName)) {
    return { error: "supervisor.serviceName must name one systemd .service unit" };
  }

  // execPath is required, not optional: without a declared executable there is
  // nothing to check the listening process against, and attachment would accept
  // any live local listener that answers the health probe.
  const execPath = requireNonEmptyString(value.execPath, "supervisor.execPath");
  if (typeof execPath !== "string") return execPath;
  if (!path.isAbsolute(execPath)) {
    return { error: "supervisor.execPath must be an absolute path" };
  }

  return { kind: kind as GatewaySupervisorKind, serviceName, execPath };
}

/**
 * Parse and validate a gateway-management declaration. Fail-closed: any problem
 * is reported as an error, never coerced into a usable default.
 */
export function parseGatewayManagementDeclaration(raw: unknown): GatewayManagementParseResult {
  if (!isRecord(raw)) {
    return { ok: false, reason: "declaration must be a JSON object" };
  }
  const unknown = rejectUnknownKeys(raw, DECLARATION_KEYS, "declaration");
  if (unknown) return { ok: false, reason: unknown };

  if (raw.version !== GATEWAY_MANAGEMENT_CONTRACT_VERSION) {
    return {
      ok: false,
      reason:
        "unsupported gateway-management contract version; " +
        `this NemoClaw build supports version ${GATEWAY_MANAGEMENT_CONTRACT_VERSION}`,
    };
  }

  const mode = raw.mode;
  if (mode !== "nemoclaw-managed" && mode !== "externally-supervised") {
    return {
      ok: false,
      reason: "mode must be nemoclaw-managed or externally-supervised",
    };
  }

  let endpoint: string | null = null;
  let stateDir: string | null = null;
  if (mode === "externally-supervised") {
    const parsedEndpoint = parseEndpoint(raw.endpoint);
    if (typeof parsedEndpoint !== "string") {
      return { ok: false, reason: parsedEndpoint.error };
    }
    const parsedStateDir = parseStateDir(raw.stateDir);
    if (typeof parsedStateDir !== "string") {
      return { ok: false, reason: parsedStateDir.error };
    }
    endpoint = parsedEndpoint;
    stateDir = parsedStateDir;
  } else if (raw.endpoint !== undefined || raw.stateDir !== undefined) {
    return {
      ok: false,
      reason: "endpoint and stateDir must not be declared for mode nemoclaw-managed",
    };
  }

  const supervisor = parseSupervisor(raw.supervisor, mode);
  if (supervisor && "error" in supervisor) return { ok: false, reason: supervisor.error };

  const requiredCapabilities = parseCapabilities(raw.requiredCapabilities);
  if ("error" in requiredCapabilities) {
    return { ok: false, reason: requiredCapabilities.error };
  }

  return {
    ok: true,
    declaration: {
      version: GATEWAY_MANAGEMENT_CONTRACT_VERSION,
      mode,
      endpoint,
      stateDir,
      supervisor,
      requiredCapabilities,
    },
  };
}

export interface LoadGatewayManagementOptions {
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => string;
  /** Declaration supplied in-process (e.g. by a platform profile) instead of via file. */
  declaration?: unknown;
}

export type GatewayManagementLoadResult =
  | {
      ok: true;
      declaration: GatewayManagementDeclaration | null;
      source: "profile" | "file" | null;
    }
  | { ok: false; reason: string };

/**
 * Resolve the declaration for this run. An in-process declaration (a platform
 * profile) wins over the environment file; absent both, the caller gets `null`
 * and keeps NemoClaw's historical self-managed behavior.
 */
export function loadGatewayManagementDeclaration(
  options: LoadGatewayManagementOptions = {},
): GatewayManagementLoadResult {
  if (options.declaration !== undefined && options.declaration !== null) {
    const parsed = parseGatewayManagementDeclaration(options.declaration);
    if (!parsed.ok) return { ok: false, reason: `gateway management profile: ${parsed.reason}` };
    return { ok: true, declaration: parsed.declaration, source: "profile" };
  }

  const env = options.env ?? process.env;
  const configuredPath = env[GATEWAY_MANAGEMENT_ENV_VAR]?.trim();
  if (!configuredPath) return { ok: true, declaration: null, source: null };

  const readFile = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf-8"));
  let contents: string;
  try {
    contents = readFile(path.resolve(configuredPath));
  } catch {
    return {
      ok: false,
      reason: `${GATEWAY_MANAGEMENT_ENV_VAR} declaration file could not be read`,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return {
      ok: false,
      reason: `${GATEWAY_MANAGEMENT_ENV_VAR} declaration file is not valid JSON`,
    };
  }

  const parsed = parseGatewayManagementDeclaration(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: `${GATEWAY_MANAGEMENT_ENV_VAR} declaration file: ${parsed.reason}`,
    };
  }
  return { ok: true, declaration: parsed.declaration, source: "file" };
}
