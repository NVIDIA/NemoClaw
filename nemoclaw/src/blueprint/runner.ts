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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";

import { execa } from "execa";
import YAML from "yaml";

import { DASHBOARD_PORT } from "../lib/ports.js";
import { buildSubprocessEnv } from "../lib/subprocess-env.js";
import { isPlainObject, type UnknownRecord } from "../shared/object-record.js";
import * as importedOpenShellPolicyBoundary from "../shared/openshell-policy-boundary.cjs";
import type { SnapshotCommandOptions } from "./snapshot-command.js";
import { actionSnapshots } from "./snapshot-command.js";
import { safeEndpointUrlForDownstream, validateEndpointUrl } from "./ssrf.js";

// The compiled plugin exposes named CommonJS exports. Source-mode tsx maps the
// .cjs specifier back to .cts and exposes that same module as its default.
const sourceOrGeneratedOpenShellPolicyBoundary =
  importedOpenShellPolicyBoundary as typeof importedOpenShellPolicyBoundary & {
    default?: typeof importedOpenShellPolicyBoundary;
  };
const { parseOpenShellPolicy, withoutProviderComposedPolicies } =
  sourceOrGeneratedOpenShellPolicyBoundary.default ?? sourceOrGeneratedOpenShellPolicyBoundary;

type Action = "plan" | "apply" | "status" | "rollback";

type RollbackPlanSource = {
  sandbox_name?: unknown;
  identity?: { provider_name?: unknown };
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
type PolicyMiddlewares = { [name: string]: PolicyMiddleware };

interface PolicyMiddleware {
  name?: string;
  middleware: string;
  order?: number;
  config?: UnknownRecord;
  on_error?: "fail_closed" | "fail_open";
  endpoints: {
    include: string[];
    exclude?: string[];
  };
}

interface OktaIdentityConfig {
  profile_path: string;
  provider_type: string;
  provider_name: string;
  credential_key: string;
  client_id_env: string;
  refresh_token_env: string;
  client_secret_env?: string;
}

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const REST_PROTOCOLS = new Set(["rest"]);
const ENDPOINT_ENFORCEMENT_MODES = new Set(["enforce", "audit"]);
const ENDPOINT_TLS_MODES = new Set(["terminate", "passthrough", "skip"]);
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,255}$/;
const PROVIDER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

function isAction(value: string | undefined): value is Action {
  return value === "plan" || value === "apply" || value === "status" || value === "rollback";
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

function isPolicyMiddleware(value: unknown): value is PolicyMiddleware {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["name", "middleware", "order", "config", "on_error", "endpoints"])
  ) {
    return false;
  }
  if (typeof value.middleware !== "string" || value.middleware.trim() === "") return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (
    value.order !== undefined &&
    (typeof value.order !== "number" || !Number.isInteger(value.order) || value.order < 0)
  ) {
    return false;
  }
  if (value.config !== undefined && !isPlainObject(value.config)) return false;
  if (
    value.on_error !== undefined &&
    value.on_error !== "fail_closed" &&
    value.on_error !== "fail_open"
  ) {
    return false;
  }
  if (!isPlainObject(value.endpoints) || !hasOnlyKeys(value.endpoints, ["include", "exclude"])) {
    return false;
  }
  const include = value.endpoints.include;
  const exclude = value.endpoints.exclude;
  return (
    Array.isArray(include) &&
    include.length > 0 &&
    include.every((entry) => typeof entry === "string" && entry.trim() !== "") &&
    (exclude === undefined ||
      (Array.isArray(exclude) &&
        exclude.every((entry) => typeof entry === "string" && entry.trim() !== "")))
  );
}

function isPolicyMiddlewares(value: unknown): value is PolicyMiddlewares {
  if (!isPlainObject(value) || Object.keys(value).length > 10) return false;
  const orders = new Set<number>();
  for (const entry of Object.values(value)) {
    if (!isPolicyMiddleware(entry)) return false;
    const order = entry.order ?? 0;
    if (orders.has(order)) return false;
    orders.add(order);
  }
  return true;
}

