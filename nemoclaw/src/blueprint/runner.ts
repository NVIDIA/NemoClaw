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
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { execa } from "execa";
import YAML from "yaml";

import { DASHBOARD_PORT } from "../lib/ports.js";
import { buildSubprocessEnv } from "../lib/subprocess-env.js";
import { isPlainObject, type UnknownRecord } from "../shared/object-record.js";
import * as importedOpenShellExternalTargetBoundary from "../shared/openshell-external-target-boundary.cjs";
import * as importedOpenShellPolicyBoundary from "../shared/openshell-policy-boundary.cjs";
import * as importedSandboxName from "../shared/sandbox-name.cjs";
import type { SanitizedExternalOpenShellTargetPlan } from "../shared/openshell-external-target-boundary.cjs";
import {
  attachRuntimeIdentity,
  buildRuntimeIdentityPlan,
  compensateRuntimeIdentityApply,
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
  removeRuntimeIdentity,
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
  assertMatchingPolicyAuthority,
  assertPolicyRequirementContainment,
  parseOpenShellPolicy,
  parseSandboxPolicyAuthorityMetadata,
  withoutProviderComposedPolicies,
} = sourceOrGeneratedOpenShellPolicyBoundary.default ?? sourceOrGeneratedOpenShellPolicyBoundary;

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

type BlueprintPolicyAuthorityReceipt = {
  authority: BlueprintPolicyAuthorityInspection["authority"];
  gateway: string;
  scope: "global" | "sandbox";
  sandbox_name?: string;
};

type BlueprintPolicyTransitionReceipt = {
  status: "pending" | "incomplete" | "complete";
  sandbox_name: string;
  gateway: string;
  expected_authority: "nemoclaw-managed";
  policy_addition_names: string[];
};

type StatusPolicyTransition = BlueprintPolicyTransitionReceipt & {
  reconciliation_required: boolean;
  reconciliation_action?: string;
};

const POLICY_TRANSITION_RECONCILIATION_ACTION =
  "Run reconcile with this run ID before retrying apply or rollback.";

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const REST_PROTOCOLS = new Set(["rest"]);
const ENDPOINT_ENFORCEMENT_MODES = new Set(["enforce", "audit"]);
const ENDPOINT_TLS_MODES = new Set(["terminate", "passthrough", "skip"]);
const MISSING_SANDBOX_PATTERN = /\b(?:not found|does not exist)\b/i;
const MISSING_SANDBOX_INSPECTION_PATTERN =
  /(?:\bsandbox\b[^\r\n]*\b(?:not found|does not exist)\b|\b(?:not found|does not exist)\b[^\r\n]*\bsandbox\b)/i;
const MISSING_PROVIDER_INSPECTION_PATTERN =
  /(?:\bprovider\b[^\r\n]*\b(?:not found|does not exist)\b|\b(?:not found|does not exist)\b[^\r\n]*\bprovider\b|\bunknown provider\b)/i;
const POLICY_AUTHORITY_MAX_BYTES = 1024 * 1024;
const POLICY_AUTHORITY_TIMEOUT_MS = 30_000;

interface InferenceRouteBinding {
  provider: string;
  model: string;
  timeoutSeconds?: number;
}

function assertReusableRuntimeIdentitySandbox(output: string, expectedName: string): void {
  const lines = output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const nameLine = lines.find((line) => /^\s*Name:/i.test(line));
  const phaseLine = lines.find((line) => /^\s*Phase:/i.test(line));
  const name = /^\s*Name:\s*(.+)$/i.exec(nameLine ?? "")?.[1]?.trim();
  const phase = /^\s*Phase:\s*(.+)$/i.exec(phaseLine ?? "")?.[1]?.trim();
  if (name !== expectedName || phase !== "Ready") {
    throw new Error(
      `Sandbox '${expectedName}' is not reusable for runtime identity apply: expected exact name and Ready phase, received ${boundedCommandError(output)}`,
    );
  }
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
    maxBuffer?: number;
    omitSandboxPolicy?: boolean;
    reject?: boolean;
    timeout?: number;
  },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = buildSubprocessEnv();
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

async function inspectActiveGatewayIdentity(): Promise<string> {
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
  return assertValidName(gateways[0], "OpenShell gateway name");
}

