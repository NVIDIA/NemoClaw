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

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { execa } from "execa";
import YAML from "yaml";

import { DASHBOARD_PORT } from "../lib/ports.js";
import { buildSubprocessEnv } from "../lib/subprocess-env.js";
import { isPlainObject, type UnknownRecord } from "../shared/object-record.js";
import * as importedOpenShellGatewayEndpointBoundary from "../shared/openshell-gateway-endpoint-boundary.cjs";
import * as importedOpenShellExternalTargetBoundary from "../shared/openshell-external-target-boundary.cjs";
import * as importedOpenShellPolicyBoundary from "../shared/openshell-policy-boundary.cjs";
import * as importedSandboxName from "../shared/sandbox-name.cjs";
import type { SanitizedExternalOpenShellTargetPlan } from "../shared/openshell-external-target-boundary.cjs";
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
  assertExternalPolicyRequirementContainment,
  assertNemoClawPolicyCreationReceiptMatches,
  assertPolicyRequirementContainment,
  classifyOpenShellGlobalPolicyHistory,
  parseActiveGlobalPolicyAuthorityMetadata,
  parseNemoClawPolicyCreationReceipt,
  parseOpenShellPolicy,
  parseSandboxPolicyAuthorityMetadata,
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
const { buildSanitizedExternalOpenShellTargetPlan } =
  sourceOrGeneratedOpenShellExternalTargetBoundary.default ??
  sourceOrGeneratedOpenShellExternalTargetBoundary;

// sourceOfTruth: nemoclaw/src/shared/sandbox-name.cts
const sourceOrGeneratedSandboxName = importedSandboxName as typeof importedSandboxName & {
  default?: typeof importedSandboxName;
};
const { assertValidName, assertValidProviderName, isValidName } =
  sourceOrGeneratedSandboxName.default ?? sourceOrGeneratedSandboxName;

type Action = "plan" | "apply" | "status" | "reconcile" | "rollback";

type RollbackPlanSource = {
  sandbox_name?: unknown;
  sandbox_created_by_apply?: unknown;
  inference_provider_created_by_apply?: unknown;
  inference?: unknown;
  identity?: unknown;
  policy_authority?: unknown;
  policy_creation_transition?: unknown;
  policy_transition?: unknown;
};
type ReconciliationPlanSource = RollbackPlanSource & {
  policy_additions?: unknown;
};
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

type BlueprintPolicyAuthorityInspection =
  import("../shared/openshell-policy-boundary.cjs").SandboxPolicyAuthorityInspection;
type NemoClawPolicyCreationReceipt =
  import("../shared/openshell-policy-boundary.cjs").NemoClawPolicyCreationReceipt;

type GatewayBinding = {
  name: string;
  host: string;
  port: number;
};

type BlueprintPolicyAuthorityReceipt =
  | {
      authority: "externally-managed";
      gateway: string;
      gateway_host: string;
      gateway_port: number;
      scope: "global" | "sandbox";
      sandbox_name?: string;
      sandbox_identity_fingerprint?: string;
    }
  | {
      authority: "nemoclaw-managed";
      gateway: string;
      gateway_host: string;
      gateway_port: number;
      scope: "sandbox";
      sandbox_name: string;
      policy_creation_receipt: NemoClawPolicyCreationReceipt;
    };

type BlueprintPolicyCreationTransition = {
  status: "pending" | "incomplete";
  gateway: string;
  gateway_host: string;
  gateway_port: number;
  sandbox_name: string;
  lifecycle_generation: string;
  sandbox_identity_fingerprint?: string;
};

type BlueprintPolicyTransitionReceipt = {
  status: "pending" | "incomplete" | "complete";
  sandbox_name: string;
  gateway: string;
  gateway_host: string;
  gateway_port: number;
  expected_authority: "nemoclaw-managed";
  policy_addition_names: string[];
  target_policy_digest: string;
};

type StatusPolicyTransition = BlueprintPolicyTransitionReceipt & {
  reconciliation_required: boolean;
  reconciliation_action?: string;
};

type StatusPolicyCreationTransition = BlueprintPolicyCreationTransition & {
  recovery_required: true;
  recovery_action: string;
};

function policyTransitionReconciliationAction(runId: string): string {
  return `Do not retry \`apply\` or \`rollback\`. Through the NemoClaw blueprint runner integration that created this run, invoke its \`reconcile\` action with run ID ${runId}. There is no standalone \`reconcile\` host command.`;
}

