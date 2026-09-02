// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * NemoClaw Blueprint Runner
 *
 * Orchestrates OpenClaw sandbox lifecycle inside OpenShell.
 *
 * Protocol:
 *   - stdout lines starting with PROGRESS:<0-100>:<label> are parsed as progress updates
 *   - stdout line RUN_ID:<id> reports the run identifier
 *   - exit code 0 = success, non-zero = failure
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { execa } from "execa";
import YAML from "yaml";

import { DASHBOARD_PORT } from "../lib/ports.js";
import { buildSubprocessEnv } from "../lib/subprocess-env.js";
import { redactCredentialText, stripCredentials } from "../security/credential-filter.js";
import { isPlainObject, type UnknownRecord } from "../shared/object-record.js";
import * as importedOpenShellGatewayEndpointBoundary from "../shared/openshell-gateway-endpoint-boundary.cjs";
import * as importedOpenShellExternalTargetBoundary from "../shared/openshell-external-target-boundary.cjs";
import * as importedOpenShellObservationBoundary from "../shared/openshell-observation-boundary.cjs";
import * as importedOpenShellPolicyBoundary from "../shared/openshell-policy-boundary.cjs";
import * as importedSandboxName from "../shared/sandbox-name.cjs";
import type {
  OpenShellCompatibilityRange,
  SanitizedExternalOpenShellTargetPlan,
} from "../shared/openshell-external-target-boundary.cjs";
import type {
  ExternalOpenShellGatewayStatus,
  OpenShellGatewayHealthObserver,
} from "../shared/openshell-observation-boundary.cjs";
import { createBlueprintOpenShellPolicyClient } from "./openshell-policy.js";
import { isPrivateHostname } from "./private-networks.js";
import {
  attachRuntimeIdentity,
  buildRuntimeIdentityPlan,
  isRuntimeIdentityConfig,
  isRuntimeIdentityReceipt,
  mintRuntimeIdentityCredential,
  parseRuntimeIdentityProviderMetadata,
  prepareRuntimeIdentity,
  type RuntimeIdentityCommandDeps,
  type RuntimeIdentityCommandOptions,
  type RuntimeIdentityConfig,
  type RuntimeIdentityDeps,
  type RuntimeIdentityPlan,
  type RuntimeIdentityProfilePolicy,
  type RuntimeIdentityReceipt,
} from "./runtime-identity.js";
import type { SnapshotCommandOptions } from "./snapshot-command.js";
import { actionSnapshots } from "./snapshot-command.js";
import { safeEndpointUrlForDownstream, validateEndpointUrl } from "./ssrf.js";

// The compiled plugin exposes named CommonJS exports. Source-mode tsx maps the
// .cjs specifier back to .cts and exposes that same module as its default.
const sourceOrGeneratedOpenShellPolicyBoundary =
  importedOpenShellPolicyBoundary as typeof importedOpenShellPolicyBoundary & {
    default?: typeof importedOpenShellPolicyBoundary;
  };
const {
  assertPolicyRequirementContainment,
  classifyOpenShellGlobalPolicyHistory,
  parseActiveGlobalPolicyMetadata,
  parseOpenShellPolicy,
  withoutProviderComposedPolicies,
} = sourceOrGeneratedOpenShellPolicyBoundary.default ?? sourceOrGeneratedOpenShellPolicyBoundary;

const sourceOrGeneratedOpenShellGatewayEndpointBoundary =
  importedOpenShellGatewayEndpointBoundary as typeof importedOpenShellGatewayEndpointBoundary & {
    default?: typeof importedOpenShellGatewayEndpointBoundary;
  };
const { isManagedGatewayEndpointHost, parseSingleManagedGatewayEndpoint } =
  sourceOrGeneratedOpenShellGatewayEndpointBoundary.default ??
  sourceOrGeneratedOpenShellGatewayEndpointBoundary;

const sourceOrGeneratedOpenShellExternalTargetBoundary =
  importedOpenShellExternalTargetBoundary as typeof importedOpenShellExternalTargetBoundary & {
    default?: typeof importedOpenShellExternalTargetBoundary;
  };
const { buildSanitizedExternalOpenShellTargetPlan, withExternalOpenShellTargetCa } =
  sourceOrGeneratedOpenShellExternalTargetBoundary.default ??
  sourceOrGeneratedOpenShellExternalTargetBoundary;

const sourceOrGeneratedOpenShellObservationBoundary =
  importedOpenShellObservationBoundary as typeof importedOpenShellObservationBoundary & {
    default?: typeof importedOpenShellObservationBoundary;
  };
const { observeExternalOpenShellGatewayHealth } =
  sourceOrGeneratedOpenShellObservationBoundary.default ??
  sourceOrGeneratedOpenShellObservationBoundary;

// sourceOfTruth: nemoclaw/src/shared/sandbox-name.cts
const sourceOrGeneratedSandboxName = importedSandboxName as typeof importedSandboxName & {
  default?: typeof importedSandboxName;
};
const { assertValidName, assertValidProviderName, isValidName } =
  sourceOrGeneratedSandboxName.default ?? sourceOrGeneratedSandboxName;

type Action = "plan" | "apply" | "status" | "reconcile" | "rollback";

type ExternalOpenShellTargetStatus = ExternalOpenShellGatewayStatus & Readonly<{ run_id: string }>;

type RollbackPlanSource = {
  sandbox_name?: unknown;
  sandbox_created_by_apply?: unknown;
  inference_provider_created_by_apply?: unknown;
  inference?: unknown;
  identity?: unknown;
  gateway?: unknown;
};
type ReconciliationPlanSource = RollbackPlanSource;
type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
type RestProtocol = "rest";
type EndpointEnforcement = "enforce" | "audit";
type EndpointTls = "terminate" | "passthrough" | "skip";

interface PolicyRule {
  allow: {
    method: HttpMethod;
    path: string;
  };
}

interface PolicyEndpoint {
  host: string;
  port: number;
  protocol?: RestProtocol;
  enforcement?: EndpointEnforcement;
  tls?: EndpointTls;
  access?: "full";
  rules?: PolicyRule[];
}

interface PolicyAddition {
  name: string;
  endpoints: PolicyEndpoint[];
}

type PolicyAdditions = { [name: string]: PolicyAddition };

type BlueprintPolicyInspection =
  import("../shared/openshell-policy-boundary.cjs").OpenShellPolicyInspection;
type BlueprintPolicyRead =
  import("../shared/openshell-policy-boundary.cjs").OpenShellSandboxPolicyRead;
type BlueprintPolicySetSubmission =
  import("../shared/openshell-policy-boundary.cjs").OpenShellSandboxPolicySetSubmission;

type GatewayBinding = {
  name: string;
  host: string;
  port: number;
};

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const REST_PROTOCOLS = new Set(["rest"]);
const ENDPOINT_ENFORCEMENT_MODES = new Set(["enforce", "audit"]);
const ENDPOINT_TLS_MODES = new Set(["terminate", "passthrough", "skip"]);
const BLUEPRINT_KEYS = new Set([
  "version",
  "min_openshell_version",
  "max_openshell_version",
  "min_openclaw_version",
  "digest",
  "profiles",
  "description",
  "openshell_target",
  "components",
]);
const MISSING_PROVIDER_INSPECTION_PATTERN =
  /(?:\bprovider\b[^\r\n]*\b(?:not found|does not exist)\b|\b(?:not found|does not exist)\b[^\r\n]*\bprovider\b|\bunknown provider\b)/i;
const POLICY_INSPECTION_MAX_BYTES = 1024 * 1024;
const POLICY_INSPECTION_TIMEOUT_MS = 30_000;
const BLUEPRINT_POLICY_REBASE_ATTEMPTS = 3;
const UNRESTRICTED_POLICY_HOSTS = new Set(["*", "0.0.0.0", "0.0.0.0/0", "::", "::/0"]);

interface InferenceRouteBinding {
  provider: string;
  model: string;
  timeoutSeconds?: number;
}

function parseInferenceRouteBinding(output: string): InferenceRouteBinding | null {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  let inGatewayInference = false;
  let provider = "";
  let model = "";
  let timeoutSeconds: number | undefined;
  for (const line of lines) {
    if (/^(?:Gateway )?Inference:\s*$/i.test(line)) {
      inGatewayInference = true;
      continue;
    }
    if (inGatewayInference && /^\S.*:$/.test(line)) break;
    if (!inGatewayInference) continue;
    const trimmed = line.trim();
    const providerMatch = /^Provider:\s*(.+)$/i.exec(trimmed);
    const modelMatch = /^Model:\s*(.+)$/i.exec(trimmed);
    const timeoutMatch = /^Timeout:\s*(\d+)s?$/i.exec(trimmed);
    if (providerMatch) provider = providerMatch[1].trim();
    if (modelMatch) model = modelMatch[1].trim();
    if (timeoutMatch) timeoutSeconds = Number(timeoutMatch[1]);
  }
  return provider && model ? { provider, model, timeoutSeconds } : null;
}

function isUnconfiguredInferenceRoute(output: string): boolean {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^(?:Gateway )?Inference:\s*$/i.test(line));
  if (headingIndex < 0) return false;
  const routeLines: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    if (/^\S.*:$/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed) routeLines.push(trimmed);
  }
  return routeLines.length === 1 && routeLines[0]?.toLowerCase() === "not configured";
}

function isAction(value: string | undefined): value is Action {
  return (
    value === "plan" ||
    value === "apply" ||
    value === "status" ||
    value === "reconcile" ||
    value === "rollback"
  );
}