async function runBlueprintPolicyAuthorityCommand(
  command: string[],
  subject: "global" | "sandbox",
): Promise<Awaited<ReturnType<typeof runCmd>>> {
  let result: Awaited<ReturnType<typeof runCmd>>;
  try {
    result = await runCmd(command, {
      maxBuffer: POLICY_AUTHORITY_MAX_BYTES,
      reject: false,
      timeout: POLICY_AUTHORITY_TIMEOUT_MS,
    });
  } catch {
    throw new Error(
      `OpenShell ${subject} policy authority inspection failed. Policy-dependent operations must stop.`,
    );
  }
  if (
    result.exitCode !== 0 ||
    Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8") >
      POLICY_AUTHORITY_MAX_BYTES
  ) {
    throw new Error(
      `OpenShell ${subject} policy authority inspection failed. Policy-dependent operations must stop.`,
    );
  }
  return result;
}

async function inspectBlueprintPolicyAuthority(
  gateway: string,
  sandboxName?: string,
): Promise<BlueprintPolicyAuthorityInspection> {
  const subject = sandboxName === undefined ? "global" : "sandbox";
  if (sandboxName === undefined) {
    const history = await runBlueprintPolicyAuthorityCommand(
      ["openshell", "policy", "list", "-g", gateway, "--global", "--limit", "1"],
      subject,
    );
    if (history.stdout.trim().length === 0) {
      return { authority: "nemoclaw-managed", effectivePolicy: {} };
    }
  }
  const command =
    sandboxName === undefined
      ? ["openshell", "policy", "get", "-g", gateway, "--global", "--full", "--output", "json"]
      : ["openshell", "policy", "get", "-g", gateway, "--full", "--output", "json", sandboxName];
  const result = await runBlueprintPolicyAuthorityCommand(command, subject);
  if (sandboxName === undefined) {
    if (result.stdout.trim().length === 0) {
      throw new Error(
        "OpenShell returned empty global policy authority metadata. Policy-dependent operations must stop.",
      );
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        "OpenShell returned malformed global policy authority metadata. Policy-dependent operations must stop.",
      );
    }
    if (
      !isPlainObject(metadata) ||
      metadata.scope !== "global" ||
      (metadata.status !== "loaded" && metadata.status !== "superseded") ||
      (metadata.policy_source !== undefined && metadata.policy_source !== "global") ||
      Object.hasOwn(metadata, "sandbox")
    ) {
      throw new Error(
        "OpenShell returned invalid global policy authority metadata. Policy-dependent operations must stop.",
      );
    }
    if (metadata.status === "superseded") {
      return { authority: "nemoclaw-managed", effectivePolicy: {} };
    }
    if (!isPlainObject(metadata.policy)) {
      throw new Error(
        "OpenShell returned invalid global policy authority metadata. Policy-dependent operations must stop.",
      );
    }
    return { authority: "externally-managed", effectivePolicy: metadata.policy };
  }
  try {
    return parseSandboxPolicyAuthorityMetadata(result.stdout, sandboxName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "OpenShell returned invalid metadata";
    throw new Error(`${detail}. Policy-dependent operations must stop.`);
  }
}