function policyCreationRecoveryAction(
  runId: string,
  transition: BlueprintPolicyCreationTransition,
): string {
  const identity = transition.sandbox_identity_fingerprint
    ? `The recorded immutable sandbox identity fingerprint is ${transition.sandbox_identity_fingerprint}.`
    : "No immutable sandbox identity fingerprint was recorded; trusted gateway evidence must establish it before recovery can be reconsidered.";
  return `Automated retry, rollback, detach, and cleanup are disabled for run ${runId}. OpenShell does not expose an atomic identity-bound delete or detach operation, so no safe automatic or manual cleanup action is currently supported. Recovery is blocked. Preserve the run receipt and retained resources. Through the NemoClaw blueprint runner integration, inspect status for run ${runId}. Give an OpenShell administrator that run receipt together with sandbox ${JSON.stringify(transition.sandbox_name)}, gateway ${JSON.stringify(transition.gateway)} (${transition.gateway_host}:${String(transition.gateway_port)}), and lifecycle generation ${transition.lifecycle_generation}. ${identity} The administrator must compare the receipt with trusted gateway evidence and leave the resources unchanged. Do not mutate any sandbox or provider by name. Cleanup may resume only through an OpenShell operation that atomically conditions the mutation on the exact immutable identity.`;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const REST_PROTOCOLS = new Set(["rest"]);
const ENDPOINT_ENFORCEMENT_MODES = new Set(["enforce", "audit"]);
const ENDPOINT_TLS_MODES = new Set(["terminate", "passthrough", "skip"]);
const MISSING_PROVIDER_INSPECTION_PATTERN =
  /(?:\bprovider\b[^\r\n]*\b(?:not found|does not exist)\b|\b(?:not found|does not exist)\b[^\r\n]*\bprovider\b|\bunknown provider\b)/i;
const POLICY_AUTHORITY_MAX_BYTES = 1024 * 1024;
const POLICY_AUTHORITY_TIMEOUT_MS = 30_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MANAGED_POLICY_AUTHORITY_KEYS = [
  "authority",
  "gateway",
  "gateway_host",
  "gateway_port",
  "scope",
  "sandbox_name",
  "policy_creation_receipt",
] as const;
const EXTERNAL_GLOBAL_POLICY_AUTHORITY_KEYS = [
  "authority",
  "gateway",
  "gateway_host",
  "gateway_port",
  "scope",
] as const;
const EXTERNAL_SANDBOX_POLICY_AUTHORITY_KEYS = [
  ...EXTERNAL_GLOBAL_POLICY_AUTHORITY_KEYS,
  "sandbox_name",
  "sandbox_identity_fingerprint",
] as const;
const POLICY_CREATION_TRANSITION_KEYS = [
  "status",
  "gateway",
  "gateway_host",
  "gateway_port",
  "sandbox_name",
  "lifecycle_generation",
  "sandbox_identity_fingerprint",
] as const;
const POLICY_TRANSITION_KEYS = [
  "status",
  "sandbox_name",
  "gateway",
  "gateway_host",
  "gateway_port",
  "expected_authority",
  "policy_addition_names",
  "target_policy_digest",
] as const;

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
  let redacted = stderr;
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
  if (!isPlainObject(value)) {
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

export function loadBlueprint(): Blueprint {
  const blueprintPath = process.env.NEMOCLAW_BLUEPRINT_PATH ?? ".";
  const bpFile = join(blueprintPath, "blueprint.yaml");
  let content: string;
  try {
    content = readFileSync(bpFile, "utf-8");
  } catch {
    throw new Error(`blueprint.yaml not found at ${bpFile}`);
  }
  const parsed: unknown = YAML.parse(content);
  if (!isBlueprint(parsed)) {
    throw new Error(
      `blueprint.yaml at ${bpFile} must contain a YAML mapping with valid nested component shapes`,
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
      readonly kind: "policy-authority";
      readonly subject: "global" | "sandbox";
    }
  | {
      readonly kind: "receipt";
      readonly subject: "gateway" | "policy" | "sandbox";
    };

function blueprintInspectionFailureMessage(failure: BlueprintInspectionFailure): string {
  return failure.kind === "policy-authority"
    ? `OpenShell ${failure.subject} policy authority inspection failed. Policy-dependent operations must stop.`
    : `OpenShell ${failure.subject} receipt inspection failed.`;
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
      maxBuffer: POLICY_AUTHORITY_MAX_BYTES,
      reject: false,
      timeout: POLICY_AUTHORITY_TIMEOUT_MS,
    });
  } catch {
    throw new Error(failureMessage);
  }
  if (
    result.exitCode !== 0 ||
    Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") >
      POLICY_AUTHORITY_MAX_BYTES
  ) {
    throw new Error(failureMessage);
  }
  return result;
}

async function inspectBlueprintPolicyAuthority(
  gateway: string,
): Promise<BlueprintPolicyAuthorityInspection | null>;
async function inspectBlueprintPolicyAuthority(
  gateway: string,
  sandboxName: string,
): Promise<BlueprintPolicyAuthorityInspection>;
async function inspectBlueprintPolicyAuthority(
  gateway: string,
  sandboxName?: string,
): Promise<BlueprintPolicyAuthorityInspection | null> {
  const subject = sandboxName === undefined ? "global" : "sandbox";
  if (sandboxName === undefined) {
    const history = await runBlueprintInspectionCommand(
      ["openshell", "policy", "list", "-g", gateway, "--global", "--limit", "1"],
      gateway,
      { kind: "policy-authority", subject },
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
  }
  const command =
    sandboxName === undefined
      ? ["openshell", "policy", "get", "-g", gateway, "--global", "--full", "--output", "json"]
      : ["openshell", "policy", "get", "-g", gateway, "--full", "--output", "json", sandboxName];
  const result = await runBlueprintInspectionCommand(command, gateway, {
    kind: "policy-authority",
    subject,
  });
  if (sandboxName === undefined) {
    try {
      const activeGlobalPolicy = parseActiveGlobalPolicyAuthorityMetadata(result.stdout);
      return activeGlobalPolicy.state === "active" ? activeGlobalPolicy.inspection : null;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "OpenShell returned invalid metadata";
      throw new Error(`${detail}. Policy-dependent operations must stop.`);
    }
  }
  try {
    return parseSandboxPolicyAuthorityMetadata(result.stdout, sandboxName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "OpenShell returned invalid metadata";
    throw new Error(`${detail}. Policy-dependent operations must stop.`);
  }
}

function assertBlueprintExternalPolicyRequirements(
  inspection: BlueprintPolicyAuthorityInspection,
  additions: PolicyAdditions,
): void {
  try {
    assertExternalPolicyRequirementContainment(inspection, {
      network_policies: additions,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "the policy requirement is invalid";
    throw new Error(
      `Refusing to apply the blueprint: ${detail}. Ask the external policy authority to supply the exact required entries.`,
    );
  }
}

function assertBlueprintPolicyRequirements(
  inspection: BlueprintPolicyAuthorityInspection,
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

function readConfiguredSandboxPolicy(): {
  path: string;
  policy: UnknownRecord;
} | null {
  const path = process.env.OPENSHELL_SANDBOX_POLICY?.trim();
  if (!path) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    throw new Error("The configured NemoClaw sandbox policy could not be read");
  }
  try {
    return { path, policy: parseOpenShellPolicy(raw).policy };
  } catch {
    throw new Error("The configured NemoClaw sandbox policy is invalid");
  }
}

function stablePolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePolicyValue);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stablePolicyValue(value[key])]),
  );
}

function policyDigest(policy: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stablePolicyValue(policy)))
    .digest("hex");
}