// Redact credential-shaped output before bounding OpenShell stderr to a compact,
// single-line diagnostic. (#6703)
const MAX_COMMAND_ERROR_CHARS = 500;
const SENSITIVE_ERROR_ASSIGNMENT =
  /(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*)[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

function boundedCommandError(stderr: string, secretValues: readonly string[] = []): string {
  let redacted = redactCredentialText(stderr);
  for (const secret of [...new Set(secretValues)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join("<REDACTED>");
  }
  redacted = redacted
    .replace(SENSITIVE_ERROR_ASSIGNMENT, "$1=<REDACTED>")
    .replace(/\b(Bearer)\s+\S+/gi, "$1 <REDACTED>");
  const collapsed = redacted.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "no error output";
  return collapsed.length > MAX_COMMAND_ERROR_CHARS
    ? `${collapsed.slice(0, MAX_COMMAND_ERROR_CHARS)}…`
    : collapsed;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isOptionalPortList(value: unknown): value is number[] | undefined {
  return (
    value === undefined || (Array.isArray(value) && value.every((entry) => isValidPort(entry)))
  );
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isPolicyRule(value: unknown): value is PolicyRule {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["allow"])) {
    return false;
  }
  const allow = value.allow;
  if (!isPlainObject(allow) || !hasOnlyKeys(allow, ["method", "path"])) {
    return false;
  }
  return (
    typeof allow.method === "string" &&
    HTTP_METHODS.has(allow.method) &&
    typeof allow.path === "string" &&
    allow.path.startsWith("/")
  );
}

function isPolicyEndpoint(value: unknown): value is PolicyEndpoint {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["host", "port", "protocol", "enforcement", "tls", "access", "rules"])
  ) {
    return false;
  }

  const protocol = value.protocol;
  const enforcement = value.enforcement;
  const tls = value.tls;
  const access = value.access;
  const rules = value.rules;

  return (
    typeof value.host === "string" &&
    isValidPort(value.port) &&
    (protocol === undefined || (typeof protocol === "string" && REST_PROTOCOLS.has(protocol))) &&
    (enforcement === undefined ||
      (typeof enforcement === "string" && ENDPOINT_ENFORCEMENT_MODES.has(enforcement))) &&
    (tls === undefined || (typeof tls === "string" && ENDPOINT_TLS_MODES.has(tls))) &&
    (access === undefined || access === "full") &&
    (rules === undefined ||
      (Array.isArray(rules) && rules.length > 0 && rules.every((entry) => isPolicyRule(entry)))) &&
    (protocol !== "rest" || rules !== undefined)
  );
}

function isPolicyAddition(value: unknown): value is PolicyAddition {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["name", "endpoints"])) {
    return false;
  }
  return (
    typeof value.name === "string" &&
    Array.isArray(value.endpoints) &&
    value.endpoints.length > 0 &&
    value.endpoints.every((entry) => isPolicyEndpoint(entry))
  );
}

function isPolicyAdditions(value: unknown): value is PolicyAdditions {
  return isPlainObject(value) && Object.values(value).every((entry) => isPolicyAddition(entry));
}