function assertBlueprintPolicyAuthorityMatches(
  recorded: BlueprintPolicyAuthorityInspection,
  observed: BlueprintPolicyAuthorityInspection,
): void {
  try {
    assertMatchingPolicyAuthority(recorded.authority, observed.authority);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "policy authority is invalid";
    throw new Error(`Refusing to apply blueprint policy additions because ${detail}.`);
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

async function runRuntimeIdentityCommand(
  args: string[],
  options?: RuntimeIdentityCommandOptions,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(args[0], args.slice(1), {
    reject: false,
    stdout: "pipe",
    stderr: "pipe",
    env: buildSubprocessEnv(options?.env),
    extendEnv: false,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runtimeIdentityCommandDeps(): RuntimeIdentityCommandDeps {
  return {
    run: runRuntimeIdentityCommand,
    formatError: boundedCommandError,
  };
}

function runtimeIdentityDeps(
  persistReceipt: (receipt: RuntimeIdentityReceipt) => void,
  profilePolicy?: RuntimeIdentityProfilePolicy,
): RuntimeIdentityDeps {
  return {
    ...runtimeIdentityCommandDeps(),
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
  policy_authority: BlueprintPolicyAuthorityReceipt;
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
    !isValidName(value.gateway)
  ) {
    return false;
  }
  return value.scope === "global"
    ? value.sandbox_name === undefined
    : isValidName(value.sandbox_name);
}

function isBlueprintPolicyTransitionReceipt(
  value: unknown,
): value is BlueprintPolicyTransitionReceipt {
  if (!isPlainObject(value)) return false;
  if (
    (value.status !== "pending" && value.status !== "incomplete" && value.status !== "complete") ||
    !isValidName(value.sandbox_name) ||
    !isValidName(value.gateway) ||
    value.expected_authority !== "nemoclaw-managed" ||
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
  policyAuthorityReceipt: BlueprintPolicyAuthorityReceipt;
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
    policy_authority: args.policyAuthorityReceipt,
    inference: buildSafeInferencePlan(args.inferenceCfg),
    timestamp: args.timestamp,
  };
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
  renameSync(pendingFile, planFile);
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
  if (isBlueprintPolicyAuthorityReceipt(source.policy_authority)) {
    safePlan.policy_authority = source.policy_authority;
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
        ? { reconciliation_action: POLICY_TRANSITION_RECONCILIATION_ACTION }
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
  const policyGateway = await inspectActiveGatewayIdentity();
  const initialPolicyAuthority = await inspectBlueprintPolicyAuthority(policyGateway);
  const stateDir = join(homedir(), ".nemoclaw", "state", "runs", rid);
  mkdirSync(stateDir, { recursive: true });

  let runtimeIdentityReceipt: RuntimeIdentityReceipt | undefined;
  let policyAuthorityReceipt: BlueprintPolicyAuthorityReceipt = {
    authority: initialPolicyAuthority.authority,
    gateway: policyGateway,
    scope: "global",
  };
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
        policyTransition,
        inferenceCfg,
        runtimeIdentityReceipt,
        timestamp: new Date().toISOString(),
      }),
    );
  };
  const identityDeps = runtimeIdentityDeps((receipt) => {
    runtimeIdentityReceipt = receipt;
    persistRunPlan();
  }, options?.runtimeIdentityProfilePolicy);
  persistRunPlan();
  assertBlueprintExternalPolicyRequirements(initialPolicyAuthority, policyAdditions);

  try {
    let reuseExistingSandbox = false;
    let reuseExistingInferenceProvider = false;
    let reuseExistingInferenceRoute = false;
    if (runtimeIdentityConfig) {
      const sandboxResult = await runCmd(["openshell", "sandbox", "get", sandboxName], {
        reject: false,
      });
      const sandboxOutput = `${sandboxResult.stderr}\n${sandboxResult.stdout}`;
      if (sandboxResult.exitCode === 0) {
        assertReusableRuntimeIdentitySandbox(sandboxResult.stdout, sandboxName);
        reuseExistingSandbox = true;
      } else if (!MISSING_SANDBOX_INSPECTION_PATTERN.test(sandboxOutput)) {
        throw new Error(
          `Failed to inspect sandbox '${sandboxName}' before runtime identity apply: ${boundedCommandError(sandboxOutput)}`,
        );
      }

      const providerResult = await runCmd(["openshell", "provider", "get", providerName], {
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

      if (reuseExistingSandbox && reuseExistingInferenceProvider) {
        const routeResult = await runCmd(["openshell", "inference", "get"], {
          reject: false,
        });
        const routeOutput = `${routeResult.stderr}\n${routeResult.stdout}`;
        if (routeResult.exitCode !== 0) {
          throw new Error(
            `Failed to inspect the active inference route before runtime identity apply: ${boundedCommandError(routeOutput)}`,
          );
        }
        const activeRoute = parseInferenceRouteBinding(routeResult.stdout);
        if (!activeRoute && !isUnconfiguredInferenceRoute(routeResult.stdout)) {
          throw new Error(
            `Failed to parse the active inference route before runtime identity apply: ${boundedCommandError(routeOutput)}`,
          );
        }
        reuseExistingInferenceRoute =
          activeRoute?.provider === providerName &&
          activeRoute.model === model &&
          (inferenceCfg.timeout_secs === undefined ||
            activeRoute.timeoutSeconds === inferenceCfg.timeout_secs);
      }

      progress(10, "Configuring runtime identity");
      // Establish durable state before the first identity mutation, then update
      // the receipt after each acquired resource.
      persistRunPlan();
      runtimeIdentityReceipt = await prepareRuntimeIdentity(runtimeIdentityConfig, identityDeps);
      persistRunPlan();
    }

    progress(20, "Creating OpenClaw sandbox");
    if (reuseExistingSandbox) {
      log(`Sandbox '${sandboxName}' already exists, reusing.`);
    } else {
      const createArgs = [
        "openshell",
        "sandbox",
        "create",
        "--from",
        sandboxImage,
        "--name",
        sandboxName,
      ];
      for (const port of forwardPorts) {
        createArgs.push("--forward", String(port));
      }

      const createResult = await runCmd(createArgs, {
        omitSandboxPolicy: initialPolicyAuthority.authority === "externally-managed",
        reject: false,
      });
      sandboxCreatedByApply = createResult.exitCode === 0;
      if (sandboxCreatedByApply) {
        // Persist ownership immediately so a later-process rollback stays safe
        // if apply is interrupted before its final state write.
        persistRunPlan();
      }
      if (createResult.exitCode !== 0) {
        if (createResult.stderr.includes("already exists")) {
          if (runtimeIdentityConfig) {
            const racedSandbox = await runCmd(["openshell", "sandbox", "get", sandboxName], {
              reject: false,
            });
            if (racedSandbox.exitCode !== 0) {
              throw new Error(
                `Failed to inspect sandbox '${sandboxName}' after concurrent creation: ${boundedCommandError(`${racedSandbox.stderr}\n${racedSandbox.stdout}`)}`,
              );
            }
            assertReusableRuntimeIdentitySandbox(racedSandbox.stdout, sandboxName);
          }
          log(`Sandbox '${sandboxName}' already exists, reusing.`);
        } else {
          throw new Error(`Failed to create sandbox: ${createResult.stderr}`);
        }
      }
    }

    {
      const observedPolicyAuthority = await inspectBlueprintPolicyAuthority(
        policyGateway,
        sandboxName,
      );
      if (sandboxCreatedByApply) {
        assertBlueprintPolicyAuthorityMatches(initialPolicyAuthority, observedPolicyAuthority);
      }
      sandboxPolicyAuthority = observedPolicyAuthority;
      policyAuthorityReceipt = {
        authority: observedPolicyAuthority.authority,
        gateway: policyGateway,
        scope: "sandbox",
        sandbox_name: sandboxName,
      };
      persistRunPlan();
      assertBlueprintExternalPolicyRequirements(observedPolicyAuthority, policyAdditions);
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
        env: buildSubprocessEnv(credEnv),
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
        persistRunPlan();
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
      const inferenceResult = await runCmd(inferenceArgs, { reject: false });
      // Another required mutation: without a routed provider the sandbox cannot
      // perform inference, so a non-zero result must abort the apply. (#6703)
      if (inferenceResult.exitCode !== 0) {
        throw new Error(
          `Failed to set inference route (provider '${providerName}', model '${model}'): ${boundedCommandError(inferenceResult.stderr)}`,
        );
      }
    }

    if (runtimeIdentityReceipt) {
      const attachmentSandbox = await runCmd(["openshell", "sandbox", "get", sandboxName], {
        reject: false,
      });
      if (attachmentSandbox.exitCode !== 0) {
        throw new Error(
          `Failed to inspect sandbox '${sandboxName}' immediately before runtime identity attachment: ${boundedCommandError(`${attachmentSandbox.stderr}\n${attachmentSandbox.stdout}`)}`,
        );
      }
      assertReusableRuntimeIdentitySandbox(attachmentSandbox.stdout, sandboxName);
      const attachmentCreated = await attachRuntimeIdentity(
        runtimeIdentityReceipt,
        sandboxName,
        identityDeps,
      );
      runtimeIdentityReceipt = {
        ...runtimeIdentityReceipt,
        attachment_created: attachmentCreated,
      };
      persistRunPlan();
      await mintRuntimeIdentityCredential(runtimeIdentityReceipt, identityDeps);
    }

    if (Object.keys(policyAdditions).length > 0) {
      if (!sandboxPolicyAuthority) {
        throw new Error("Sandbox policy authority is unavailable before applying additions.");
      }
      const observedPolicyAuthority = await inspectBlueprintPolicyAuthority(
        policyGateway,
        sandboxName,
      );
      assertBlueprintPolicyAuthorityMatches(sandboxPolicyAuthority, observedPolicyAuthority);
      assertBlueprintExternalPolicyRequirements(observedPolicyAuthority, policyAdditions);
      if (observedPolicyAuthority.authority === "nemoclaw-managed") {
        progress(78, "Applying policy additions");
        const currentPolicy = await runCmd(
          ["openshell", "policy", "get", "-g", policyGateway, "--base", sandboxName],
          { reject: false },
        );
        if (currentPolicy.exitCode !== 0) {
          throw new Error(
            `Failed to read current policy before applying additions: ${boundedCommandError(currentPolicy.stderr)}`,
          );
        }

        const mergedPolicyFile = join(stateDir, "merged-policy.yaml");
        writeFileSync(
          mergedPolicyFile,
          mergePolicyAdditions(currentPolicy.stdout, policyAdditions),
          {
            encoding: "utf-8",
            mode: 0o600,
          },
        );

        const beforeMutation = await inspectBlueprintPolicyAuthority(policyGateway, sandboxName);
        assertBlueprintPolicyAuthorityMatches(sandboxPolicyAuthority, beforeMutation);
        policyTransition = {
          status: "pending",
          sandbox_name: sandboxName,
          gateway: policyGateway,
          expected_authority: "nemoclaw-managed",
          policy_addition_names: Object.keys(policyAdditions).sort(),
        };
        persistRunPlan();
        const policySet = await runCmd(
          [
            "openshell",
            "policy",
            "set",
            "-g",
            policyGateway,
            "--policy",
            mergedPolicyFile,
            "--wait",
            sandboxName,
          ],
          { reject: false },
        );
        if (policySet.exitCode !== 0) {
          throw new Error(
            `Failed to apply policy additions: ${boundedCommandError(policySet.stderr)}`,
          );
        }
        policyTransition = { ...policyTransition, status: "incomplete" };
        persistRunPlan();
      }
    }

    progress(85, "Saving run state");
    if (!sandboxPolicyAuthority) {
      throw new Error("Sandbox policy authority is unavailable before saving run state.");
    }
    const finalPolicyAuthority = await inspectBlueprintPolicyAuthority(policyGateway, sandboxName);
    assertBlueprintPolicyAuthorityMatches(sandboxPolicyAuthority, finalPolicyAuthority);
    assertBlueprintExternalPolicyRequirements(finalPolicyAuthority, policyAdditions);
    if (policyTransition) {
      policyTransition = { ...policyTransition, status: "complete" };
    }
    persistRunPlan();

    progress(100, "Apply complete");
    log(`Sandbox '${sandboxName}' is ready.`);
    log(`Inference: ${providerName} -> ${model} @ ${endpoint}`);
  } catch (error) {
    const cleanupFailures: string[] = [];
    if (runtimeIdentityReceipt) {
      try {
        await compensateRuntimeIdentityApply(runtimeIdentityReceipt, sandboxName, identityDeps);
        runtimeIdentityReceipt = {
          ...runtimeIdentityReceipt,
          provider_created: false,
          attachment_created: false,
        };
        persistRunPlan();
      } catch (cleanupError) {
        cleanupFailures.push(
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        );
      }
    }
    if (sandboxCreatedByApply) {
      await runCmd(["openshell", "sandbox", "stop", sandboxName], { reject: false });
      const remove = await runCmd(["openshell", "sandbox", "remove", sandboxName], {
        reject: false,
      });
      if (remove.exitCode === 0 || MISSING_SANDBOX_PATTERN.test(remove.stderr)) {
        sandboxCreatedByApply = false;
        if (policyTransition) {
          policyTransition = { ...policyTransition, status: "complete" };
        }
        persistRunPlan();
      } else {
        cleanupFailures.push(
          `Failed to remove sandbox '${sandboxName}': ${boundedCommandError(remove.stderr)}`,
        );
      }
    }
    if (inferenceProviderCreatedByApply && !sandboxCreatedByApply) {
      const removeProvider = await runCmd(["openshell", "provider", "delete", providerName], {
        reject: false,
      });
      if (
        removeProvider.exitCode === 0 ||
        MISSING_PROVIDER_INSPECTION_PATTERN.test(removeProvider.stderr)
      ) {
        inferenceProviderCreatedByApply = false;
        persistRunPlan();
      } else {
        cleanupFailures.push(
          `Failed to remove inference provider '${providerName}': ${boundedCommandError(removeProvider.stderr)}`,
        );
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    if (cleanupFailures.length > 0) {
      throw new Error(`${message}; cleanup failed: ${cleanupFailures.join("; ")}`);
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
  try {
    const parsedPlan: unknown = JSON.parse(readFileSync(planFile, "utf-8"));
    if (!isPlainObject(parsedPlan)) {
      throw new Error("plan.json must contain a JSON object");
    }
    plan = parsedPlan;
    if (plan.sandbox_created_by_apply !== false) {
      throw new Error("policy reconciliation requires a reused sandbox");
    }
    const sandboxName = readRollbackSandboxName(plan);
    if (!isBlueprintPolicyTransitionReceipt(plan.policy_transition)) {
      throw new Error("policy transition receipt is invalid");
    }
    transition = plan.policy_transition;
    if (transition.sandbox_name !== sandboxName) {
      throw new Error("policy transition sandbox does not match the run plan");
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read reconciliation plan for run ${rid}: ${detail}`);
  }

  if (transition.status === "complete") {
    log(`Policy transition for run ${rid} is already complete.`);
    return;
  }

  const observed = await inspectBlueprintPolicyAuthority(
    transition.gateway,
    transition.sandbox_name,
  );
  try {
    assertMatchingPolicyAuthority(transition.expected_authority, observed.authority);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "policy authority is invalid";
    throw new Error(`Cannot reconcile the blueprint policy transition: ${detail}.`);
  }
  assertBlueprintPolicyRequirements(observed, additions);

  persistRunReceipt(planFile, {
    ...plan,
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
  let inferenceProviderName: string | undefined;
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
      inferenceProviderName = readRollbackInferenceProviderName(rollbackPlan!);
    }
    if (rollbackPlan?.identity !== undefined) {
      if (!isRuntimeIdentityReceipt(rollbackPlan.identity)) {
        throw new Error("identity ownership receipt is invalid");
      }
      runtimeIdentityReceipt = rollbackPlan.identity;
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

  if (!sandboxCreatedByApply && policyTransition && policyTransition.status !== "complete") {
    throw new Error(
      `Cannot roll back run ${rid}: the policy transition for reused sandbox ${JSON.stringify(policyTransition.sandbox_name)} through gateway ${JSON.stringify(policyTransition.gateway)} is ${policyTransition.status}. ${POLICY_TRANSITION_RECONCILIATION_ACTION}`,
    );
  }

  if (runtimeIdentityReceipt) {
    progress(20, `Removing runtime identity provider ${runtimeIdentityReceipt.provider_name}`);
    await removeRuntimeIdentity(runtimeIdentityReceipt, sandboxName, runtimeIdentityCommandDeps());
  }

  if (sandboxCreatedByApply) {
    progress(30, `Stopping sandbox ${sandboxName}`);
    const stop = await runCmd(["openshell", "sandbox", "stop", sandboxName], { reject: false });

    progress(60, `Removing sandbox ${sandboxName}`);
    const remove = await runCmd(["openshell", "sandbox", "remove", sandboxName], {
      reject: false,
    });
    if (remove.exitCode !== 0 && !MISSING_SANDBOX_PATTERN.test(remove.stderr)) {
      const stopFailure =
        stop.exitCode !== 0 && !MISSING_SANDBOX_PATTERN.test(stop.stderr)
          ? `; sandbox stop also failed: ${boundedCommandError(stop.stderr)}`
          : "";
      throw new Error(
        `Failed to remove owned sandbox '${sandboxName}': ${boundedCommandError(remove.stderr)}` +
          stopFailure,
      );
    }
  } else {
    progress(60, `Preserving unowned sandbox ${sandboxName}`);
  }

  if (inferenceProviderCreatedByApply) {
    progress(80, `Removing inference provider ${inferenceProviderName!}`);
    const removeProvider = await runCmd(
      ["openshell", "provider", "delete", inferenceProviderName!],
      { reject: false },
    );
    if (
      removeProvider.exitCode !== 0 &&
      !MISSING_PROVIDER_INSPECTION_PATTERN.test(removeProvider.stderr)
    ) {
      throw new Error(
        `Failed to remove owned inference provider '${inferenceProviderName!}': ${boundedCommandError(removeProvider.stderr)}`,
      );
    }
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