function policyForOwnershipProof(policy: UnknownRecord): UnknownRecord {
  const networkPolicies = isPlainObject(policy.network_policies)
    ? withoutProviderComposedPolicies(policy.network_policies)
    : policy.network_policies;
  return { ...policy, network_policies: networkPolicies };
}

async function inspectGatewayEndpoint(name: string): Promise<{ host: string; port: number }> {
  const info = await runBlueprintInspectionCommand(
    ["openshell", "gateway", "info", "-g", name],
    name,
    { kind: "receipt", subject: "gateway" },
  );
  return parseSingleManagedGatewayEndpoint(`${info.stderr}\n${info.stdout}`);
}

async function inspectSandboxIdentityFingerprint(
  gateway: string,
  sandboxName: string,
  requireReady = true,
): Promise<string> {
  const result = await runBlueprintInspectionCommand(
    ["openshell", "sandbox", "get", "-g", gateway, sandboxName],
    gateway,
    { kind: "receipt", subject: "sandbox" },
  );
  const output = `${result.stderr}\n${result.stdout}`;
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const names = lines
    .map((line) => /^\s*Name:\s*(.+?)\s*$/i.exec(line)?.[1])
    .filter((value): value is string => Boolean(value));
  const ids = lines
    .map((line) => /^\s*Id:\s*(.+?)\s*$/i.exec(line)?.[1])
    .filter((value): value is string => Boolean(value));
  const phases = lines
    .map((line) => /^\s*Phase:\s*(.+?)\s*$/i.exec(line)?.[1])
    .filter((value): value is string => Boolean(value));
  if (
    names.length !== 1 ||
    names[0] !== sandboxName ||
    ids.length !== 1 ||
    phases.length !== 1 ||
    (requireReady && phases[0] !== "Ready")
  ) {
    throw new Error(
      `OpenShell did not prove the immutable identity of${requireReady ? " Ready" : ""} sandbox ${JSON.stringify(sandboxName)}`,
    );
  }
  return createHash("sha256").update(ids[0]).digest("hex");
}

function managedInspection(
  inspection: BlueprintPolicyAuthorityInspection,
): BlueprintPolicyAuthorityInspection {
  return { ...inspection, authority: "nemoclaw-managed" };
}

async function validateManagedPolicyReceipt(
  value: unknown,
  expectedGatewayEndpoint: { host: string; port: number },
  requireReady = true,
): Promise<{
  receipt: NemoClawPolicyCreationReceipt;
  inspection: BlueprintPolicyAuthorityInspection;
}> {
  const receipt = parseNemoClawPolicyCreationReceipt(value);
  const gatewayEndpoint = await inspectGatewayEndpoint(receipt.gatewayName);
  if (
    gatewayEndpoint.host !== expectedGatewayEndpoint.host ||
    gatewayEndpoint.port !== expectedGatewayEndpoint.port
  ) {
    throw new Error("The OpenShell gateway endpoint no longer matches the durable policy receipt");
  }
  const sandboxIdentityFingerprint = await inspectSandboxIdentityFingerprint(
    receipt.gatewayName,
    receipt.sandboxName,
    requireReady,
  );
  const inspection = await inspectBlueprintPolicyAuthority(
    receipt.gatewayName,
    receipt.sandboxName,
  );
  if (inspection.authority !== "owner-unknown") {
    throw new Error("The live sandbox policy is no longer sandbox-scoped");
  }
  assertNemoClawPolicyCreationReceiptMatches(receipt, {
    origin: "sandbox-create",
    gatewayName: receipt.gatewayName,
    gatewayPort: gatewayEndpoint.port,
    sandboxName: receipt.sandboxName,
    lifecycleGeneration: receipt.lifecycleGeneration,
    sandboxIdentityFingerprint,
    policyHash: inspection.policyIdentity.hash,
    policyVersion: inspection.policyIdentity.activeVersion,
  });
  return { receipt, inspection: managedInspection(inspection) };
}