function normalizeBlueprintPolicyHost(raw: string): string {
  const value = raw.trim();
  if (!value || value !== raw) throw new Error("policy host is empty or not canonical");
  if (UNRESTRICTED_POLICY_HOSTS.has(value.toLowerCase())) {
    throw new Error("policy host grants unrestricted egress");
  }

  const wildcard = value.startsWith("*.");
  const candidate = wildcard ? value.slice(2) : value;
  if (
    !candidate ||
    candidate.includes("://") ||
    /[\\/?#@%*]/u.test(candidate) ||
    candidate.startsWith(".")
  ) {
    throw new Error("policy host must be an exact hostname, IP literal, or scoped wildcard");
  }

  if (candidate.startsWith("[") || candidate.endsWith("]")) {
    if (!(candidate.startsWith("[") && candidate.endsWith("]"))) {
      throw new Error("policy host contains malformed IPv6 brackets");
    }
    const address = candidate.slice(1, -1);
    if (isIP(address) !== 6) throw new Error("policy host is not an IPv6 literal");
    return address.toLowerCase();
  }

  const normalized = candidate.replace(/\.$/u, "").toLowerCase();
  if (isIP(normalized) !== 0) return normalized;
  if (normalized.includes(":")) throw new Error("policy host must not include a port");
  if (/^\d+(?:\.\d+){3}$/u.test(normalized) || normalized.length > 253) {
    throw new Error("policy host is malformed");
  }
  const labels = normalized.split(".");
  if (
    labels.some(
      (label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new Error("policy host is malformed");
  }
  return wildcard ? `*.${normalized}` : normalized;
}

async function resolveBlueprintPolicyAdditionHosts(
  additions: PolicyAdditions,
): Promise<PolicyAdditions> {
  const resolved: PolicyAdditions = {};
  for (const [policyName, addition] of Object.entries(additions)) {
    const endpoints: PolicyEndpoint[] = [];
    for (const [endpointIndex, endpoint] of addition.endpoints.entries()) {
      try {
        const host = normalizeBlueprintPolicyHost(endpoint.host);
        if (isPrivateHostname(host)) throw new Error("policy host is private or reserved");
        if (host.startsWith("*.")) {
          throw new Error("scoped wildcard policy hosts cannot be DNS-pinned safely");
        }
        const urlHost = isIP(host) === 6 ? `[${host}]` : host;
        const validated = await validateEndpointUrl(`http://${urlHost}:${String(endpoint.port)}`);
        const pinnedHost = normalizeBlueprintPolicyHost(new URL(validated.pinnedUrl).hostname);
        if (isIP(pinnedHost) === 0 && validated.dnsResolved) {
          throw new Error("policy hostname validation did not return a pinned IP address");
        }
        endpoints.push({ ...endpoint, host: pinnedHost });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "policy host is unsafe";
        throw new Error(
          `Blueprint policy addition '${policyName}' endpoint ${String(endpointIndex + 1)} is rejected: ${detail}.`,
          { cause: error },
        );
      }
    }
    resolved[policyName] = { ...addition, endpoints };
  }
  return resolved;
}

function isInferenceProfile(value: unknown): value is InferenceProfile {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    isOptionalString(value.provider_type) &&
    isOptionalString(value.provider_name) &&
    isOptionalString(value.endpoint) &&
    isOptionalString(value.model) &&
    isOptionalString(value.credential_env) &&
    isOptionalString(value.credential_default) &&
    isOptionalFiniteNumber(value.timeout_secs)
  );
}

function isBlueprint(value: unknown): value is Blueprint {
  if (!isPlainObject(value) || !Object.keys(value).every((key) => BLUEPRINT_KEYS.has(key))) {
    return false;
  }

  if (!isOptionalString(value.version)) {
    return false;
  }
  if (
    !isOptionalString(value.min_openshell_version) ||
    !isOptionalString(value.max_openshell_version)
  ) {
    return false;
  }
  const components = value.components;
  if (components === undefined) {
    return true;
  }
  if (!isPlainObject(components)) {
    return false;
  }

  const inference = components.inference;
  if (inference !== undefined) {
    if (!isPlainObject(inference)) {
      return false;
    }
    const profiles = inference.profiles;
    if (profiles !== undefined) {
      if (
        !isPlainObject(profiles) ||
        !Object.values(profiles).every((entry) => isInferenceProfile(entry))
      ) {
        return false;
      }
    }
  }

  const sandbox = components.sandbox;
  if (sandbox !== undefined) {
    if (!isPlainObject(sandbox)) {
      return false;
    }
    if (
      !isOptionalString(sandbox.image) ||
      !isOptionalString(sandbox.name) ||
      !isOptionalPortList(sandbox.forward_ports)
    ) {
      return false;
    }
  }

  const router = components.router;
  if (router !== undefined) {
    if (!isPlainObject(router)) {
      return false;
    }
    if (
      !isOptionalBoolean(router.enabled) ||
      !(router.port === undefined || isValidPort(router.port)) ||
      !isOptionalString(router.pool_config_path)
    ) {
      return false;
    }
  }

  const policy = components.policy;
  if (policy !== undefined) {
    if (!isPlainObject(policy)) {
      return false;
    }
    const additions = policy.additions;
    if (additions !== undefined) {
      if (!isPolicyAdditions(additions)) {
        return false;
      }
    }
  }

  const identity = components.identity;
  if (identity !== undefined && !isRuntimeIdentityConfig(identity)) return false;

  return true;
}

// ── Logging helpers ─────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(msg + "\n");
}

function progress(pct: number, label: string): void {
  process.stdout.write(`PROGRESS:${String(pct)}:${label}\n`);
}

function readRollbackSandboxName(value: RollbackPlanSource | null): string {
  if (!value || typeof value.sandbox_name !== "string" || value.sandbox_name.trim() === "") {
    throw new Error("rollback plan sandbox_name must be a non-empty string");
  }

  // The persisted plan is untrusted input at this boundary too: validate before
  // the name reaches `openshell sandbox stop/remove`, mirroring the apply path.
  return assertValidName(value.sandbox_name, "sandbox name");
}

function readRollbackInferenceProviderName(value: RollbackPlanSource): string {
  if (
    !isPlainObject(value.inference) ||
    typeof value.inference.provider_name !== "string" ||
    value.inference.provider_name.trim() === ""
  ) {
    throw new Error(
      "rollback plan inference.provider_name must be a non-empty string for an owned provider",
    );
  }
  return assertValidProviderName(value.inference.provider_name, "rollback inference provider name");
}

function readRollbackInferenceProviderBinding(value: RollbackPlanSource): {
  name: string;
  type: string;
  requiresEndpointConfig: boolean;
} {
  const name = readRollbackInferenceProviderName(value);
  if (
    !isPlainObject(value.inference) ||
    typeof value.inference.provider_type !== "string" ||
    value.inference.provider_type.trim() === ""
  ) {
    throw new Error(
      "rollback plan inference.provider_type must be a non-empty string for an owned provider",
    );
  }
  return {
    name,
    type: value.inference.provider_type,
    requiresEndpointConfig:
      typeof value.inference.endpoint === "string" && value.inference.endpoint !== "",
  };
}

function assertReusableInferenceProvider(
  output: string,
  expected: {
    name: string;
    type: string;
    requiresEndpointConfig: boolean;
    requiresCredential: boolean;
  },
): void {
  const metadata = parseRuntimeIdentityProviderMetadata(output);
  const hasExpectedConfigShape =
    !expected.requiresEndpointConfig || metadata?.configKeys.includes("OPENAI_BASE_URL") === true;
  const hasExpectedCredentialShape =
    !expected.requiresCredential || metadata?.credentialKeys.includes("OPENAI_API_KEY") === true;
  if (
    !metadata ||
    metadata.name !== expected.name ||
    metadata.type !== expected.type ||
    !hasExpectedConfigShape ||
    !hasExpectedCredentialShape
  ) {
    throw new Error(
      `Inference provider '${expected.name}' does not match the requested non-secret binding; refusing runtime identity apply`,
    );
  }
}

// ── Utilities ───────────────────────────────────────────────────

export function emitRunId(): string {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14)
    .replace(/^(\d{8})(\d{6})/, "$1-$2");
  const rid = `nc-${ts}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  process.stdout.write(`RUN_ID:${rid}\n`);
  return rid;
}

type InferenceProfileMap = { [profileName: string]: InferenceProfile };

interface Blueprint {
  version?: string;
  min_openshell_version?: string;
  max_openshell_version?: string;
  min_openclaw_version?: unknown;
  profiles?: unknown;
  openshell_target?: unknown;
  components?: {
    inference?: {
      profiles?: InferenceProfileMap;
    };
    sandbox?: SandboxConfig;
    router?: RouterConfig;
    policy?: {
      additions?: PolicyAdditions;
    };
    identity?: RuntimeIdentityConfig;
  };
}

interface InferenceProfile {
  provider_type?: string;
  provider_name?: string;
  endpoint?: string;
  model?: string;
  credential_env?: string;
  credential_default?: string;
  timeout_secs?: number;
}

interface SandboxConfig {
  image?: string;
  name?: string;
  forward_ports?: number[];
}

interface RouterConfig {
  enabled?: boolean;
  port?: number;
  pool_config_path?: string;
}

const DEFAULT_ROUTER_PORT = 4000;

function mergePolicyAdditions(currentPolicyRaw: string, additions: PolicyAdditions): string {
  // sourceOfTruth: nemoclaw/src/shared/openshell-policy-boundary.cts
  const current = parseOpenShellPolicy(currentPolicyRaw).policy;
  const existingNetworkPolicies = current.network_policies ?? {};
  const output: UnknownRecord = {};

  // OpenShell 0.0.72 and later expose composable top-level policy sections as
  // mappings. Preserve unknown mapping sections for forward compatibility, but
  // fail closed on a scalar or sequence until its mutation semantics are
  // reviewed for the next supported OpenShell contract.
  for (const [key, value] of Object.entries(current)) {
    if (key !== "version" && key !== "network_policies") {
      if (!isPlainObject(value)) {
        throw new Error(`Current policy top-level field "${key}" must be a YAML mapping`);
      }
      output[key] = value;
    }
  }

  output.version = current.version ?? 1;
  output.network_policies = withoutProviderComposedPolicies({
    ...existingNetworkPolicies,
    ...additions,
  });
  return YAML.stringify(output);
}

function assertBlueprintPolicyHandoffCredentialFree(policySource: string): void {
  const policy = parseOpenShellPolicy(policySource).policy;
  if (!isDeepStrictEqual(stripCredentials(policy), policy)) {
    throw new Error(
      "Cannot prepare the blueprint policy update because the live OpenShell policy contains a literal credential value. Replace literal credentials with supported OpenShell credential bindings or resolver placeholders, then retry.",
    );
  }
}

function blueprintBasePoliciesMatch(left: string, right: string): boolean {
  return isDeepStrictEqual(parseOpenShellPolicy(left).policy, parseOpenShellPolicy(right).policy);
}

function assertNoConflictingBlueprintPolicyChange(
  previousSource: string,
  currentSource: string,
  additions: PolicyAdditions,
): void {
  const previous = parseOpenShellPolicy(previousSource).policy.network_policies ?? {};
  const current = parseOpenShellPolicy(currentSource).policy.network_policies ?? {};
  for (const [key, required] of Object.entries(additions)) {
    const previousHasKey = Object.hasOwn(previous, key);
    const currentHasKey = Object.hasOwn(current, key);
    if (
      previousHasKey === currentHasKey &&
      (!currentHasKey || isDeepStrictEqual(previous[key], current[key]))
    ) {
      continue;
    }
    if (currentHasKey && isDeepStrictEqual(current[key], required)) continue;
    throw new Error(
      `Cannot reconcile the blueprint policy transition: network policy '${key}' changed concurrently.`,
    );
  }
}

function blueprintPolicyPreservationRequirements(
  basePolicySource: string,
  additions: PolicyAdditions,
): UnknownRecord {
  const base = structuredClone(parseOpenShellPolicy(basePolicySource).policy) as UnknownRecord;
  const preservedNetwork = withoutProviderComposedPolicies(
    (base.network_policies as UnknownRecord | undefined) ?? {},
  );
  for (const key of Object.keys(additions)) delete preservedNetwork[key];
  base.network_policies = preservedNetwork;
  return base;
}

export function loadBlueprint(): Blueprint {
  const blueprintPath = process.env.NEMOCLAW_BLUEPRINT_PATH ?? ".";
  const bpFile = join(blueprintPath, "blueprint.yaml");
  let content: string;
  try {
    content = readFileSync(bpFile, "utf-8");
  } catch {
    throw new Error("blueprint.yaml not found");
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch {
    throw new Error("blueprint.yaml contains invalid YAML");
  }
  if (!isBlueprint(parsed)) {
    throw new Error(
      "blueprint.yaml must contain a YAML mapping with valid nested component shapes",
    );
  }
  return parsed;
}

async function runCmd(
  args: string[],
  options?: {
    gateway?: string;
    maxBuffer?: number;
    omitSandboxPolicy?: boolean;
    reject?: boolean;
    timeout?: number;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = buildBlueprintOpenShellEnv(options?.gateway);
  if (options?.omitSandboxPolicy) {
    delete env.OPENSHELL_SANDBOX_POLICY;
  }
  const result = await execa(args[0], args.slice(1), {
    reject: options?.reject ?? true,
    stdout: "pipe",
    stderr: "pipe",
    env,
    extendEnv: false,
    ...(options?.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
    ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function buildBlueprintOpenShellEnv(
  gateway?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const env = buildSubprocessEnv(extra);
  if (gateway !== undefined) {
    env.OPENSHELL_GATEWAY = gateway;
  }
  delete env.OPENSHELL_GATEWAY_ENDPOINT;
  delete env.OPENSHELL_GATEWAY_INSECURE;
  return env;
}

async function inspectActiveGatewayBinding(): Promise<GatewayBinding> {
  const result = await runCmd(["openshell", "status"], { reject: false });
  const output = `${result.stderr}\n${result.stdout}`;
  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to inspect the active OpenShell gateway: ${boundedCommandError(output)}`,
    );
  }
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const gateways = lines
    .map((line) => /^\s*Gateway:\s*(.+?)\s*$/i.exec(line)?.[1]?.trim())
    .filter((gateway): gateway is string => Boolean(gateway));
  const connected = lines.some((line) => /^\s*Status:\s*Connected\b/i.test(line));
  if (!connected || gateways.length !== 1) {
    throw new Error(
      `Failed to prove the active OpenShell gateway identity: ${boundedCommandError(output)}`,
    );
  }
  const name = assertValidName(gateways[0], "OpenShell gateway name");
  return { name, ...(await inspectGatewayEndpoint(name)) };
}

type BlueprintInspectionFailure =
  | {
      readonly kind: "policy";
      readonly subject: "global" | "sandbox";
    }
  | {
      readonly kind: "state";
      readonly subject: "gateway" | "policy" | "sandbox";
    };

function blueprintInspectionFailureMessage(failure: BlueprintInspectionFailure): string {
  return failure.kind === "policy"
    ? `OpenShell ${failure.subject} policy inspection failed. Policy-dependent operations must stop.`
    : `OpenShell ${failure.subject} state inspection failed.`;
}

async function runBlueprintInspectionCommand(
  command: string[],
  gateway: string,
  failure: BlueprintInspectionFailure,
): Promise<Awaited<ReturnType<typeof runCmd>>> {
  const failureMessage = blueprintInspectionFailureMessage(failure);
  let result: Awaited<ReturnType<typeof runCmd>>;
  try {
    result = await runCmd(command, {
      gateway,
      maxBuffer: POLICY_INSPECTION_MAX_BYTES,
      reject: false,
      timeout: POLICY_INSPECTION_TIMEOUT_MS,
    });
  } catch {
    throw new Error(failureMessage);
  }
  if (
    result.exitCode !== 0 ||
    Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") >
      POLICY_INSPECTION_MAX_BYTES
  ) {
    throw new Error(failureMessage);
  }
  return result;
}