function isOktaIdentityConfig(value: unknown): value is OktaIdentityConfig {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, [
      "profile_path",
      "provider_type",
      "provider_name",
      "credential_key",
      "client_id_env",
      "refresh_token_env",
      "client_secret_env",
    ])
  ) {
    return false;
  }
  return (
    typeof value.profile_path === "string" &&
    value.profile_path.length > 0 &&
    typeof value.provider_type === "string" &&
    PROVIDER_TYPE_PATTERN.test(value.provider_type) &&
    typeof value.provider_name === "string" &&
    PROVIDER_NAME_PATTERN.test(value.provider_name) &&
    typeof value.credential_key === "string" &&
    ENV_NAME_PATTERN.test(value.credential_key) &&
    typeof value.client_id_env === "string" &&
    ENV_NAME_PATTERN.test(value.client_id_env) &&
    typeof value.refresh_token_env === "string" &&
    ENV_NAME_PATTERN.test(value.refresh_token_env) &&
    (value.client_secret_env === undefined ||
      (typeof value.client_secret_env === "string" &&
        ENV_NAME_PATTERN.test(value.client_secret_env)))
  );
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
    if (policy.middlewares !== undefined && !isPolicyMiddlewares(policy.middlewares)) {
      return false;
    }
  }

  const identity = components.identity;
  if (identity !== undefined) {
    if (!isPlainObject(identity) || !hasOnlyKeys(identity, ["okta"])) {
      return false;
    }
    if (identity.okta !== undefined && !isOktaIdentityConfig(identity.okta)) {
      return false;
    }
  }

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

  return value.sandbox_name;
}

function resolveBlueprintRelativePath(relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error("identity profile_path must be relative to the blueprint directory");
  }
  const normalized = normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error("identity profile_path must stay inside the blueprint directory");
  }
  return join(process.env.NEMOCLAW_BLUEPRINT_PATH ?? ".", normalized);
}

function requiredIdentityEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Okta identity requires local environment variable '${name}' to be set`);
  }
  return value;
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
  components?: {
    inference?: {
      profiles?: InferenceProfileMap;
    };
    sandbox?: SandboxConfig;
    router?: RouterConfig;
    policy?: {
      additions?: PolicyAdditions;
      middlewares?: PolicyMiddlewares;
    };
    identity?: {
      okta?: OktaIdentityConfig;
    };
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

function mergePolicyAdditions(
  currentPolicyRaw: string,
  additions: PolicyAdditions,
  middlewares: PolicyMiddlewares,
): string {
  // sourceOfTruth: nemoclaw/src/shared/openshell-policy-boundary.cts
  const current = parseOpenShellPolicy(currentPolicyRaw).policy;
  const existingNetworkPolicies = current.network_policies ?? {};
  const output: UnknownRecord = {};

  // OpenShell 0.0.72 and later expose composable top-level policy sections as
  // mappings. Preserve unknown mapping sections for forward compatibility, but
  // fail closed on a scalar or sequence until its mutation semantics are
  // reviewed for the next supported OpenShell contract.
  for (const [key, value] of Object.entries(current)) {
    if (key !== "version" && key !== "network_policies" && key !== "network_middlewares") {
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
  const existingMiddlewares = current.network_middlewares ?? {};
  if (!isPlainObject(existingMiddlewares)) {
    throw new Error("network_middlewares must be a YAML mapping");
  }
  if (Object.keys(existingMiddlewares).length > 0 || Object.keys(middlewares).length > 0) {
    output.network_middlewares = { ...existingMiddlewares, ...middlewares };
  }
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
  options?: { reject?: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await execa(args[0], args.slice(1), {
    reject: options?.reject ?? true,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function openshellAvailable(): Promise<boolean> {
  const result = await execa("which", ["openshell"], { reject: false, stdout: "pipe" });
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
  policy_additions: PolicyAdditions;
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
  policy_additions: PolicyAdditions;
  inference: SafeInferencePlan;
  identity?: {
    provider_name: string;
    credential_key: string;
  };
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
  policy_additions?: PolicyAdditions;
  inference?: SafeInferencePlan;
  identity?: {
    provider_name?: string;
    credential_key?: string;
  };
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
  policyAdditions: PolicyAdditions;
  dryRun: boolean;
}): RunPlan {
  const routerEnabled = args.routerCfg.enabled === true;
  const routerPort = args.routerCfg.port ?? DEFAULT_ROUTER_PORT;

  return {
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
}

function buildPersistedRunPlan(args: {
  runId: string;
  profile: string;
  sandboxName: string;
  policyAdditions: PolicyAdditions;
  inferenceCfg: InferenceProfile;
  oktaIdentity?: OktaIdentityConfig;
  timestamp: string;
}): PersistedRunPlan {
  const plan: PersistedRunPlan = {
    run_id: args.runId,
    profile: args.profile,
    sandbox_name: args.sandboxName,
    policy_additions: args.policyAdditions,
    inference: buildSafeInferencePlan(args.inferenceCfg),
    timestamp: args.timestamp,
  };
  if (args.oktaIdentity) {
    plan.identity = {
      provider_name: args.oktaIdentity.provider_name,
      credential_key: args.oktaIdentity.credential_key,
    };
  }
  return plan;
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

  if (isPolicyAdditions(source.policy_additions)) {
    safePlan.policy_additions = source.policy_additions;
  }

  if (isPlainObject(source.inference)) {
    safePlan.inference = buildSafeInferencePlan(source.inference);
  }

  if (isPlainObject(source.identity)) {
    const providerName = optionalString(source.identity.provider_name);
    const credentialKey = optionalString(source.identity.credential_key);
    if (providerName !== undefined || credentialKey !== undefined) {
      safePlan.identity = { provider_name: providerName, credential_key: credentialKey };
    }
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
    policyAdditions: blueprint.components?.policy?.additions ?? {},
    dryRun: options?.dryRun ?? false,
  });

  progress(100, "Plan complete");
  log(JSON.stringify(plan, null, 2));
  return plan;
}

export async function actionApply(
  profile: string,
  blueprint: Blueprint,
  options?: { planPath?: string; endpointUrl?: string },
): Promise<void> {
  if (options?.planPath) {
    throw new Error(
      "--plan is not yet implemented. Run apply without --plan to use the live blueprint.",
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
  const policyAdditions = blueprint.components?.policy?.additions ?? {};
  const policyMiddlewares = blueprint.components?.policy?.middlewares ?? {};
  const oktaIdentity = blueprint.components?.identity?.okta;
  const stateDir = join(homedir(), ".nemoclaw", "state", "runs", rid);
  mkdirSync(stateDir, { recursive: true });

  if (oktaIdentity) {
    progress(10, "Configuring Okta runtime identity");
    const profilePath = resolveBlueprintRelativePath(oktaIdentity.profile_path);
    const profileImport = await runCmd(
      ["openshell", "provider", "profile", "import", "--file", profilePath],
      { reject: false },
    );
    if (profileImport.exitCode !== 0 && !/already exists/i.test(profileImport.stderr)) {
      throw new Error(
        `Failed to import Okta provider profile: ${boundedCommandError(profileImport.stderr)}`,
      );
    }

    const providerCreate = await runCmd(
      [
        "openshell",
        "provider",
        "create",
        "--name",
        oktaIdentity.provider_name,
        "--type",
        oktaIdentity.provider_type,
        "--runtime-credentials",
      ],
      { reject: false },
    );
    if (providerCreate.exitCode !== 0 && !/already exists/i.test(providerCreate.stderr)) {
      throw new Error(
        `Failed to create Okta runtime provider '${oktaIdentity.provider_name}': ${boundedCommandError(providerCreate.stderr)}`,
      );
    }

    const clientId = requiredIdentityEnv(oktaIdentity.client_id_env);
    const refreshToken = requiredIdentityEnv(oktaIdentity.refresh_token_env);
    const refreshArgs = [
      "openshell",
      "provider",
      "refresh",
      "configure",
      oktaIdentity.provider_name,
      "--credential-key",
      oktaIdentity.credential_key,
      "--strategy",
      "oauth2-refresh-token",
      "--material",
      `client_id=${clientId}`,
      "--secret-material-env",
      `refresh_token=${oktaIdentity.refresh_token_env}`,
    ];
    const refreshEnv: Record<string, string> = {
      [oktaIdentity.refresh_token_env]: refreshToken,
    };
    const clientSecret = oktaIdentity.client_secret_env
      ? requiredIdentityEnv(oktaIdentity.client_secret_env)
      : undefined;
    if (oktaIdentity.client_secret_env && clientSecret) {
      refreshArgs.push("--secret-material-env", `client_secret=${oktaIdentity.client_secret_env}`);
      refreshEnv[oktaIdentity.client_secret_env] = clientSecret;
    }
    const refreshResult = await execa(refreshArgs[0], refreshArgs.slice(1), {
      reject: false,
      stdout: "pipe",
      stderr: "pipe",
      env: buildSubprocessEnv(refreshEnv),
    });
    if (refreshResult.exitCode !== 0) {
      throw new Error(
        `Failed to configure Okta credential refresh: ${boundedCommandError(refreshResult.stderr, [refreshToken, clientSecret ?? ""])}`,
      );
    }

    const rotate = await runCmd(
      [
        "openshell",
        "provider",
        "refresh",
        "rotate",
        oktaIdentity.provider_name,
        "--credential-key",
        oktaIdentity.credential_key,
      ],
      { reject: false },
    );
    if (rotate.exitCode !== 0) {
      throw new Error(
        `Failed to mint Okta runtime credential: ${boundedCommandError(rotate.stderr)}`,
      );
    }
  }

  progress(20, "Creating OpenClaw sandbox");
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

  const createResult = await runCmd(createArgs, { reject: false });
  if (createResult.exitCode !== 0) {
    if (createResult.stderr.includes("already exists")) {
      log(`Sandbox '${sandboxName}' already exists, reusing.`);
    } else {
      throw new Error(`Failed to create sandbox: ${createResult.stderr}`);
    }
  }

  if (oktaIdentity) {
    const attach = await runCmd(
      ["openshell", "sandbox", "provider", "attach", sandboxName, oktaIdentity.provider_name],
      { reject: false },
    );
    if (attach.exitCode !== 0 && !/already attached/i.test(attach.stderr)) {
      throw new Error(
        `Failed to attach Okta runtime provider '${oktaIdentity.provider_name}': ${boundedCommandError(attach.stderr)}`,
      );
    }
  }

  progress(50, "Configuring inference provider");
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
  });
  // A required mutation: a silently-ignored failure would persist plan.json and
  // report a ready sandbox that cannot perform inference. Mirror the
  // sandbox-create contract above — tolerate an already-existing provider as a
  // reuse (keeps re-apply idempotent) and fail on any other non-zero result.
  // The credential is passed via env (never argv); redact it from stderr before
  // surfacing bounded diagnostic context. (#6703)
  if (providerResult.exitCode !== 0) {
    if (providerResult.stderr.includes("already exists")) {
      log(`Provider '${providerName}' already exists, reusing.`);
    } else {
      throw new Error(
        `Failed to create inference provider '${providerName}': ${boundedCommandError(providerResult.stderr, [credential])}`,
      );
    }
  }

  progress(70, "Setting inference route");
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

  if (Object.keys(policyAdditions).length > 0 || Object.keys(policyMiddlewares).length > 0) {
    progress(78, "Applying policy additions");
    const currentPolicy = await runCmd(["openshell", "policy", "get", "--base", sandboxName], {
      reject: false,
    });
    if (currentPolicy.exitCode !== 0) {
      throw new Error(
        `Failed to read current policy before applying additions: ${currentPolicy.stderr}`,
      );
    }

    const mergedPolicyFile = join(stateDir, "merged-policy.yaml");
    writeFileSync(
      mergedPolicyFile,
      mergePolicyAdditions(currentPolicy.stdout, policyAdditions, policyMiddlewares),
      {
        encoding: "utf-8",
        mode: 0o600,
      },
    );

    const policySet = await runCmd(
      ["openshell", "policy", "set", "--policy", mergedPolicyFile, "--wait", sandboxName],
      { reject: false },
    );
    if (policySet.exitCode !== 0) {
      throw new Error(`Failed to apply policy additions: ${policySet.stderr}`);
    }
  }

  progress(85, "Saving run state");
  writeFileSync(
    join(stateDir, "plan.json"),
    JSON.stringify(
      buildPersistedRunPlan({
        runId: rid,
        profile,
        sandboxName,
        policyAdditions,
        inferenceCfg,
        oktaIdentity,
        timestamp: new Date().toISOString(),
      }),
      null,
      2,
    ),
  );

  progress(100, "Apply complete");
  log(`Sandbox '${sandboxName}' is ready.`);
  log(`Inference: ${providerName} -> ${model} @ ${endpoint}`);
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
  try {
    const planData = readFileSync(join(runDir, "plan.json"), "utf-8");
    const parsedPlan: unknown = JSON.parse(planData);
    const safePlan = buildStatusRunPlan(parsedPlan, name);
    if (!safePlan) {
      throw new Error("plan.json must contain a JSON object");
    }
    log(JSON.stringify(safePlan, null, 2));
  } catch {
    log(JSON.stringify({ run_id: name, status: "unknown" }));
  }
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
  let providerName: string | undefined;
  try {
    const planData = readFileSync(planFile, "utf-8");
    const parsedPlan: unknown = JSON.parse(planData);
    const rollbackPlan: RollbackPlanSource | null =
      typeof parsedPlan === "object" && parsedPlan !== null && !Array.isArray(parsedPlan)
        ? parsedPlan
        : null;
    sandboxName = readRollbackSandboxName(rollbackPlan);
    if (typeof rollbackPlan?.identity?.provider_name === "string") {
      providerName = rollbackPlan.identity.provider_name;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read rollback plan for run ${rid}: ${detail}`);
  }

  try {
    if (providerName) {
      await runCmd(["openshell", "sandbox", "provider", "detach", sandboxName, providerName], {
        reject: false,
      });
    }
    progress(30, `Stopping sandbox ${sandboxName}`);
    await runCmd(["openshell", "sandbox", "stop", sandboxName], { reject: false });

    progress(60, `Removing sandbox ${sandboxName}`);
    await runCmd(["openshell", "sandbox", "remove", sandboxName], { reject: false });
  } catch {
    // Sandbox cleanup is best-effort; the rollback marker still records this run as handled.
  }

  progress(90, "Cleaning up run state");
  writeFileSync(join(stateDir, "rolled_back"), new Date().toISOString());

  progress(100, "Rollback complete");
}

// ── CLI ─────────────────────────────────────────────────────────

export async function main(
  argv: string[] = process.argv.slice(2),
  options: { snapshotCommand?: SnapshotCommandOptions } = {},
): Promise<void> {
  const rawAction = argv.at(0);
  const action = isAction(rawAction) ? rawAction : undefined;
  let profile = "default";
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
      `Unknown action '${rawAction ?? "(missing)"}'. Use: plan, apply, status, rollback, snapshots`,
    );
  }

  for (let i = 1; i < argv.length; i++) {
    switch (argv[i]) {
      case "--profile":
        profile = requireValue("--profile", ++i);
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
      await actionPlan(profile, blueprint, { dryRun, endpointUrl });
      break;
    }
    case "apply": {
      const blueprint = loadBlueprint();
      await actionApply(profile, blueprint, { planPath, endpointUrl });
      break;
    }
    case "status":
      actionStatus(runId);
      break;
    case "rollback":
      if (!runId) {
        throw new Error("--run-id is required for rollback");
      }
      await actionRollback(runId);
      break;
  }
}