async function inspectReceiptSandboxBinding(
  value: unknown,
  expectedGatewayEndpoint: { host: string; port: number },
): Promise<{
  receipt: NemoClawPolicyCreationReceipt;
  inspection: BlueprintPolicyAuthorityInspection;
}> {
  const receipt = parseNemoClawPolicyCreationReceipt(value);
  const gatewayEndpoint = await inspectGatewayEndpoint(receipt.gatewayName);
  if (
    gatewayEndpoint.host !== expectedGatewayEndpoint.host ||
    gatewayEndpoint.port !== expectedGatewayEndpoint.port
  ) {
    throw new Error("The OpenShell gateway endpoint no longer matches the durable policy receipt");
  }
  const sandboxIdentityFingerprint = await inspectSandboxIdentityFingerprint(
    receipt.gatewayName,
    receipt.sandboxName,
  );
  assertNemoClawPolicyCreationReceiptMatches(receipt, {
    origin: "sandbox-create",
    gatewayName: receipt.gatewayName,
    gatewayPort: gatewayEndpoint.port,
    sandboxName: receipt.sandboxName,
    lifecycleGeneration: receipt.lifecycleGeneration,
    sandboxIdentityFingerprint,
    policyHash: receipt.policyHash,
    policyVersion: receipt.policyVersion,
  });
  const inspection = await inspectBlueprintPolicyAuthority(
    receipt.gatewayName,
    receipt.sandboxName,
  );
  if (inspection.authority !== "owner-unknown") {
    throw new Error("The live sandbox policy is no longer sandbox-scoped");
  }
  return {
    receipt,
    inspection,
  };
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

function isRuntimeIdentityMutationCommand(args: readonly string[]): boolean {
  const command = args.slice(1).join(" ");
  return (
    command.startsWith("provider profile import ") ||
    command.startsWith("provider create ") ||
    command.startsWith("provider delete ") ||
    command.startsWith("provider refresh configure ") ||
    command.startsWith("provider refresh rotate ") ||
    command.startsWith("sandbox provider attach ") ||
    command.startsWith("sandbox provider detach ")
  );
}

function runtimeIdentityCommandDeps(
  gateway: string,
  validateBeforeMutation?: () => Promise<unknown>,
): RuntimeIdentityCommandDeps {
  return {
    run: async (args, options) => {
      if (validateBeforeMutation && isRuntimeIdentityMutationCommand(args)) {
        await validateBeforeMutation();
      }
      return runRuntimeIdentityCommand(args, options, gateway);
    },
    formatError: boundedCommandError,
  };
}

function runtimeIdentityDeps(
  persistReceipt: (receipt: RuntimeIdentityReceipt) => void,
  gateway: string,
  profilePolicy?: RuntimeIdentityProfilePolicy,
  validateBeforeMutation?: () => Promise<unknown>,
): RuntimeIdentityDeps {
  return {
    ...runtimeIdentityCommandDeps(gateway, validateBeforeMutation),
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
}> {
  const inferenceProfiles = blueprint.components?.inference?.profiles ?? {};
  if (!(profile in inferenceProfiles)) {
    const available = Object.keys(inferenceProfiles).join(", ");
    throw new Error(`Profile '${profile}' not found. Available: ${available}`);
  }

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

  return { inferenceProfiles, inferenceCfg, sandboxCfg, routerCfg };
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
  policy_additions: PolicyAdditions;
  policy_authority?: BlueprintPolicyAuthorityReceipt;
  policy_creation_transition?: BlueprintPolicyCreationTransition;
  policy_transition?: BlueprintPolicyTransitionReceipt;
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
  policy_additions?: PolicyAdditions;
  policy_authority?: BlueprintPolicyAuthorityReceipt;
  policy_creation_transition?: StatusPolicyCreationTransition;
  policy_transition?: StatusPolicyTransition;
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

function isBlueprintPolicyAuthorityReceipt(
  value: unknown,
): value is BlueprintPolicyAuthorityReceipt {
  if (!isPlainObject(value)) return false;
  if (
    (value.authority !== "nemoclaw-managed" && value.authority !== "externally-managed") ||
    (value.scope !== "global" && value.scope !== "sandbox") ||
    !isValidName(value.gateway) ||
    !isManagedGatewayEndpointHost(value.gateway_host) ||
    !isValidPort(value.gateway_port)
  ) {
    return false;
  }
  if (value.authority === "nemoclaw-managed") {
    if (
      value.scope !== "sandbox" ||
      !isValidName(value.sandbox_name) ||
      !hasOnlyKeys(value, MANAGED_POLICY_AUTHORITY_KEYS)
    ) {
      return false;
    }
    try {
      const receipt = parseNemoClawPolicyCreationReceipt(value.policy_creation_receipt);
      return (
        receipt.gatewayName === value.gateway &&
        receipt.gatewayPort === value.gateway_port &&
        receipt.sandboxName === value.sandbox_name
      );
    } catch {
      return false;
    }
  }
  return value.scope === "global"
    ? hasOnlyKeys(value, EXTERNAL_GLOBAL_POLICY_AUTHORITY_KEYS)
    : hasOnlyKeys(value, EXTERNAL_SANDBOX_POLICY_AUTHORITY_KEYS) &&
        isValidName(value.sandbox_name) &&
        typeof value.sandbox_identity_fingerprint === "string" &&
        /^[a-f0-9]{64}$/u.test(value.sandbox_identity_fingerprint);
}

function isBlueprintPolicyCreationTransition(
  value: unknown,
): value is BlueprintPolicyCreationTransition {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, POLICY_CREATION_TRANSITION_KEYS) &&
    (value.status === "pending" || value.status === "incomplete") &&
    isValidName(value.gateway) &&
    isManagedGatewayEndpointHost(value.gateway_host) &&
    isValidPort(value.gateway_port) &&
    isValidName(value.sandbox_name) &&
    typeof value.lifecycle_generation === "string" &&
    UUID_PATTERN.test(value.lifecycle_generation) &&
    (value.sandbox_identity_fingerprint === undefined ||
      (typeof value.sandbox_identity_fingerprint === "string" &&
        /^[a-f0-9]{64}$/u.test(value.sandbox_identity_fingerprint)))
  );
}

function isBlueprintPolicyTransitionReceipt(
  value: unknown,
): value is BlueprintPolicyTransitionReceipt {
  if (!isPlainObject(value)) return false;
  if (
    !hasOnlyKeys(value, POLICY_TRANSITION_KEYS) ||
    (value.status !== "pending" && value.status !== "incomplete" && value.status !== "complete") ||
    !isValidName(value.sandbox_name) ||
    !isValidName(value.gateway) ||
    !isManagedGatewayEndpointHost(value.gateway_host) ||
    !isValidPort(value.gateway_port) ||
    value.expected_authority !== "nemoclaw-managed" ||
    typeof value.target_policy_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.target_policy_digest) ||
    !Array.isArray(value.policy_addition_names) ||
    value.policy_addition_names.length === 0 ||
    !value.policy_addition_names.every(
      (name): name is string => typeof name === "string" && name.length > 0,
    )
  ) {
    return false;
  }
  return new Set(value.policy_addition_names).size === value.policy_addition_names.length;
}