const blueprintOpenShellPolicyClient = createBlueprintOpenShellPolicyClient({
  captureRead: (command, gatewayName) =>
    runBlueprintInspectionCommand(command, gatewayName, {
      kind: "policy",
      subject: "sandbox",
    }),
  captureWrite: async (command, gatewayName) => {
    try {
      const result = await runCmd(command, {
        gateway: gatewayName,
        maxBuffer: POLICY_INSPECTION_MAX_BYTES,
        reject: false,
        timeout: POLICY_INSPECTION_TIMEOUT_MS,
      });
      return { status: result.exitCode, stderr: result.stderr };
    } catch {
      return {
        status: null,
        error: { message: "OpenShell policy write could not be observed" },
      };
    }
  },
});

async function inspectBlueprintPolicy(gateway: string): Promise<BlueprintPolicyInspection | null>;
async function inspectBlueprintPolicy(
  gateway: string,
  sandboxName: string,
): Promise<BlueprintPolicyInspection>;
async function inspectBlueprintPolicy(
  gateway: string,
  sandboxName?: string,
): Promise<BlueprintPolicyInspection | null> {
  if (sandboxName !== undefined) {
    try {
      return await blueprintOpenShellPolicyClient.inspectSandboxPolicy({
        gatewayName: gateway,
        sandboxName,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "OpenShell returned invalid metadata";
      throw new Error(`${detail}. Policy-dependent operations must stop.`);
    }
  }
  const history = await runBlueprintInspectionCommand(
    ["openshell", "policy", "list", "-g", gateway, "--global", "--limit", "1"],
    gateway,
    { kind: "policy", subject: "global" },
  );
  const historyState = classifyOpenShellGlobalPolicyHistory(history.stdout, history.stderr);
  if (historyState === "absent") {
    return null;
  }
  if (historyState === "invalid") {
    throw new Error(
      "OpenShell returned invalid global policy history. Policy-dependent operations must stop.",
    );
  }
  const result = await runBlueprintInspectionCommand(
    ["openshell", "policy", "get", "-g", gateway, "--global", "--full", "--output", "json"],
    gateway,
    {
      kind: "policy",
      subject: "global",
    },
  );
  try {
    const activeGlobalPolicy = parseActiveGlobalPolicyMetadata(result.stdout);
    return activeGlobalPolicy.state === "active" ? activeGlobalPolicy.inspection : null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "OpenShell returned invalid metadata";
    throw new Error(`${detail}. Policy-dependent operations must stop.`);
  }
}

function assertBlueprintPolicyRequirements(
  inspection: BlueprintPolicyInspection,
  additions: PolicyAdditions,
): void {
  try {
    assertPolicyRequirementContainment(inspection, {
      network_policies: additions,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the policy requirement is invalid";
    throw new Error(`Cannot reconcile the blueprint policy transition: ${detail}.`);
  }
}

function blueprintPolicyRequirementsSatisfied(
  inspection: BlueprintPolicyInspection,
  additions: PolicyAdditions,
): boolean {
  try {
    assertBlueprintPolicyRequirements(inspection, additions);
    return true;
  } catch {
    return false;
  }
}

async function readBlueprintBasePolicy(
  gatewayName: string,
  sandboxName: string,
): Promise<BlueprintPolicyRead> {
  return blueprintOpenShellPolicyClient.readSandboxBasePolicy({ gatewayName, sandboxName });
}

async function readBlueprintPolicyRevision(
  gatewayName: string,
  sandboxName: string,
  revision: number,
): Promise<BlueprintPolicyRead> {
  return blueprintOpenShellPolicyClient.readSandboxPolicyRevision({
    gatewayName,
    sandboxName,
    revision,
  });
}

async function submitBlueprintPolicyDocument(
  gatewayName: string,
  sandboxName: string,
  policyPath: string,
  policySource: string,
): Promise<BlueprintPolicySetSubmission> {
  assertBlueprintPolicyHandoffCredentialFree(policySource);
  writeFileSync(policyPath, policySource, {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    return await blueprintOpenShellPolicyClient.setSandboxPolicy({
      gatewayName,
      sandboxName,
      policyPath,
    });
  } finally {
    try {
      unlinkSync(policyPath);
    } catch {
      if (existsSync(policyPath)) {
        throw new Error(`Temporary blueprint policy remains at ${policyPath}`);
      }
    }
  }
}

function blueprintPolicyWriteFailure(submission: BlueprintPolicySetSubmission): string {
  return submission.outcome.kind === "rejected"
    ? boundedCommandError(submission.outcome.message)
    : submission.outcome.kind === "ambiguous"
      ? boundedCommandError(submission.outcome.detail)
      : `openshell policy set exited with status ${String(submission.status)}`;
}

async function applyBlueprintPolicyAdditions(
  gateway: GatewayBinding,
  sandboxName: string,
  additions: PolicyAdditions,
  temporaryDirectory: string,
): Promise<void> {
  if (Object.keys(additions).length === 0) return;
  const current = await inspectBlueprintPolicy(gateway.name, sandboxName);
  if (blueprintPolicyRequirementsSatisfied(current, additions)) return;

  let basePolicySource = (await readBlueprintBasePolicy(gateway.name, sandboxName)).document;
  let replayConcurrentPolicy = false;
  const policyPath = join(temporaryDirectory, "policy-update.yaml");

  for (let attempt = 1; attempt <= BLUEPRINT_POLICY_REBASE_ATTEMPTS; attempt += 1) {
    const beforeWrite = await inspectBlueprintPolicy(gateway.name, sandboxName);
    const replayingConcurrentPolicy = replayConcurrentPolicy;
    replayConcurrentPolicy = false;
    const latestPolicySource = replayingConcurrentPolicy
      ? basePolicySource
      : (await readBlueprintBasePolicy(gateway.name, sandboxName)).document;
    if (
      !replayingConcurrentPolicy &&
      !blueprintBasePoliciesMatch(basePolicySource, latestPolicySource)
    ) {
      assertNoConflictingBlueprintPolicyChange(basePolicySource, latestPolicySource, additions);
      basePolicySource = latestPolicySource;
      continue;
    }

    const mergedPolicySource = mergePolicyAdditions(latestPolicySource, additions);
    const submission = await submitBlueprintPolicyDocument(
      gateway.name,
      sandboxName,
      policyPath,
      mergedPolicySource,
    );
    if (submission.outcome.kind === "rejected") {
      throw new Error(
        `Failed to apply policy additions: ${blueprintPolicyWriteFailure(submission)}`,
      );
    }

    const applied = await inspectBlueprintPolicy(gateway.name, sandboxName);
    const appliedBase = await readBlueprintBasePolicy(gateway.name, sandboxName);
    const requestedIsCurrent = blueprintBasePoliciesMatch(appliedBase.document, mergedPolicySource);
    const concurrentRevision =
      applied.policyIdentity.activeVersion > beforeWrite.policyIdentity.activeVersion + 1;

    if (concurrentRevision) {
      const externalPolicySource = requestedIsCurrent
        ? (
            await readBlueprintPolicyRevision(
              gateway.name,
              sandboxName,
              applied.policyIdentity.activeVersion - 1,
            )
          ).document
        : appliedBase.document;
      try {
        assertNoConflictingBlueprintPolicyChange(
          latestPolicySource,
          externalPolicySource,
          additions,
        );
      } catch (error) {
        if (requestedIsCurrent) {
          const restoration = await submitBlueprintPolicyDocument(
            gateway.name,
            sandboxName,
            policyPath,
            externalPolicySource,
          );
          const restored = await readBlueprintBasePolicy(gateway.name, sandboxName);
          if (
            restoration.outcome.kind === "rejected" ||
            !blueprintBasePoliciesMatch(restored.document, externalPolicySource)
          ) {
            throw new Error(
              `Cannot reconcile the blueprint policy transition: the concurrent host policy could not be restored: ${blueprintPolicyWriteFailure(restoration)}.`,
            );
          }
        }
        throw error;
      }
      basePolicySource = externalPolicySource;
      replayConcurrentPolicy = requestedIsCurrent;
      continue;
    }

    if (!requestedIsCurrent) {
      throw new Error(
        submission.outcome.kind === "ambiguous"
          ? `Could not confirm the blueprint policy update: ${blueprintPolicyWriteFailure(submission)}.`
          : "OpenShell applied a different blueprint base policy than the requested document.",
      );
    }
    assertBlueprintPolicyRequirements(applied, additions);
    try {
      assertPolicyRequirementContainment(
        applied,
        blueprintPolicyPreservationRequirements(latestPolicySource, additions),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : "the live policy changed";
      throw new Error(
        `Cannot reconcile the blueprint policy transition: unrelated live policy was not preserved: ${detail}.`,
      );
    }
    return;
  }

  throw new Error(
    "Cannot reconcile the blueprint policy transition: the live OpenShell policy kept changing.",
  );
}

function readConfiguredSandboxPolicy(): { path: string } | null {
  const path = process.env.OPENSHELL_SANDBOX_POLICY?.trim();
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error("The configured NemoClaw sandbox policy could not be read");
  }
  try {
    parseOpenShellPolicy(raw);
    return { path };
  } catch {
    throw new Error("The configured NemoClaw sandbox policy is invalid");
  }
}

async function inspectGatewayEndpoint(name: string): Promise<{ host: string; port: number }> {
  const info = await runBlueprintInspectionCommand(
    ["openshell", "gateway", "info", "-g", name],
    name,
    { kind: "state", subject: "gateway" },
  );
  return parseSingleManagedGatewayEndpoint(`${info.stderr}\n${info.stdout}`);
}

async function runRuntimeIdentityCommand(
  args: string[],
  options?: RuntimeIdentityCommandOptions,
  gateway?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(args[0], args.slice(1), {
    reject: false,
    stdout: "pipe",
    stderr: "pipe",
    env: buildBlueprintOpenShellEnv(gateway, options?.env),
    extendEnv: false,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runtimeIdentityCommandDeps(gateway: string): RuntimeIdentityCommandDeps {
  return {
    run: (args, options) => runRuntimeIdentityCommand(args, options, gateway),
    formatError: boundedCommandError,
  };
}

function runtimeIdentityDeps(
  persistReceipt: (receipt: RuntimeIdentityReceipt) => void,
  gateway: string,
  profilePolicy?: RuntimeIdentityProfilePolicy,
): RuntimeIdentityDeps {
  return {
    ...runtimeIdentityCommandDeps(gateway),
    validateEndpointUrl,
    persistReceipt,
    blueprintPath: process.env.NEMOCLAW_BLUEPRINT_PATH ?? ".",
    env: process.env,
    profilePolicy,
  };
}

async function openshellAvailable(): Promise<boolean> {
  const result = await execa("which", ["openshell"], {
    reject: false,
    stdout: "pipe",
    env: buildSubprocessEnv(),
    extendEnv: false,
  });
  return result.exitCode === 0;
}

/**
 * Resolve inference config and sandbox config from a blueprint, applying
 * endpoint URL override and SSRF validation if provided.
 */
async function resolveRunConfig(
  profile: string,
  blueprint: Blueprint,
  endpointUrl?: string,
): Promise<{
  inferenceProfiles: InferenceProfileMap;
  inferenceCfg: InferenceProfile;
  sandboxCfg: SandboxConfig;
  routerCfg: RouterConfig;
  policyAdditions: PolicyAdditions;
}> {
  const inferenceProfiles = blueprint.components?.inference?.profiles ?? {};
  if (!(profile in inferenceProfiles)) {
    const available = Object.keys(inferenceProfiles).join(", ");
    throw new Error(`Profile '${profile}' not found. Available: ${available}`);
  }

  const policyAdditions = await resolveBlueprintPolicyAdditionHosts(
    blueprint.components?.policy?.additions ?? {},
  );

  let inferenceCfg = { ...inferenceProfiles[profile] };
  if (endpointUrl) {
    const validated = await validateEndpointUrl(endpointUrl);
    inferenceCfg = { ...inferenceCfg, endpoint: safeEndpointUrlForDownstream(validated) };
  }

  // Validate the final endpoint (whether from CLI override or blueprint profile)
  if (inferenceCfg.endpoint) {
    const validated = await validateEndpointUrl(inferenceCfg.endpoint);
    inferenceCfg = { ...inferenceCfg, endpoint: safeEndpointUrlForDownstream(validated) };
  }

  const sandboxCfg = blueprint.components?.sandbox ?? {};
  const routerCfg = blueprint.components?.router ?? {};

  // A blueprint is untrusted input. Validate the identifiers that flow into
  // `openshell ... --name <value>` argv slots (and onward to shell scripts and
  // Kubernetes pod names) at this ingestion boundary and fail closed, so every
  // downstream consumer receives a name that is safe by construction. Absent
  // values fall back to validated defaults ("openclaw" / "default") at the use
  // sites and are intentionally not rejected here.
  if (sandboxCfg.name !== undefined) {
    assertValidName(sandboxCfg.name, "sandbox name");
  }
  if (inferenceCfg.provider_name !== undefined) {
    assertValidProviderName(inferenceCfg.provider_name);
  }

  return { inferenceProfiles, inferenceCfg, sandboxCfg, routerCfg, policyAdditions };
}

// ── Actions ─────────────────────────────────────────────────────

export interface RunPlan {
  run_id: string;
  profile: string;
  sandbox: {
    image: string;
    name: string;
    forward_ports: number[];
  };
  inference: {
    provider_type: string | undefined;
    provider_name: string | undefined;
    endpoint: string | undefined;
    model: string | undefined;
  };
  router: {
    enabled: boolean;
    port: number;
    pool_config_path: string | undefined;
  };
  identity?: RuntimeIdentityPlan;
  policy_additions: PolicyAdditions;
  dry_run: boolean;
}

export interface ExternalOpenShellTargetRunPlan {
  run_id: string;
  openshell_target: SanitizedExternalOpenShellTargetPlan;
  dry_run: boolean;
}

interface SafeInferencePlan {
  provider_type: string | undefined;
  provider_name: string | undefined;
  endpoint: string | undefined;
  model: string | undefined;
}

interface PersistedRunPlan {
  run_id: string;
  profile: string;
  sandbox_name: string;
  sandbox_created_by_apply: boolean;
  inference_provider_created_by_apply: boolean;
  gateway: GatewayBinding;
  inference: SafeInferencePlan;
  identity?: RuntimeIdentityReceipt;
  timestamp: string;
}

type StatusRunPlan = {
  run_id: string;
  profile?: string;
  sandbox?: {
    image?: string;
    name?: string;
    forward_ports?: number[];
  };
  sandbox_name?: string;
  sandbox_created_by_apply?: boolean;
  inference_provider_created_by_apply?: boolean;
  gateway?: GatewayBinding;
  inference?: SafeInferencePlan;
  identity?: RuntimeIdentityReceipt;
  router?: {
    enabled?: boolean;
    port?: number;
    pool_config_path?: string;
  };
  timestamp?: string;
  dry_run?: boolean;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isGatewayBinding(value: unknown): value is GatewayBinding {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, ["name", "host", "port"] as const) &&
    isValidName(value.name) &&
    isManagedGatewayEndpointHost(value.host) &&
    isValidPort(value.port)
  );
}

function buildSafeInferencePlan(source: InferenceProfile | UnknownRecord): SafeInferencePlan {
  return {
    provider_type: optionalString(source.provider_type),
    provider_name: optionalString(source.provider_name),
    endpoint: optionalString(source.endpoint),
    model: optionalString(source.model),
  };
}

function buildSafePublicRunPlan(args: {
  runId: string;
  profile: string;
  inferenceCfg: InferenceProfile;
  sandboxCfg: SandboxConfig;
  routerCfg: RouterConfig;
  runtimeIdentityConfig?: RuntimeIdentityConfig;
  policyAdditions: PolicyAdditions;
  dryRun: boolean;
}): RunPlan {
  const routerEnabled = args.routerCfg.enabled === true;
  const routerPort = args.routerCfg.port ?? DEFAULT_ROUTER_PORT;

  const plan: RunPlan = {
    run_id: args.runId,
    profile: args.profile,
    sandbox: {
      image: args.sandboxCfg.image ?? "openclaw",
      name: args.sandboxCfg.name ?? "openclaw",
      forward_ports: args.sandboxCfg.forward_ports ?? [DASHBOARD_PORT],
    },
    inference: buildSafeInferencePlan(args.inferenceCfg),
    router: {
      enabled: routerEnabled,
      port: routerPort,
      pool_config_path: args.routerCfg.pool_config_path,
    },
    policy_additions: args.policyAdditions,
    dry_run: args.dryRun,
  };
  if (args.runtimeIdentityConfig) {
    plan.identity = buildRuntimeIdentityPlan(args.runtimeIdentityConfig);
  }
  return plan;
}

function buildPersistedRunPlan(args: {
  runId: string;
  profile: string;
  sandboxName: string;
  sandboxCreatedByApply: boolean;
  inferenceProviderCreatedByApply: boolean;
  gateway: GatewayBinding;
  inferenceCfg: InferenceProfile;
  runtimeIdentityReceipt?: RuntimeIdentityReceipt;
  timestamp: string;
}): PersistedRunPlan {
  const plan: PersistedRunPlan = {
    run_id: args.runId,
    profile: args.profile,
    sandbox_name: args.sandboxName,
    sandbox_created_by_apply: args.sandboxCreatedByApply,
    inference_provider_created_by_apply: args.inferenceProviderCreatedByApply,
    gateway: args.gateway,
    inference: buildSafeInferencePlan(args.inferenceCfg),
    timestamp: args.timestamp,
  };
  if (args.runtimeIdentityReceipt) {
    plan.identity = args.runtimeIdentityReceipt;
  }
  return plan;
}

function persistRunReceipt(planFile: string, plan: unknown): void {
  const pendingFile = `${planFile}.pending`;
  writeFileSync(pendingFile, JSON.stringify(plan, null, 2), { encoding: "utf-8", mode: 0o600 });
  const pendingFd = openSync(pendingFile, "r");
  try {
    fsyncSync(pendingFd);
  } finally {
    closeSync(pendingFd);
  }
  renameSync(pendingFile, planFile);
  const stateDirFd = openSync(dirname(planFile), "r");
  try {
    fsyncSync(stateDirFd);
  } finally {
    closeSync(stateDirFd);
  }
}

function buildStatusRunPlan(source: unknown, fallbackRunId: string): StatusRunPlan | null {
  if (!isPlainObject(source)) {
    return null;
  }

  const safePlan: StatusRunPlan = {
    run_id: optionalString(source.run_id) ?? fallbackRunId,
  };

  const profile = optionalString(source.profile);
  if (profile !== undefined) {
    safePlan.profile = profile;
  }

  if (isPlainObject(source.sandbox)) {
    const sandbox: StatusRunPlan["sandbox"] = {};
    const image = optionalString(source.sandbox.image);
    const name = optionalString(source.sandbox.name);
    const forwardPorts = isOptionalPortList(source.sandbox.forward_ports)
      ? source.sandbox.forward_ports
      : undefined;
    if (image !== undefined) {
      sandbox.image = image;
    }
    if (name !== undefined) {
      sandbox.name = name;
    }
    if (forwardPorts !== undefined) {
      sandbox.forward_ports = forwardPorts;
    }
    if (Object.keys(sandbox).length > 0) {
      safePlan.sandbox = sandbox;
    }
  }

  const sandboxName = optionalString(source.sandbox_name);
  if (sandboxName !== undefined) {
    safePlan.sandbox_name = sandboxName;
  }
  if (typeof source.sandbox_created_by_apply === "boolean") {
    safePlan.sandbox_created_by_apply = source.sandbox_created_by_apply;
  }
  if (typeof source.inference_provider_created_by_apply === "boolean") {
    safePlan.inference_provider_created_by_apply = source.inference_provider_created_by_apply;
  }

  if (source.gateway !== undefined && !isGatewayBinding(source.gateway)) return null;
  if (isGatewayBinding(source.gateway)) safePlan.gateway = source.gateway;

  if (isPlainObject(source.inference)) {
    safePlan.inference = buildSafeInferencePlan(source.inference);
  }

  if (isRuntimeIdentityReceipt(source.identity)) {
    safePlan.identity = source.identity;
  }

  if (isPlainObject(source.router)) {
    const router: StatusRunPlan["router"] = {};
    if (typeof source.router.enabled === "boolean") {
      router.enabled = source.router.enabled;
    }
    if (isValidPort(source.router.port)) {
      router.port = source.router.port;
    }
    const poolConfigPath = optionalString(source.router.pool_config_path);
    if (poolConfigPath !== undefined) {
      router.pool_config_path = poolConfigPath;
    }
    if (Object.keys(router).length > 0) {
      safePlan.router = router;
    }
  }

  const timestamp = optionalString(source.timestamp);
  if (timestamp !== undefined) {
    safePlan.timestamp = timestamp;
  }
  if (typeof source.dry_run === "boolean") {
    safePlan.dry_run = source.dry_run;
  }

  return safePlan;
}

export async function actionPlan(
  profile: string,
  blueprint: Blueprint,
  options?: { dryRun?: boolean; endpointUrl?: string },
): Promise<RunPlan> {
  if (blueprint.openshell_target !== undefined) {
    throw new Error(
      "External OpenShell targets use the target-only plan path until typed readiness and inventory are available.",
    );
  }
  const rid = emitRunId();
  progress(10, "Validating blueprint");

  const { inferenceCfg, sandboxCfg, routerCfg, policyAdditions } = await resolveRunConfig(
    profile,
    blueprint,
    options?.endpointUrl,
  );

  progress(20, "Checking prerequisites");
  if (!(await openshellAvailable())) {
    throw new Error(
      "openshell CLI not found. Install OpenShell first.\n  See: https://github.com/NVIDIA/OpenShell",
    );
  }

  const plan = buildSafePublicRunPlan({
    runId: rid,
    profile,
    inferenceCfg,
    sandboxCfg,
    routerCfg,
    runtimeIdentityConfig: blueprint.components?.identity,
    policyAdditions,
    dryRun: options?.dryRun ?? false,
  });

  progress(100, "Plan complete");
  log(JSON.stringify(plan, null, 2));
  return plan;
}

export function actionExternalOpenShellTargetPlan(
  blueprint: Blueprint,
  options?: { dryRun?: boolean },
): ExternalOpenShellTargetRunPlan {
  const { target, compatibility } = validateExternalOpenShellTargetBlueprint(blueprint, "planning");

  const targetPlan = buildSanitizedExternalOpenShellTargetPlan(target, compatibility);
  const rid = emitRunId();
  progress(10, "Validating external OpenShell target");
  const plan: ExternalOpenShellTargetRunPlan = {
    run_id: rid,
    openshell_target: targetPlan,
    dry_run: options?.dryRun ?? false,
  };
  progress(100, "External target plan complete");
  log(JSON.stringify(plan, null, 2));
  return plan;
}

function validateExternalOpenShellTargetBlueprint(
  blueprint: Blueprint,
  action: "planning" | "status",
): Readonly<{ target: unknown; compatibility: OpenShellCompatibilityRange }> {
  if (blueprint.openshell_target === undefined) {
    throw new Error("blueprint does not declare an external OpenShell target");
  }
  if (blueprint.version === undefined || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(blueprint.version)) {
    throw new Error(
      `External OpenShell target ${action} requires blueprint version in X.Y.Z format.`,
    );
  }
  if (
    blueprint.min_openshell_version === undefined ||
    blueprint.max_openshell_version === undefined
  ) {
    throw new Error(
      `External OpenShell target ${action} requires blueprint min_openshell_version and max_openshell_version.`,
    );
  }
  for (const field of ["components", "profiles", "min_openclaw_version"] as const) {
    if (blueprint[field] !== undefined) {
      throw new Error(`External OpenShell target ${action} does not accept '${field}'.`);
    }
  }
  return {
    target: blueprint.openshell_target,
    compatibility: {
      minVersion: blueprint.min_openshell_version,
      maxVersion: blueprint.max_openshell_version,
    },
  };
}

export async function actionExternalOpenShellTargetStatus(
  blueprint: Blueprint,
  observer: OpenShellGatewayHealthObserver,
): Promise<ExternalOpenShellTargetStatus> {
  const { target, compatibility } = validateExternalOpenShellTargetBlueprint(blueprint, "status");

  const observation = await withExternalOpenShellTargetCa(
    target,
    compatibility,
    async (target, caContents) => {
      const rid = emitRunId();
      progress(10, "Validating external OpenShell target");
      const observed = await observeExternalOpenShellGatewayHealth(observer, {
        target,
        caBundle: caContents,
        timeoutMs: 5_000,
      });
      if (!observed.ok) throw new Error(observed.error.message);
      return Object.freeze({ run_id: rid, ...observed.value });
    },
  );
  progress(100, "External target status complete");
  log(JSON.stringify(observation, null, 2));
  return observation;
}

export async function actionApply(
  profile: string,
  blueprint: Blueprint,
  options?: {
    planPath?: string;
    endpointUrl?: string;
    /** Code-only conformance-test seam. No CLI flag or environment input populates this policy. */
    runtimeIdentityProfilePolicy?: RuntimeIdentityProfilePolicy;
  },
): Promise<void> {
  if (options?.planPath) {
    throw new Error(
      "--plan is not yet implemented. Run apply without --plan to use the live blueprint.",
    );
  }

  if (blueprint.openshell_target !== undefined) {
    throw new Error(
      "External OpenShell target apply is not available until typed readiness and inventory are implemented.",
    );
  }

  const rid = emitRunId();

  const {
    inferenceCfg,
    sandboxCfg,
    policyAdditions: resolvedPolicyAdditions,
  } = await resolveRunConfig(profile, blueprint, options?.endpointUrl);

  const sandboxName = sandboxCfg.name ?? "openclaw";
  const sandboxImage = sandboxCfg.image ?? "openclaw";
  const forwardPorts = sandboxCfg.forward_ports ?? [DASHBOARD_PORT];
  const policyAdditions = withoutProviderComposedPolicies(resolvedPolicyAdditions);
  const runtimeIdentityConfig = blueprint.components?.identity;
  const providerName = inferenceCfg.provider_name ?? "default";
  const providerType = inferenceCfg.provider_type ?? "openai";
  const endpoint = inferenceCfg.endpoint ?? "";
  const model = inferenceCfg.model ?? "";
  const credentialEnv = inferenceCfg.credential_env;
  const credentialDefault = inferenceCfg.credential_default ?? "";
  let credential = "";
  if (credentialEnv) {
    credential = process.env[credentialEnv] ?? credentialDefault;
  }
  const policyGateway = await inspectActiveGatewayBinding();
  const globalPolicy = await inspectBlueprintPolicy(policyGateway.name);
  const configuredSandboxPolicy = globalPolicy ? null : readConfiguredSandboxPolicy();
  const stateDir = join(homedir(), ".nemoclaw", "state", "runs", rid);
  mkdirSync(stateDir, { recursive: true });

  let runtimeIdentityReceipt: RuntimeIdentityReceipt | undefined;
  let sandboxCreatedByApply = false;
  let inferenceProviderCreatedByApply = false;
  const persistRunPlan = (): void => {
    persistRunReceipt(
      join(stateDir, "plan.json"),
      buildPersistedRunPlan({
        runId: rid,
        profile,
        sandboxName,
        sandboxCreatedByApply,
        inferenceProviderCreatedByApply,
        gateway: policyGateway,
        inferenceCfg,
        runtimeIdentityReceipt,
        timestamp: new Date().toISOString(),
      }),
    );
  };
  const requireLivePolicy = async (): Promise<BlueprintPolicyInspection> => {
    const liveGateway = await inspectActiveGatewayBinding();
    if (!isDeepStrictEqual(liveGateway, policyGateway)) {
      throw new Error("The OpenShell gateway binding changed during blueprint apply.");
    }
    return inspectBlueprintPolicy(policyGateway.name, sandboxName);
  };
  const requireCreatePolicyBoundary = async (): Promise<void> => {
    const liveGateway = await inspectActiveGatewayBinding();
    if (
      liveGateway.name !== policyGateway.name ||
      liveGateway.host !== policyGateway.host ||
      liveGateway.port !== policyGateway.port
    ) {
      throw new Error("The OpenShell gateway binding changed before sandbox creation.");
    }
  };
  const identityDeps = runtimeIdentityDeps(
    (receipt) => {
      const previousReceipt = runtimeIdentityReceipt;
      runtimeIdentityReceipt = receipt;
      try {
        persistRunPlan();
      } catch (error) {
        runtimeIdentityReceipt = previousReceipt;
        throw error;
      }
    },
    policyGateway.name,
    options?.runtimeIdentityProfilePolicy,
  );

  try {
    let reuseExistingInferenceProvider = false;
    let reuseExistingInferenceRoute = false;
    progress(20, "Creating OpenClaw sandbox");
    const createArgs = [
      "openshell",
      "sandbox",
      "create",
      "-g",
      policyGateway.name,
      "--from",
      sandboxImage,
      "--name",
      sandboxName,
    ];
    if (configuredSandboxPolicy) {
      createArgs.push("--policy", configuredSandboxPolicy.path);
    }
    for (const port of forwardPorts) {
      createArgs.push("--forward", String(port));
    }

    await requireCreatePolicyBoundary();
    const createResult = await runCmd(createArgs, {
      gateway: policyGateway.name,
      omitSandboxPolicy: true,
      reject: false,
    });
    if (createResult.exitCode !== 0) {
      if (createResult.stderr.includes("already exists")) {
        log(`Sandbox '${sandboxName}' already exists; using its current OpenShell policy.`);
      } else {
        throw new Error(`Failed to create sandbox: ${boundedCommandError(createResult.stderr)}`);
      }
    } else {
      sandboxCreatedByApply = true;
      persistRunPlan();
    }

    persistRunPlan();

    if (Object.keys(policyAdditions).length > 0) {
      progress(30, "Applying policy additions");
      await applyBlueprintPolicyAdditions(policyGateway, sandboxName, policyAdditions, stateDir);
    }
    assertBlueprintPolicyRequirements(await requireLivePolicy(), policyAdditions);

    if (runtimeIdentityConfig) {
      const providerResult = await runCmd(["openshell", "provider", "get", providerName], {
        gateway: policyGateway.name,
        reject: false,
      });
      const providerOutput = `${providerResult.stderr}\n${providerResult.stdout}`;
      if (providerResult.exitCode === 0) {
        assertReusableInferenceProvider(providerResult.stdout, {
          name: providerName,
          type: providerType,
          requiresEndpointConfig: endpoint !== "",
          requiresCredential: credential !== "",
        });
        reuseExistingInferenceProvider = true;
      } else if (!MISSING_PROVIDER_INSPECTION_PATTERN.test(providerOutput)) {
        throw new Error(
          `Failed to inspect inference provider '${providerName}' before runtime identity apply: ${boundedCommandError(providerOutput)}`,
        );
      }
      if (reuseExistingInferenceProvider) {
        const routeResult = await runCmd(["openshell", "inference", "get"], {
          gateway: policyGateway.name,
          reject: false,
        });
        if (routeResult.exitCode !== 0) {
          throw new Error(
            `Failed to inspect the active inference route before runtime identity apply: ${boundedCommandError(`${routeResult.stderr}\n${routeResult.stdout}`)}`,
          );
        }
        const activeRoute = parseInferenceRouteBinding(routeResult.stdout);
        if (!activeRoute && !isUnconfiguredInferenceRoute(routeResult.stdout)) {
          throw new Error(
            "Failed to parse the active inference route before runtime identity apply",
          );
        }
        reuseExistingInferenceRoute =
          activeRoute?.provider === providerName &&
          activeRoute.model === model &&
          (inferenceCfg.timeout_secs === undefined ||
            activeRoute.timeoutSeconds === inferenceCfg.timeout_secs);
      }
      progress(40, "Configuring runtime identity");
      runtimeIdentityReceipt = await prepareRuntimeIdentity(runtimeIdentityConfig, identityDeps);
      persistRunPlan();
    }

    // Keep runtime credentials unattached until OpenShell accepts the
    // sandbox's requested inference route.
    progress(50, "Configuring inference provider");
    if (reuseExistingInferenceProvider) {
      log(`Provider '${providerName}' already exists, reusing.`);
    } else {
      const providerArgs = [
        "openshell",
        "provider",
        "create",
        "--name",
        providerName,
        "--type",
        providerType,
      ];
      // Pass the env-var NAME (not the value) to --credential; openshell reads the value from the env.
      // Scope the credential to the subprocess to avoid leaking into later commands.
      const credEnv: Record<string, string> = {};
      if (credential) {
        credEnv.OPENAI_API_KEY = credential;
        providerArgs.push("--credential", "OPENAI_API_KEY");
      }
      if (endpoint) {
        providerArgs.push("--config", `OPENAI_BASE_URL=${endpoint}`);
      }
      const providerResult = await execa(providerArgs[0], providerArgs.slice(1), {
        reject: false,
        stdout: "pipe",
        stderr: "pipe",
        env: buildBlueprintOpenShellEnv(policyGateway.name, credEnv),
        extendEnv: false,
      });
      // A required mutation: a silently-ignored failure would persist plan.json and
      // report a ready sandbox that cannot perform inference. Mirror the
      // sandbox-create contract above — tolerate an already-existing provider as a
      // reuse (keeps re-apply idempotent) and fail on any other non-zero result.
      // The credential is passed via env (never argv); redact it from stderr before
      // surfacing bounded diagnostic context. (#6703)
      if (providerResult.exitCode !== 0) {
        if (providerResult.stderr.includes("already exists")) {
          if (runtimeIdentityConfig) {
            const racedProvider = await runCmd(["openshell", "provider", "get", providerName], {
              gateway: policyGateway.name,
              reject: false,
            });
            if (racedProvider.exitCode !== 0) {
              throw new Error(
                `Failed to inspect inference provider '${providerName}' after concurrent creation: ${boundedCommandError(`${racedProvider.stderr}\n${racedProvider.stdout}`)}`,
              );
            }
            assertReusableInferenceProvider(racedProvider.stdout, {
              name: providerName,
              type: providerType,
              requiresEndpointConfig: endpoint !== "",
              requiresCredential: credential !== "",
            });
          }
          log(`Provider '${providerName}' already exists, reusing.`);
        } else {
          throw new Error(
            `Failed to create inference provider '${providerName}': ${boundedCommandError(providerResult.stderr, [credential])}`,
          );
        }
      } else {
        inferenceProviderCreatedByApply = true;
        // Persist inference-provider ownership before a later route or policy mutation can fail.
        try {
          persistRunPlan();
        } catch (error) {
          inferenceProviderCreatedByApply = false;
          throw error;
        }
      }
    }

    progress(70, "Setting inference route");
    if (reuseExistingInferenceRoute) {
      log(`Inference route '${providerName} / ${model}' is already active, reusing.`);
    } else {
      const inferenceArgs = [
        "openshell",
        "inference",
        "set",
        "--provider",
        providerName,
        "--model",
        model,
      ];
      if (inferenceCfg.timeout_secs !== undefined) {
        inferenceArgs.push("--timeout", String(inferenceCfg.timeout_secs));
      }
      const inferenceResult = await runCmd(inferenceArgs, {
        gateway: policyGateway.name,
        reject: false,
      });
      // Another required mutation: without a routed provider the sandbox cannot
      // perform inference, so a non-zero result must abort the apply. (#6703)
      if (inferenceResult.exitCode !== 0) {
        throw new Error(
          `Failed to set inference route (provider '${providerName}', model '${model}'): ${boundedCommandError(inferenceResult.stderr)}`,
        );
      }
    }

    if (runtimeIdentityReceipt) {
      const attachmentCreated = await attachRuntimeIdentity(
        runtimeIdentityReceipt,
        sandboxName,
        identityDeps,
      );
      runtimeIdentityReceipt = {
        ...runtimeIdentityReceipt,
        attachment_created: attachmentCreated,
      };
      try {
        persistRunPlan();
      } catch (error) {
        throw error;
      }
      await mintRuntimeIdentityCredential(runtimeIdentityReceipt, identityDeps);
    }

    progress(85, "Saving run state");
    persistRunPlan();

    progress(100, "Apply complete");
    log(`Sandbox '${sandboxName}' is ready.`);
    log(`Inference: ${providerName} -> ${model} @ ${endpoint}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      runtimeIdentityReceipt !== undefined ||
      inferenceProviderCreatedByApply ||
      sandboxCreatedByApply
    ) {
      throw new Error(
        `${message}; automatic cleanup was refused because OpenShell can remove or detach the retained resources only by mutable resource names. Preserve run ${rid} for identity-bound recovery.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function validateRunId(rid: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(rid)) {
    throw new Error(
      `Invalid run ID: must contain only alphanumeric characters, hyphens, and underscores`,
    );
  }
}

function safeRunDir(runsDir: string, rid: string): string {
  validateRunId(rid);
  const resolved = join(runsDir, rid);
  if (!resolved.startsWith(runsDir + sep)) {
    throw new Error("Run ID resolves outside expected directory");
  }
  return resolved;
}

export function actionStatus(rid?: string): void {
  emitRunId();
  const runsDir = join(homedir(), ".nemoclaw", "state", "runs");

  let runDir: string;
  if (rid) {
    runDir = safeRunDir(runsDir, rid);
  } else {
    let runs: string[];
    try {
      runs = readdirSync(runsDir).sort().reverse();
    } catch {
      log("No runs found.");
      return;
    }
    if (runs.length === 0) {
      log("No runs found.");
      return;
    }
    runDir = join(runsDir, runs[0]);
  }

  const name = runDir.split("/").pop() ?? "unknown";
  const planFile = join(runDir, "plan.json");
  const unknownStatus = (
    receiptErrorKind: "corrupt" | "inaccessible" | "invalid" | "missing",
    error: unknown,
  ): void => {
    const detail = boundedCommandError(error instanceof Error ? error.message : String(error));
    log(
      JSON.stringify(
        {
          run_id: name,
          status: "unknown",
          receipt_error_kind: receiptErrorKind,
          receipt_error: detail,
          run_directory: runDir,
          recovery:
            "Do not reconstruct plan.json. Reconcile and rollback remain disabled. Recover the original receipt from a trusted copy produced by this exact run, then ask a NemoClaw maintainer to validate its run ID and resource bindings before using it. If no trusted copy exists, stop and ask a NemoClaw maintainer for recovery direction.",
        },
        null,
        2,
      ),
    );
  };

  if (!existsSync(planFile)) {
    unknownStatus("missing", new Error("plan.json is missing"));
    return;
  }
  let planData: string;
  try {
    planData = readFileSync(planFile, "utf-8");
  } catch (error) {
    const code = isPlainObject(error) && typeof error.code === "string" ? error.code : undefined;
    unknownStatus(code === "ENOENT" ? "missing" : "inaccessible", error);
    return;
  }

  let parsedPlan: unknown;
  try {
    parsedPlan = JSON.parse(planData);
  } catch (error) {
    unknownStatus("corrupt", error);
    return;
  }
  const safePlan = buildStatusRunPlan(parsedPlan, name);
  if (!safePlan) {
    unknownStatus("invalid", new Error("plan.json must contain a valid run receipt"));
    return;
  }
  log(JSON.stringify(safePlan, null, 2));
}

export async function actionReconcile(rid: string): Promise<void> {
  emitRunId();

  const runsDir = join(homedir(), ".nemoclaw", "state", "runs");
  const stateDir = safeRunDir(runsDir, rid);
  try {
    readdirSync(stateDir);
  } catch {
    throw new Error(`Run ${rid} not found.`);
  }

  let sandboxName: string;
  let gateway: GatewayBinding;
  try {
    const parsedPlan: unknown = JSON.parse(readFileSync(join(stateDir, "plan.json"), "utf-8"));
    if (!isPlainObject(parsedPlan)) {
      throw new Error("plan.json must contain a JSON object");
    }
    const plan = parsedPlan as ReconciliationPlanSource;
    sandboxName = readRollbackSandboxName(plan);
    if (!isGatewayBinding(plan.gateway)) throw new Error("gateway binding is invalid");
    gateway = plan.gateway;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read reconciliation plan for run ${rid}: ${detail}`);
  }
  const endpoint = await inspectGatewayEndpoint(gateway.name);
  if (endpoint.host !== gateway.host || endpoint.port !== gateway.port) {
    throw new Error("Cannot reconcile the blueprint: the OpenShell gateway binding changed.");
  }
  log(
    `Run ${rid} targets sandbox '${sandboxName}', whose policy is managed directly by OpenShell; NemoClaw has no stored policy intent to reconcile.`,
  );
}

export async function actionRollback(rid: string): Promise<void> {
  emitRunId();

  const runsDir = join(homedir(), ".nemoclaw", "state", "runs");
  const stateDir = safeRunDir(runsDir, rid);
  try {
    readdirSync(stateDir);
  } catch {
    throw new Error(`Run ${rid} not found.`);
  }

  const planFile = join(stateDir, "plan.json");
  let sandboxName: string;
  let sandboxCreatedByApply = false;
  let inferenceProviderCreatedByApply = false;
  let runtimeIdentityReceipt: RuntimeIdentityReceipt | undefined;
  try {
    const planData = readFileSync(planFile, "utf-8");
    const parsedPlan: unknown = JSON.parse(planData);
    const rollbackPlan: RollbackPlanSource | null =
      typeof parsedPlan === "object" && parsedPlan !== null && !Array.isArray(parsedPlan)
        ? parsedPlan
        : null;
    sandboxName = readRollbackSandboxName(rollbackPlan);
    sandboxCreatedByApply = rollbackPlan?.sandbox_created_by_apply === true;
    inferenceProviderCreatedByApply = rollbackPlan?.inference_provider_created_by_apply === true;
    if (inferenceProviderCreatedByApply) {
      readRollbackInferenceProviderBinding(rollbackPlan!);
    }
    if (rollbackPlan?.identity !== undefined) {
      if (!isRuntimeIdentityReceipt(rollbackPlan.identity)) {
        throw new Error("identity ownership receipt is invalid");
      }
      runtimeIdentityReceipt = rollbackPlan.identity;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read rollback plan for run ${rid}: ${detail}`);
  }

  if (
    runtimeIdentityReceipt !== undefined ||
    sandboxCreatedByApply ||
    inferenceProviderCreatedByApply
  ) {
    throw new Error(
      `Cannot roll back run ${rid}: OpenShell exposes cleanup only through mutable sandbox and provider names. The sandbox, providers, and run receipt were preserved for identity-bound recovery.`,
    );
  } else {
    progress(70, `Preserving unowned sandbox ${sandboxName}`);
  }

  progress(90, "Cleaning up run state");
  writeFileSync(join(stateDir, "rolled_back"), new Date().toISOString());

  progress(100, "Rollback complete");
}

// ── CLI ─────────────────────────────────────────────────────────

export async function main(
  argv: string[] = process.argv.slice(2),
  options: {
    gatewayHealthObserver?: OpenShellGatewayHealthObserver;
    snapshotCommand?: SnapshotCommandOptions;
    /** Code-only conformance-test seam. No CLI flag or environment input populates this policy. */
    runtimeIdentityProfilePolicy?: RuntimeIdentityProfilePolicy;
  } = {},
): Promise<void> {
  const rawAction = argv.at(0);
  const action = isAction(rawAction) ? rawAction : undefined;
  let profile = "default";
  let profileProvided = false;
  let planPath: string | undefined;
  let runId: string | undefined;
  let dryRun = false;
  let endpointUrl: string | undefined;
  let externalTargetStatus = false;

  function requireValue(flag: string, i: number): string {
    if (i >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[i];
  }

  if (!action) {
    if (rawAction === "snapshots") {
      actionSnapshots(argv.slice(1), options.snapshotCommand);
      return;
    }
    throw new Error("Unknown action. Use: plan, apply, status, reconcile, rollback, snapshots");
  }

  for (let i = 1; i < argv.length; i++) {
    switch (argv[i]) {
      case "--profile":
        profile = requireValue("--profile", ++i);
        profileProvided = true;
        break;
      case "--plan":
        planPath = requireValue("--plan", ++i);
        break;
      case "--run-id":
        runId = requireValue("--run-id", ++i);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--endpoint-url":
        endpointUrl = requireValue("--endpoint-url", ++i);
        break;
      case "--external-target":
        externalTargetStatus = true;
        break;
    }
  }

  if (externalTargetStatus && action !== "status") {
    throw new Error("--external-target is accepted only with status");
  }

  switch (action) {
    case "plan": {
      const blueprint = loadBlueprint();
      if (blueprint.openshell_target !== undefined) {
        if (profileProvided) {
          throw new Error(
            "--profile configures managed inference and is not accepted by external target-only planning.",
          );
        }
        if (endpointUrl !== undefined) {
          throw new Error(
            "--endpoint-url configures inference and is not accepted by external target-only planning.",
          );
        }
        actionExternalOpenShellTargetPlan(blueprint, { dryRun });
      } else {
        await actionPlan(profile, blueprint, { dryRun, endpointUrl });
      }
      break;
    }
    case "apply": {
      const blueprint = loadBlueprint();
      await actionApply(profile, blueprint, {
        planPath,
        endpointUrl,
        runtimeIdentityProfilePolicy: options.runtimeIdentityProfilePolicy,
      });
      break;
    }
    case "status":
      if (externalTargetStatus) {
        if (runId !== undefined) {
          throw new Error("--external-target and --run-id cannot be used together");
        }
        if (profileProvided || planPath !== undefined || dryRun || endpointUrl !== undefined) {
          throw new Error("External target status does not accept managed-run options");
        }
        if (options.gatewayHealthObserver === undefined) {
          throw new Error("The external OpenShell gateway observer is unavailable.");
        }
        await actionExternalOpenShellTargetStatus(loadBlueprint(), options.gatewayHealthObserver);
      } else {
        actionStatus(runId);
      }
      break;
    case "reconcile":
      if (!runId) {
        throw new Error("--run-id is required for reconcile");
      }
      await actionReconcile(runId);
      break;
    case "rollback":
      if (!runId) {
        throw new Error("--run-id is required for rollback");
      }
      await actionRollback(runId);
      break;
  }
}