async function validateBlueprintPolicyAuthorityReceipt(
  value: unknown,
  sandboxName: string,
  requireReady = true,
): Promise<BlueprintPolicyAuthorityInspection> {
  if (
    !isBlueprintPolicyAuthorityReceipt(value) ||
    value.scope !== "sandbox" ||
    value.sandbox_name !== sandboxName
  ) {
    throw new Error("A complete sandbox policy boundary receipt is required");
  }
  if (value.authority === "nemoclaw-managed") {
    return (
      await validateManagedPolicyReceipt(
        value.policy_creation_receipt,
        { host: value.gateway_host, port: value.gateway_port },
        requireReady,
      )
    ).inspection;
  }
  const liveEndpoint = await inspectGatewayEndpoint(value.gateway);
  const liveFingerprint = await inspectSandboxIdentityFingerprint(
    value.gateway,
    sandboxName,
    requireReady,
  );
  const livePolicy = await inspectBlueprintPolicyAuthority(value.gateway, sandboxName);
  if (
    liveEndpoint.host !== value.gateway_host ||
    liveEndpoint.port !== value.gateway_port ||
    liveFingerprint !== value.sandbox_identity_fingerprint ||
    livePolicy.authority !== "externally-managed"
  ) {
    throw new Error("The verified external policy boundary no longer matches the live sandbox");
  }
  return livePolicy;
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
  policyAdditions: PolicyAdditions;
  policyAuthorityReceipt?: BlueprintPolicyAuthorityReceipt;
  policyCreationTransition?: BlueprintPolicyCreationTransition;
  policyTransition?: BlueprintPolicyTransitionReceipt;
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
    policy_additions: args.policyAdditions,
    inference: buildSafeInferencePlan(args.inferenceCfg),
    timestamp: args.timestamp,
  };
  if (args.policyAuthorityReceipt) {
    plan.policy_authority = args.policyAuthorityReceipt;
  }
  if (args.policyCreationTransition) {
    plan.policy_creation_transition = args.policyCreationTransition;
  }
  if (args.runtimeIdentityReceipt) {
    plan.identity = args.runtimeIdentityReceipt;
  }
  if (args.policyTransition) {
    plan.policy_transition = args.policyTransition;
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

  if (isPolicyAdditions(source.policy_additions)) {
    safePlan.policy_additions = source.policy_additions;
  }
  if (
    source.policy_authority !== undefined &&
    !isBlueprintPolicyAuthorityReceipt(source.policy_authority)
  ) {
    return null;
  }
  if (isBlueprintPolicyAuthorityReceipt(source.policy_authority)) {
    safePlan.policy_authority = source.policy_authority;
  }
  if (
    source.policy_creation_transition !== undefined &&
    !isBlueprintPolicyCreationTransition(source.policy_creation_transition)
  ) {
    return null;
  }
  if (isBlueprintPolicyCreationTransition(source.policy_creation_transition)) {
    safePlan.policy_creation_transition = {
      ...source.policy_creation_transition,
      recovery_required: true,
      recovery_action: policyCreationRecoveryAction(
        safePlan.run_id,
        source.policy_creation_transition,
      ),
    };
  }
  if (
    source.policy_transition !== undefined &&
    !isBlueprintPolicyTransitionReceipt(source.policy_transition)
  ) {
    return null;
  }
  if (isBlueprintPolicyTransitionReceipt(source.policy_transition)) {
    const reconciliationRequired = source.policy_transition.status !== "complete";
    safePlan.policy_transition = {
      ...source.policy_transition,
      reconciliation_required: reconciliationRequired,
      ...(reconciliationRequired
        ? { reconciliation_action: policyTransitionReconciliationAction(safePlan.run_id) }
        : {}),
    };
  }

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

  const { inferenceCfg, sandboxCfg, routerCfg } = await resolveRunConfig(
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
    policyAdditions: blueprint.components?.policy?.additions ?? {},
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
  if (blueprint.openshell_target === undefined) {
    throw new Error("blueprint does not declare an external OpenShell target");
  }
  if (
    blueprint.min_openshell_version === undefined ||
    blueprint.max_openshell_version === undefined
  ) {
    throw new Error(
      "External OpenShell target planning requires blueprint min_openshell_version and max_openshell_version.",
    );
  }
  for (const field of ["components", "profiles", "min_openclaw_version"] as const) {
    if (blueprint[field] !== undefined) {
      throw new Error(`External OpenShell target planning does not accept '${field}'.`);
    }
  }

  const rid = emitRunId();
  progress(10, "Validating external OpenShell target");
  const targetPlan = buildSanitizedExternalOpenShellTargetPlan(blueprint.openshell_target, {
    minVersion: blueprint.min_openshell_version,
    maxVersion: blueprint.max_openshell_version,
  });
  const plan: ExternalOpenShellTargetRunPlan = {
    run_id: rid,
    openshell_target: targetPlan,
    dry_run: options?.dryRun ?? false,
  };
  progress(100, "External target plan complete");
  log(JSON.stringify(plan, null, 2));
  return plan;
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

  const { inferenceCfg, sandboxCfg } = await resolveRunConfig(
    profile,
    blueprint,
    options?.endpointUrl,
  );

  const sandboxName = sandboxCfg.name ?? "openclaw";
  const sandboxImage = sandboxCfg.image ?? "openclaw";
  const forwardPorts = sandboxCfg.forward_ports ?? [DASHBOARD_PORT];
  const policyAdditions = withoutProviderComposedPolicies(
    blueprint.components?.policy?.additions ?? {},
  );
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
  const initialPolicyAuthority = await inspectBlueprintPolicyAuthority(policyGateway.name);
  if (initialPolicyAuthority) {
    assertBlueprintExternalPolicyRequirements(initialPolicyAuthority, policyAdditions);
  }
  const configuredSandboxPolicy = initialPolicyAuthority ? null : readConfiguredSandboxPolicy();
  if (!initialPolicyAuthority && !configuredSandboxPolicy) {
    throw new Error(
      "A configured NemoClaw sandbox policy is required before the blueprint can create or mutate resources.",
    );
  }
  const stateDir = join(homedir(), ".nemoclaw", "state", "runs", rid);
  mkdirSync(stateDir, { recursive: true });

  let runtimeIdentityReceipt: RuntimeIdentityReceipt | undefined;
  let policyAuthorityReceipt: BlueprintPolicyAuthorityReceipt | undefined = initialPolicyAuthority
    ? {
        authority: "externally-managed",
        gateway: policyGateway.name,
        gateway_host: policyGateway.host,
        gateway_port: policyGateway.port,
        scope: "global",
      }
    : undefined;
  let policyCreationTransition: BlueprintPolicyCreationTransition | undefined;
  let sandboxPolicyAuthority: BlueprintPolicyAuthorityInspection | null = null;
  let policyTransition: BlueprintPolicyTransitionReceipt | undefined;
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
        policyAdditions,
        policyAuthorityReceipt,
        policyCreationTransition,
        policyTransition,
        inferenceCfg,
        runtimeIdentityReceipt,
        timestamp: new Date().toISOString(),
      }),
    );
  };
  const requireUsablePolicyBoundary = async (): Promise<BlueprintPolicyAuthorityInspection> => {
    const inspection = await validateBlueprintPolicyAuthorityReceipt(
      policyAuthorityReceipt,
      sandboxName,
    );
    assertBlueprintExternalPolicyRequirements(inspection, policyAdditions);
    sandboxPolicyAuthority = inspection;
    return inspection;
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
    const liveGlobalPolicy = await inspectBlueprintPolicyAuthority(policyGateway.name);
    if (initialPolicyAuthority === null) {
      if (liveGlobalPolicy !== null) {
        throw new Error("The OpenShell global policy boundary changed before sandbox creation.");
      }
      return;
    }
    if (
      liveGlobalPolicy === null ||
      liveGlobalPolicy.authority !== "externally-managed" ||
      liveGlobalPolicy.policyIdentity.hash !== initialPolicyAuthority.policyIdentity.hash ||
      liveGlobalPolicy.policyIdentity.activeVersion !==
        initialPolicyAuthority.policyIdentity.activeVersion ||
      !isDeepStrictEqual(liveGlobalPolicy.effectivePolicy, initialPolicyAuthority.effectivePolicy)
    ) {
      throw new Error("The OpenShell global policy boundary changed before sandbox creation.");
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
    requireUsablePolicyBoundary,
  );

  try {
    let reuseExistingInferenceProvider = false;
    let reuseExistingInferenceRoute = false;
    let policyCreationReceipt: NemoClawPolicyCreationReceipt | undefined;
    progress(20, "Creating OpenClaw sandbox");
    const lifecycleGeneration = randomUUID();
    if (configuredSandboxPolicy) {
      policyCreationTransition = {
        status: "pending",
        gateway: policyGateway.name,
        gateway_host: policyGateway.host,
        gateway_port: policyGateway.port,
        sandbox_name: sandboxName,
        lifecycle_generation: lifecycleGeneration,
      };
      persistRunPlan();
    }
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
        if (configuredSandboxPolicy) {
          policyCreationTransition = { ...policyCreationTransition!, status: "incomplete" };
          persistRunPlan();
          throw new Error(
            `Sandbox ${JSON.stringify(sandboxName)} already exists, so this create transaction cannot establish NemoClaw policy ownership.`,
          );
        }
        log(`Sandbox '${sandboxName}' already exists, reusing under verified global policy.`);
      } else {
        if (configuredSandboxPolicy) {
          policyCreationTransition = { ...policyCreationTransition!, status: "incomplete" };
          persistRunPlan();
        }
        throw new Error(`Failed to create sandbox: ${boundedCommandError(createResult.stderr)}`);
      }
    } else {
      sandboxCreatedByApply = true;
      if (configuredSandboxPolicy) {
        policyCreationTransition = { ...policyCreationTransition!, status: "incomplete" };
      }
      persistRunPlan();
    }

    const sandboxIdentityFingerprint = await inspectSandboxIdentityFingerprint(
      policyGateway.name,
      sandboxName,
    );
    if (configuredSandboxPolicy) {
      policyCreationTransition = {
        ...policyCreationTransition!,
        sandbox_identity_fingerprint: sandboxIdentityFingerprint,
      };
      persistRunPlan();
    }
    const observedPolicyAuthority = await inspectBlueprintPolicyAuthority(
      policyGateway.name,
      sandboxName,
    );
    if (configuredSandboxPolicy) {
      if (
        observedPolicyAuthority.authority !== "owner-unknown" ||
        !isDeepStrictEqual(
          policyForOwnershipProof(configuredSandboxPolicy.policy),
          policyForOwnershipProof(observedPolicyAuthority.effectivePolicy),
        )
      ) {
        throw new Error(
          "The created sandbox did not prove the exact policy supplied by this NemoClaw create transaction.",
        );
      }
      policyCreationReceipt = {
        schemaVersion: 1,
        origin: "sandbox-create",
        gatewayName: policyGateway.name,
        gatewayPort: policyGateway.port,
        sandboxName,
        lifecycleGeneration,
        sandboxIdentityFingerprint,
        policyHash: observedPolicyAuthority.policyIdentity.hash,
        policyVersion: observedPolicyAuthority.policyIdentity.activeVersion,
      };
      parseNemoClawPolicyCreationReceipt(policyCreationReceipt);
      sandboxPolicyAuthority = managedInspection(observedPolicyAuthority);
      policyAuthorityReceipt = {
        authority: "nemoclaw-managed",
        gateway: policyGateway.name,
        gateway_host: policyGateway.host,
        gateway_port: policyGateway.port,
        scope: "sandbox",
        sandbox_name: sandboxName,
        policy_creation_receipt: policyCreationReceipt,
      };
    } else {
      if (observedPolicyAuthority.authority !== "externally-managed") {
        throw new Error("The created sandbox did not retain the verified global policy boundary.");
      }
      assertBlueprintExternalPolicyRequirements(observedPolicyAuthority, policyAdditions);
      sandboxPolicyAuthority = observedPolicyAuthority;
      policyAuthorityReceipt = {
        authority: "externally-managed",
        gateway: policyGateway.name,
        gateway_host: policyGateway.host,
        gateway_port: policyGateway.port,
        scope: "sandbox",
        sandbox_name: sandboxName,
        sandbox_identity_fingerprint: sandboxIdentityFingerprint,
      };
    }
    policyCreationTransition = undefined;
    try {
      persistRunPlan();
    } catch (error) {
      policyAuthorityReceipt = undefined;
      sandboxPolicyAuthority = null;
      policyCreationTransition = {
        status: "incomplete",
        gateway: policyGateway.name,
        gateway_host: policyGateway.host,
        gateway_port: policyGateway.port,
        sandbox_name: sandboxName,
        lifecycle_generation: lifecycleGeneration,
      };
      persistRunPlan();
      throw error;
    }
    await requireUsablePolicyBoundary();

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
      progress(30, "Configuring runtime identity");
      await requireUsablePolicyBoundary();
      runtimeIdentityReceipt = await prepareRuntimeIdentity(runtimeIdentityConfig, identityDeps);
      persistRunPlan();
    }

    // Keep runtime credentials unattached until OpenShell accepts the
    // sandbox's requested inference route.
    progress(50, "Configuring inference provider");
    await requireUsablePolicyBoundary();
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

      await requireUsablePolicyBoundary();
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
        // Persist ownership before a later route or policy mutation can fail.
        try {
          persistRunPlan();
        } catch (error) {
          inferenceProviderCreatedByApply = false;
          throw error;
        }
      }
    }

    progress(70, "Setting inference route");
    await requireUsablePolicyBoundary();
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
      await requireUsablePolicyBoundary();
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
      await requireUsablePolicyBoundary();
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

    if (Object.keys(policyAdditions).length > 0) {
      if (!sandboxPolicyAuthority) {
        throw new Error("Sandbox policy authority is unavailable before applying additions.");
      }
      const observedPolicyAuthority = await requireUsablePolicyBoundary();
      assertBlueprintExternalPolicyRequirements(observedPolicyAuthority, policyAdditions);
      if (observedPolicyAuthority.authority === "nemoclaw-managed") {
        progress(78, "Applying policy additions");
        const currentPolicy = await runBlueprintInspectionCommand(
          ["openshell", "policy", "get", "-g", policyGateway.name, "--base", sandboxName],
          policyGateway.name,
          { kind: "receipt", subject: "policy" },
        );

        const mergedPolicyFile = join(stateDir, "merged-policy.yaml");
        writeFileSync(
          mergedPolicyFile,
          mergePolicyAdditions(currentPolicy.stdout, policyAdditions),
          {
            encoding: "utf-8",
            mode: 0o600,
          },
        );

        const mergedPolicy = parseOpenShellPolicy(readFileSync(mergedPolicyFile, "utf-8")).policy;
        await requireUsablePolicyBoundary();
        policyTransition = {
          status: "pending",
          sandbox_name: sandboxName,
          gateway: policyGateway.name,
          gateway_host: policyGateway.host,
          gateway_port: policyGateway.port,
          expected_authority: "nemoclaw-managed",
          policy_addition_names: Object.keys(policyAdditions).sort(),
          target_policy_digest: policyDigest(mergedPolicy),
        };
        persistRunPlan();
        await requireUsablePolicyBoundary();
        const policySet = await runCmd(
          [
            "openshell",
            "policy",
            "set",
            "-g",
            policyGateway.name,
            "--policy",
            mergedPolicyFile,
            "--wait",
            sandboxName,
          ],
          { gateway: policyGateway.name, reject: false },
        );
        if (policySet.exitCode !== 0) {
          throw new Error(
            `Failed to apply policy additions: ${boundedCommandError(policySet.stderr)}`,
          );
        }
        policyTransition = { ...policyTransition, status: "incomplete" };
        persistRunPlan();
        const afterMutationIdentity = await inspectSandboxIdentityFingerprint(
          policyGateway.name,
          sandboxName,
        );
        const afterMutation = await inspectBlueprintPolicyAuthority(
          policyGateway.name,
          sandboxName,
        );
        const afterMutationGateway = await inspectGatewayEndpoint(policyGateway.name);
        if (!policyCreationReceipt) {
          throw new Error("The NemoClaw policy creation receipt is unavailable after mutation");
        }
        if (
          afterMutationGateway.host !== policyGateway.host ||
          afterMutationGateway.port !== policyGateway.port ||
          afterMutationIdentity !== policyCreationReceipt.sandboxIdentityFingerprint ||
          afterMutation.authority !== "owner-unknown" ||
          !isDeepStrictEqual(
            policyForOwnershipProof(afterMutation.effectivePolicy),
            policyForOwnershipProof(mergedPolicy),
          )
        ) {
          throw new Error(
            "OpenShell did not prove the exact sandbox and effective policy after the NemoClaw policy mutation.",
          );
        }
        const rotatedReceipt: NemoClawPolicyCreationReceipt = {
          ...policyCreationReceipt,
          policyHash: afterMutation.policyIdentity.hash,
          policyVersion: afterMutation.policyIdentity.activeVersion,
        };
        policyAuthorityReceipt = {
          authority: "nemoclaw-managed",
          gateway: policyGateway.name,
          gateway_host: policyGateway.host,
          gateway_port: policyGateway.port,
          scope: "sandbox",
          sandbox_name: sandboxName,
          policy_creation_receipt: rotatedReceipt,
        };
        sandboxPolicyAuthority = managedInspection(afterMutation);
        policyTransition = { ...policyTransition, status: "complete" };
        try {
          persistRunPlan();
        } catch (error) {
          policyTransition = { ...policyTransition, status: "incomplete" };
          persistRunPlan();
          throw error;
        }
      }
    }

    progress(85, "Saving run state");
    if (!sandboxPolicyAuthority) {
      throw new Error("Sandbox policy authority is unavailable before saving run state.");
    }
    const finalPolicyAuthority = await requireUsablePolicyBoundary();
    assertBlueprintExternalPolicyRequirements(finalPolicyAuthority, policyAdditions);
    if (policyTransition) {
      policyTransition = { ...policyTransition, status: "complete" };
    }
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
            "Do not reconstruct plan.json. Reconcile and rollback remain disabled. Recover the original receipt from a trusted copy produced by this exact run, then ask a NemoClaw maintainer to validate its run ID, sandbox ownership, provider ownership, and policy transition before using it. If no trusted copy exists, stop and ask a NemoClaw maintainer for recovery direction.",
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

  const planFile = join(stateDir, "plan.json");
  let plan: ReconciliationPlanSource;
  let transition: BlueprintPolicyTransitionReceipt;
  let additions: PolicyAdditions;
  let authorityReceipt: BlueprintPolicyAuthorityReceipt;
  let targetPolicy: UnknownRecord;
  try {
    const parsedPlan: unknown = JSON.parse(readFileSync(planFile, "utf-8"));
    if (!isPlainObject(parsedPlan)) {
      throw new Error("plan.json must contain a JSON object");
    }
    plan = parsedPlan;
    const sandboxName = readRollbackSandboxName(plan);
    if (!isBlueprintPolicyAuthorityReceipt(plan.policy_authority)) {
      throw new Error("policy authority receipt is invalid");
    }
    authorityReceipt = plan.policy_authority;
    if (authorityReceipt.authority !== "nemoclaw-managed") {
      throw new Error("policy reconciliation requires a NemoClaw policy creation receipt");
    }
    if (!isBlueprintPolicyTransitionReceipt(plan.policy_transition)) {
      throw new Error("policy transition receipt is invalid");
    }
    transition = plan.policy_transition;
    if (transition.sandbox_name !== sandboxName) {
      throw new Error("policy transition sandbox does not match the run plan");
    }
    if (
      transition.gateway !== authorityReceipt.gateway ||
      transition.gateway_host !== authorityReceipt.gateway_host ||
      transition.gateway_port !== authorityReceipt.gateway_port ||
      transition.sandbox_name !== authorityReceipt.sandbox_name
    ) {
      throw new Error("policy transition boundary does not match the policy creation receipt");
    }
    if (!isPolicyAdditions(plan.policy_additions)) {
      throw new Error("policy additions are invalid");
    }
    additions = withoutProviderComposedPolicies(plan.policy_additions);
    const additionNames = Object.keys(additions).sort();
    if (
      additionNames.length === 0 ||
      additionNames.length !== transition.policy_addition_names.length ||
      additionNames.some((name, index) => name !== transition.policy_addition_names[index])
    ) {
      throw new Error("policy transition additions do not match the run plan");
    }
    targetPolicy = parseOpenShellPolicy(
      readFileSync(join(stateDir, "merged-policy.yaml"), "utf-8"),
    ).policy;
    if (policyDigest(targetPolicy) !== transition.target_policy_digest) {
      throw new Error("policy transition target does not match its durable digest");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read reconciliation plan for run ${rid}: ${detail}`);
  }

  if (transition.status === "complete") {
    const validated = await validateManagedPolicyReceipt(authorityReceipt.policy_creation_receipt, {
      host: authorityReceipt.gateway_host,
      port: authorityReceipt.gateway_port,
    });
    if (
      !isDeepStrictEqual(
        policyForOwnershipProof(validated.inspection.effectivePolicy),
        policyForOwnershipProof(targetPolicy),
      )
    ) {
      throw new Error("Cannot reconcile the blueprint policy transition: live policy changed.");
    }
    log(`Policy transition for run ${rid} is already complete.`);
    return;
  }

  const observed = await inspectReceiptSandboxBinding(authorityReceipt.policy_creation_receipt, {
    host: authorityReceipt.gateway_host,
    port: authorityReceipt.gateway_port,
  });
  if (
    !isDeepStrictEqual(
      policyForOwnershipProof(observed.inspection.effectivePolicy),
      policyForOwnershipProof(targetPolicy),
    )
  ) {
    throw new Error(
      "Cannot reconcile the blueprint policy transition: OpenShell did not prove the exact intended policy.",
    );
  }
  assertBlueprintPolicyRequirements(managedInspection(observed.inspection), additions);
  const rotatedReceipt: NemoClawPolicyCreationReceipt = {
    ...observed.receipt,
    policyHash: observed.inspection.policyIdentity.hash,
    policyVersion: observed.inspection.policyIdentity.activeVersion,
  };

  persistRunReceipt(planFile, {
    ...plan,
    policy_authority: {
      ...authorityReceipt,
      policy_creation_receipt: rotatedReceipt,
    },
    policy_transition: { ...transition, status: "complete" },
  });
  log(`Policy transition for run ${rid} is complete.`);
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
  let policyTransition: BlueprintPolicyTransitionReceipt | undefined;
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
    if (rollbackPlan?.policy_creation_transition !== undefined) {
      if (!isBlueprintPolicyCreationTransition(rollbackPlan.policy_creation_transition)) {
        throw new Error("policy creation transition is invalid");
      }
      throw new Error(
        "policy creation is incomplete, so sandbox ownership is unavailable for rollback",
      );
    }
    if (rollbackPlan?.policy_authority !== undefined) {
      if (!isBlueprintPolicyAuthorityReceipt(rollbackPlan.policy_authority)) {
        throw new Error("policy authority receipt is invalid");
      }
    }
    if (rollbackPlan?.policy_transition !== undefined) {
      if (!isBlueprintPolicyTransitionReceipt(rollbackPlan.policy_transition)) {
        throw new Error("policy transition receipt is invalid");
      }
      policyTransition = rollbackPlan.policy_transition;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read rollback plan for run ${rid}: ${detail}`);
  }

  if (policyTransition && policyTransition.status !== "complete") {
    throw new Error(
      `Cannot roll back run ${rid}: the policy transition for reused sandbox ${JSON.stringify(policyTransition.sandbox_name)} through gateway ${JSON.stringify(policyTransition.gateway)} is ${policyTransition.status}. ${policyTransitionReconciliationAction(rid)}`,
    );
  }

  if (
    runtimeIdentityReceipt !== undefined ||
    sandboxCreatedByApply ||
    inferenceProviderCreatedByApply
  ) {
    throw new Error(
      `Cannot roll back run ${rid}: OpenShell exposes cleanup only through mutable sandbox and provider names. The sandbox, providers, and ownership receipt were preserved for identity-bound recovery.`,
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

  function requireValue(flag: string, i: number): string {
    if (i >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[i];
  }

  if (!action) {
    if (rawAction === "snapshots") {
      actionSnapshots(argv.slice(1), options.snapshotCommand);
      return;
    }
    throw new Error(
      `Unknown action '${rawAction ?? "(missing)"}'. Use: plan, apply, status, reconcile, rollback, snapshots`,
    );
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
    }
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
      actionStatus(runId);
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
