// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash, X509Certificate } from "node:crypto";

import { MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW } from "../../inference/ollama-runtime-context";
import { hydrateDerivedSandboxMessagingPlanFields } from "../../messaging/hydration";
import { parseSandboxMessagingPlan } from "../../messaging/plan-validation";
import { withLocalNoProxy } from "../../proxy/local-no-proxy";
import {
  MAX_CORPORATE_CA_BYTES,
  MAX_CORPORATE_CA_CERTS,
  PEM_CERTIFICATE_RE_GLOBAL,
} from "../corporate-ca-policy";
import type { ResolvedCorporateCa } from "../corporate-ca-types";
import { normalizeCertificateBlocks } from "../corporate-ca-validation";
import {
  encodeManagedStartupProfile,
  MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY,
  MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  MANAGED_STARTUP_REASONING_EFFORTS,
  type ManagedStartupAgent,
  type ManagedStartupDashboard,
  type ManagedStartupDcodeAutoApprovalMode,
  type ManagedStartupExtraAgents,
  type ManagedStartupHermesToolGateway,
  type ManagedStartupInputModality,
  type ManagedStartupJsonObject,
  type ManagedStartupProfile,
  type ManagedStartupReasoningEffort,
  type ManagedStartupToolDisclosure,
  type ManagedStartupWebSearch,
  validateManagedStartupProfile,
} from "./profile";

const DEFAULT_MANAGED_PROXY_HOST = "10.200.0.1";
const DEFAULT_MANAGED_PROXY_PORT = 3128;
const DEFAULT_CONTEXT_WINDOW = 131_072;
const DEFAULT_OPENCLAW_MAX_TOKENS = 4096;
const DEFAULT_OPENCLAW_AGENT_TIMEOUT_SECONDS = 600;
const DEFAULT_OPENCLAW_OTEL_ENDPOINT = "http://host.openshell.internal:4318";
const DEFAULT_OPENCLAW_OTEL_SERVICE_NAME = "openclaw-gateway";
const MIN_HERMES_CONTEXT_WINDOW = 64_000;
const MAX_PROFILE_TUNING_INTEGER = 1_000_000_000;
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const STANDARD_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MANAGED_STARTUP_HOST_PROXY_URL_INPUTS_BY_PROTOCOL = {
  http: { upper: "HTTP_PROXY", lower: "http_proxy" },
  https: { upper: "HTTPS_PROXY", lower: "https_proxy" },
} as const;
export const MANAGED_STARTUP_HOST_PROXY_URL_INPUTS = [
  MANAGED_STARTUP_HOST_PROXY_URL_INPUTS_BY_PROTOCOL.http.upper,
  MANAGED_STARTUP_HOST_PROXY_URL_INPUTS_BY_PROTOCOL.https.upper,
  MANAGED_STARTUP_HOST_PROXY_URL_INPUTS_BY_PROTOCOL.http.lower,
  MANAGED_STARTUP_HOST_PROXY_URL_INPUTS_BY_PROTOCOL.https.lower,
] as const;

/**
 * These digests deliberately bind the builder to every classified stock
 * Docker/runtime affordance, including its profile path and representation.
 * Adding or reclassifying an affordance must update the builder in the same
 * change; otherwise construction fails before a sandbox is launched.
 */
const EXPECTED_AFFORDANCE_INVENTORY_SHA256 = {
  openclaw: "9b722441e33f0b0d7580f74cd185c0174979de9c1a784556ff56ff931b2c9904",
  hermes: "795c97be2dcb1921e06328a6d23b1f7389ebb2f6a085fa67b7aaa0f287ce88e0",
  "langchain-deepagents-code": "08c75cf22495ec93a090bc5b70544eac65970e658b10fba057dea5ffef502e4a",
  pi: "6302d387182c596fd67ad18577ecf82107bad6271aeeb5e69714115f91557abb",
} as const satisfies Record<ManagedStartupAgent, string>;

const INVENTORY_INPUTS = new Set(
  Object.values(MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY).flatMap((entries) =>
    entries.map((entry) => entry.input),
  ),
);

export interface ManagedStartupResolvedInferenceInput {
  readonly routeProvider: string;
  readonly upstreamProvider: string;
  readonly model: string;
  readonly routedBaseUrl: string;
  readonly upstreamEndpointUrl: string | null;
  readonly api: ManagedStartupProfile["inference"]["api"];
  readonly primaryModelRef: string | null;
  readonly compatibility: Readonly<Record<string, unknown>> | null;
}

export interface ManagedStartupProfileBuilderInput {
  readonly agent: ManagedStartupAgent;
  /** Fully resolved host semantics; the portable builder never selects providers. */
  readonly inference: ManagedStartupResolvedInferenceInput;
  readonly dashboard: ManagedStartupDashboard;
  readonly webSearch: {
    readonly fetchEnabled: boolean;
    readonly provider?: "brave" | "tavily";
  } | null;
  readonly toolDisclosure: ManagedStartupToolDisclosure;
  readonly hermesToolGateways: readonly string[];
  readonly messagingPlan: unknown | null;
  readonly dcodeAutoApprovalMode: ManagedStartupDcodeAutoApprovalMode | null;
  readonly observabilityEnabled: boolean | null;
  /**
   * Host onboarding knobs only. The builder reads an exact allowlist and never
   * copies this object wholesale, so ambient credentials cannot enter a profile.
   */
  readonly environment: NodeJS.ProcessEnv;
  /** Validated host CA material returned by the existing corporate-CA resolver. */
  readonly corporateCa?: ResolvedCorporateCa | null;
}

declare const VALIDATED_MANAGED_STARTUP_PROFILE_TRANSPORT: unique symbol;

/**
 * A profile transport whose bounded profile and nested messaging plan were
 * validated by the host-side construction boundary before encoding.
 *
 * This brand does not replace validation after transport. The application
 * boundary must decode the profile and re-run parseSandboxMessagingPlan before
 * it changes configuration or shared state.
 */
export type ValidatedManagedStartupProfileTransport = string & {
  readonly [VALIDATED_MANAGED_STARTUP_PROFILE_TRANSPORT]: true;
};

export interface BuiltManagedStartupProfile {
  readonly profile: ManagedStartupProfile;
  readonly encodedProfile: ValidatedManagedStartupProfileTransport;
  /** Digest of the canonical, bounded, credential-screened profile transport. */
  readonly startupProfileSha256: string;
  /** Exact normalized PEM bytes, encoded separately from the profile. */
  readonly corporateCaB64?: string;
}

export class ManagedStartupProfileBuilderError extends Error {
  constructor(message: string) {
    super(`Cannot build managed startup profile: ${message}`);
    this.name = "ManagedStartupProfileBuilderError";
  }
}

function fail(message: string): never {
  throw new ManagedStartupProfileBuilderError(message);
}

function presentEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | null {
  const value = environment[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function parsePositiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number | null,
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): number | null {
  const raw = presentEnvironmentValue(environment, name);
  if (raw === null) return fallback;
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    fail(`${name} must be a positive integer`);
  }
  const parsed = Number(raw);
  const minimum = options.minimum ?? 1;
  const maximum = options.maximum ?? MAX_PROFILE_TUNING_INTEGER;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} must be between ${String(minimum)} and ${String(maximum)}`);
  }
  return parsed;
}

function parsePort(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const port = parsePositiveInteger(environment, name, fallback, { maximum: 65_535 });
  if (port === null) fail(`${name} must resolve to a TCP port`);
  return port;
}

function parseZeroOneFlag(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = presentEnvironmentValue(environment, name);
  if (raw === null) return fallback;
  if (raw === "1") return true;
  if (raw === "0") return false;
  fail(`${name} must be "0" or "1"`);
}

function parseHumanBoolean(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = presentEnvironmentValue(environment, name);
  if (raw === null) return fallback;
  const normalized = raw.toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  fail(`${name} must be a boolean value`);
}

function parseOpenClawOtelEnabled(environment: NodeJS.ProcessEnv): boolean {
  const raw = presentEnvironmentValue(environment, "NEMOCLAW_OPENCLAW_OTEL");
  return raw !== null && !FALSE_VALUES.has(raw.toLowerCase());
}

function parseReasoning(environment: NodeJS.ProcessEnv): boolean | null {
  const raw = presentEnvironmentValue(environment, "NEMOCLAW_REASONING");
  if (raw === null) return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  fail('NEMOCLAW_REASONING must be "true" or "false"');
}

function parseReasoningEffort(environment: NodeJS.ProcessEnv): ManagedStartupReasoningEffort {
  const raw = presentEnvironmentValue(environment, "NEMOCLAW_REASONING_EFFORT");
  const normalized = raw === null ? "default" : raw.toLowerCase();
  if ((MANAGED_STARTUP_REASONING_EFFORTS as readonly string[]).includes(normalized)) {
    return normalized as ManagedStartupReasoningEffort;
  }
  fail(`NEMOCLAW_REASONING_EFFORT must be one of: ${MANAGED_STARTUP_REASONING_EFFORTS.join(", ")}`);
}

function parseInputModalities(
  environment: NodeJS.ProcessEnv,
): readonly ManagedStartupInputModality[] {
  const raw = presentEnvironmentValue(environment, "NEMOCLAW_INFERENCE_INPUTS");
  if (raw === null) return ["text"];
  const values = raw.split(",").map((value) => value.trim());
  if (
    values.length === 0 ||
    values.some((value) => value !== "text" && value !== "image") ||
    new Set(values).size !== values.length
  ) {
    fail("NEMOCLAW_INFERENCE_INPUTS must be a unique comma-separated list of text and image");
  }
  return values as ManagedStartupInputModality[];
}

function parseHeartbeat(environment: NodeJS.ProcessEnv): string | null {
  const raw = presentEnvironmentValue(environment, "NEMOCLAW_AGENT_HEARTBEAT_EVERY");
  if (raw === null) return null;
  if (!/^\d+(?:s|m|h)$/u.test(raw)) {
    fail("NEMOCLAW_AGENT_HEARTBEAT_EVERY must be a duration ending in s, m, or h");
  }
  return raw;
}

function parseStrictBase64Json(raw: string, name: string): unknown {
  if (!STANDARD_BASE64_RE.test(raw)) fail(`${name} must be canonical base64`);
  const bytes = Buffer.from(raw, "base64");
  if (bytes.toString("base64") !== raw) fail(`${name} must be canonical base64`);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    fail(`${name} must contain valid UTF-8 JSON`);
  }
}

function parseRawJson(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    fail(`${name} must contain valid JSON`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeExtraAgentList(value: unknown, field: string): ManagedStartupJsonObject[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${field} must be an object list`);
  }
  const normalized: ManagedStartupJsonObject[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !isPlainObject(descriptor.value)) {
      fail(`${field}[${String(index)}] must be an object`);
    }
    if (
      Object.hasOwn(descriptor.value, "__proto__") ||
      Object.hasOwn(descriptor.value, "prototype") ||
      Object.hasOwn(descriptor.value, "constructor")
    ) {
      fail(`${field}[${String(index)}] contains an unsafe prototype field`);
    }
    normalized.push(descriptor.value as ManagedStartupJsonObject);
  }
  return normalized;
}

function normalizeExtraAgentsCandidate(value: unknown): ManagedStartupExtraAgents {
  const emptyDefaults = { subagents: {} };
  if (value === null || value === undefined) {
    return { agents: [], defaults: emptyDefaults, main: {} };
  }
  if (Array.isArray(value)) {
    return {
      agents: normalizeExtraAgentList(value, "NEMOCLAW_EXTRA_AGENTS_JSON"),
      defaults: emptyDefaults,
      main: {},
    };
  }
  if (!isPlainObject(value)) {
    fail(
      "NEMOCLAW_EXTRA_AGENTS_JSON must be an array or an object with agents, defaults, and main",
    );
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => key !== "agents" && key !== "defaults" && key !== "main",
  );
  if (unknownKeys.length > 0) {
    fail("NEMOCLAW_EXTRA_AGENTS_JSON contains unsupported top-level fields");
  }
  const agents = value.agents ?? [];
  const defaults = value.defaults ?? emptyDefaults;
  const main = value.main ?? {};
  const normalizedAgents = normalizeExtraAgentList(agents, "NEMOCLAW_EXTRA_AGENTS_JSON.agents");
  if (!isPlainObject(defaults) || !isPlainObject(main)) {
    fail("NEMOCLAW_EXTRA_AGENTS_JSON defaults and main must be objects");
  }
  return {
    agents: normalizedAgents,
    defaults: defaults as ManagedStartupJsonObject,
    main: main as ManagedStartupJsonObject,
  };
}

function parseExtraAgents(environment: NodeJS.ProcessEnv): ManagedStartupExtraAgents {
  const raw = presentEnvironmentValue(environment, "NEMOCLAW_EXTRA_AGENTS_JSON");
  const encoded = presentEnvironmentValue(environment, "NEMOCLAW_EXTRA_AGENTS_JSON_B64");
  if (raw !== null && encoded !== null) {
    fail("NEMOCLAW_EXTRA_AGENTS_JSON and NEMOCLAW_EXTRA_AGENTS_JSON_B64 must not both be set");
  }
  return normalizeExtraAgentsCandidate(
    raw !== null
      ? parseRawJson(raw, "NEMOCLAW_EXTRA_AGENTS_JSON")
      : encoded !== null
        ? parseStrictBase64Json(encoded, "NEMOCLAW_EXTRA_AGENTS_JSON_B64")
        : null,
  );
}

function normalizeWebSearch(
  agent: ManagedStartupAgent,
  config: ManagedStartupProfileBuilderInput["webSearch"],
): ManagedStartupWebSearch | null {
  if (agent === "langchain-deepagents-code") {
    if (config !== null) {
      fail("langchain-deepagents-code does not support web-search profile intent");
    }
    return null;
  }
  if (config !== null) {
    if (!isPlainObject(config)) fail("webSearch must be null or a configuration object");
    const unknownKeys = Object.keys(config).filter(
      (key) => key !== "fetchEnabled" && key !== "provider",
    );
    if (unknownKeys.length > 0 || typeof config.fetchEnabled !== "boolean") {
      fail("webSearch contains unsupported or malformed fields");
    }
    if (
      config.provider !== undefined &&
      config.provider !== "brave" &&
      config.provider !== "tavily"
    ) {
      fail("webSearch.provider must be brave or tavily");
    }
  }
  const provider =
    agent === "hermes" && config?.provider === undefined ? "tavily" : (config?.provider ?? "brave");
  if (agent === "hermes" && provider !== "tavily") {
    fail("Hermes supports only the Tavily web-search provider");
  }
  return { enabled: config?.fetchEnabled === true, provider };
}

function normalizeMessagingPlan(
  agent: ManagedStartupAgent,
  value: unknown | null,
): ManagedStartupJsonObject | null {
  if (agent === "langchain-deepagents-code") {
    if (value !== null) {
      fail("langchain-deepagents-code messagingPlan must be null");
    }
    return null;
  }
  if (value === null) return null;
  const plan = parseSandboxMessagingPlan(value, { agent });
  if (!plan) fail(`messagingPlan must be a valid ${agent} SandboxMessagingPlan`);
  const hydrated = hydrateDerivedSandboxMessagingPlanFields(plan);
  const reparsed = parseSandboxMessagingPlan(hydrated, { agent });
  if (!reparsed) fail(`messagingPlan hydration produced an invalid ${agent} plan`);
  const projected = JSON.parse(JSON.stringify(reparsed)) as ManagedStartupJsonObject;
  const buildSteps = projected.buildSteps;
  if (Array.isArray(buildSteps)) {
    for (const step of buildSteps) {
      if (
        !isPlainObject(step) ||
        step.kind !== "package-install" ||
        !isPlainObject(step.value) ||
        typeof step.value.pin !== "boolean"
      ) {
        continue;
      }
      // Package pins govern image construction. A managed image already owns
      // the exact installed package, so this derived build-only flag does not
      // belong in the managed startup profile consumed at runtime. Validate
      // and hydrate the full plan before this projection so malformed or
      // misplaced pins still fail closed (#9399).
      delete step.value.pin;
    }
  }
  return projected;
}

function resolveAliasedEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  upper: string,
  lower: string,
): string | null {
  const upperValue = presentEnvironmentValue(environment, upper);
  const lowerValue = presentEnvironmentValue(environment, lower);
  if (upperValue !== null && lowerValue !== null && upperValue !== lowerValue) {
    fail(`${upper} and ${lower} must not express conflicting values`);
  }
  return upperValue ?? lowerValue;
}

function normalizeNoProxyList(raw: string | null): string[] {
  if (raw === null) return [];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function resolveHostProxy(
  _agent: ManagedStartupAgent,
  environment: NodeJS.ProcessEnv,
): Pick<ManagedStartupProfile["proxy"], "hostHttpUrl" | "hostHttpsUrl" | "hostNoProxy"> {
  const hostHttpUrl = resolveAliasedEnvironmentValue(
    environment,
    MANAGED_STARTUP_HOST_PROXY_URL_INPUTS_BY_PROTOCOL.http.upper,
    MANAGED_STARTUP_HOST_PROXY_URL_INPUTS_BY_PROTOCOL.http.lower,
  );
  const hostHttpsUrl = resolveAliasedEnvironmentValue(
    environment,
    MANAGED_STARTUP_HOST_PROXY_URL_INPUTS_BY_PROTOCOL.https.upper,
    MANAGED_STARTUP_HOST_PROXY_URL_INPUTS_BY_PROTOCOL.https.lower,
  );
  const noProxy = resolveAliasedEnvironmentValue(environment, "NO_PROXY", "no_proxy");
  if (hostHttpUrl === null && hostHttpsUrl === null) {
    if (noProxy !== null) {
      fail("NO_PROXY/no_proxy requires an HTTP_PROXY or HTTPS_PROXY intent");
    }
    return { hostHttpUrl: null, hostHttpsUrl: null, hostNoProxy: [] };
  }

  const normalizedEnvironment: Record<string, string> = {};
  if (hostHttpUrl !== null) {
    normalizedEnvironment.HTTP_PROXY = hostHttpUrl;
    normalizedEnvironment.http_proxy = hostHttpUrl;
  }
  if (hostHttpsUrl !== null) {
    normalizedEnvironment.HTTPS_PROXY = hostHttpsUrl;
    normalizedEnvironment.https_proxy = hostHttpsUrl;
  }
  if (noProxy !== null) {
    normalizedEnvironment.NO_PROXY = noProxy;
    normalizedEnvironment.no_proxy = noProxy;
  }
  withLocalNoProxy(normalizedEnvironment);
  const upperNoProxy = normalizeNoProxyList(normalizedEnvironment.NO_PROXY ?? null);
  const lowerNoProxy = normalizeNoProxyList(normalizedEnvironment.no_proxy ?? null);
  return {
    hostHttpUrl,
    hostHttpsUrl,
    hostNoProxy: [...new Set([...upperNoProxy, ...lowerNoProxy])],
  };
}

function resolveCorporateCaMaterial(corporateCa: ResolvedCorporateCa | null | undefined): {
  readonly bundleSha256: string | null;
  readonly corporateCaB64?: string;
} {
  if (!corporateCa) return { bundleSha256: null };
  const bytes = Buffer.byteLength(corporateCa.pem, "utf8");
  if (bytes === 0 || bytes > MAX_CORPORATE_CA_BYTES) {
    fail(`corporate CA material must be between 1 and ${String(MAX_CORPORATE_CA_BYTES)} bytes`);
  }
  const blocks = corporateCa.pem.match(PEM_CERTIFICATE_RE_GLOBAL);
  if (!blocks || blocks.length === 0 || blocks.length > MAX_CORPORATE_CA_CERTS) {
    fail(
      `corporate CA material must contain between 1 and ${String(MAX_CORPORATE_CA_CERTS)} certificates`,
    );
  }
  for (const block of blocks) {
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(block);
    } catch {
      fail("corporate CA material contains an invalid X.509 certificate");
    }
    if (!certificate.ca) {
      fail("corporate CA material contains a certificate without CA basic constraints");
    }
  }
  const normalizedPem = normalizeCertificateBlocks(blocks);
  if (corporateCa.pem.trim() !== normalizedPem.trim()) {
    fail("corporate CA material must contain only normalized PEM certificate blocks");
  }
  return {
    bundleSha256: createHash("sha256").update(normalizedPem, "utf8").digest("hex"),
    corporateCaB64: Buffer.from(normalizedPem, "utf8").toString("base64"),
  };
}

function assertAgentSpecificInput(input: ManagedStartupProfileBuilderInput): void {
  if (input.dashboard.agent !== input.agent) {
    fail("dashboard.agent must match agent");
  }
  if (input.agent === "openclaw") {
    if (
      input.inference.upstreamEndpointUrl !== null ||
      input.hermesToolGateways.length > 0 ||
      input.dcodeAutoApprovalMode !== null ||
      input.observabilityEnabled !== null
    ) {
      fail("OpenClaw input contains state owned by another agent");
    }
    return;
  }
  if (input.agent === "hermes") {
    if (input.inference.compatibility !== null) {
      fail("Hermes does not support inference compatibility");
    }
    if (
      input.inference.upstreamEndpointUrl !== null ||
      input.dcodeAutoApprovalMode !== null ||
      input.observabilityEnabled !== null
    ) {
      fail("Hermes input contains state owned by another agent");
    }
    return;
  }
  if (input.agent === "pi") {
    if (
      input.webSearch !== null ||
      input.hermesToolGateways.length > 0 ||
      input.messagingPlan !== null ||
      input.inference.compatibility !== null ||
      input.inference.upstreamEndpointUrl !== null ||
      input.dcodeAutoApprovalMode !== null ||
      input.observabilityEnabled !== null
    ) {
      fail("Pi input contains state owned by another agent");
    }
    return;
  }
  if (input.webSearch !== null) {
    fail("langchain-deepagents-code does not support web-search profile intent");
  }
  if (input.hermesToolGateways.length > 0) {
    fail("langchain-deepagents-code does not support Hermes tool gateways");
  }
  if (input.messagingPlan !== null) {
    fail("langchain-deepagents-code messagingPlan must be null");
  }
  if (input.inference.compatibility !== null) {
    fail("langchain-deepagents-code does not support inference compatibility");
  }
  if (
    input.dcodeAutoApprovalMode !== "disabled" &&
    input.dcodeAutoApprovalMode !== "thread-opt-in"
  ) {
    fail("DCode approval state must be explicit");
  }
  if (typeof input.observabilityEnabled !== "boolean") {
    fail("DCode observability state must be explicit");
  }
}

function assertNoWrongAgentEnvironment(
  agent: ManagedStartupAgent,
  environment: NodeJS.ProcessEnv,
): void {
  const supported = new Set(
    MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY[agent].map((entry) => entry.input),
  );
  for (const name of INVENTORY_INPUTS) {
    if (presentEnvironmentValue(environment, name) === null || supported.has(name)) continue;
    // NEMOCLAW_DASHBOARD_PORT is a host-side input used to resolve the explicit
    // Hermes dashboard state even though the sandbox consumes its Hermes alias.
    if (agent === "hermes" && name === "NEMOCLAW_DASHBOARD_PORT") continue;
    fail(`${name} is not supported by ${agent}`);
  }
  const rawExtraAgents = presentEnvironmentValue(environment, "NEMOCLAW_EXTRA_AGENTS_JSON");
  if (agent !== "openclaw" && rawExtraAgents !== null) {
    fail(`NEMOCLAW_EXTRA_AGENTS_JSON is not supported by ${agent}`);
  }
}

function inventoryDigest(agent: ManagedStartupAgent): string {
  return createHash("sha256")
    .update(JSON.stringify(MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY[agent]))
    .digest("hex");
}

/** Fail closed if the authoritative affordance inventory changes without this builder. */
export function assertManagedStartupProfileBuilderInventoryCoverage(): void {
  for (const agent of Object.keys(EXPECTED_AFFORDANCE_INVENTORY_SHA256) as ManagedStartupAgent[]) {
    if (inventoryDigest(agent) !== EXPECTED_AFFORDANCE_INVENTORY_SHA256[agent]) {
      fail(`${agent} affordance inventory changed without a builder mapping update`);
    }
  }
}

function profilePathExists(profile: ManagedStartupProfile, profilePath: string): boolean {
  let value: unknown = profile;
  for (const segment of profilePath.split(".")) {
    if (!isPlainObject(value) || !Object.hasOwn(value, segment)) return false;
    value = value[segment];
  }
  return true;
}

function assertInventoryPathsResolved(profile: ManagedStartupProfile): void {
  for (const affordance of MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY[profile.agent]) {
    if (!profilePathExists(profile, affordance.profilePath)) {
      fail(`${affordance.input} has no resolved value at ${affordance.profilePath}`);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertEquivalent(name: string, actual: unknown, expected: unknown): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${name} conflicts with the resolved semantic onboarding state`);
  }
}

function parseEnvironmentJson(environment: NodeJS.ProcessEnv, name: string): unknown | undefined {
  const raw = presentEnvironmentValue(environment, name);
  return raw === null ? undefined : parseStrictBase64Json(raw, name);
}

/**
 * Environment may carry legacy Docker inputs while callers migrate. Parse and
 * compare each supplied value instead of silently preferring one source.
 */
function assertEnvironmentConsistency(
  profile: ManagedStartupProfile,
  environment: NodeJS.ProcessEnv,
): void {
  const stringValues: Readonly<Record<string, string | null>> = {
    NEMOCLAW_MODEL: profile.inference.model,
    NEMOCLAW_INFERENCE_PROVIDER_ID: profile.inference.routeProvider,
    NEMOCLAW_UPSTREAM_PROVIDER: profile.inference.upstreamProvider,
    NEMOCLAW_PRIMARY_MODEL_REF: profile.inference.primaryModelRef,
    NEMOCLAW_INFERENCE_BASE_URL: profile.inference.routedBaseUrl,
    NEMOCLAW_INFERENCE_API: profile.inference.api,
    NEMOCLAW_TOOL_DISCLOSURE: profile.tools.disclosure,
    CHAT_UI_URL:
      profile.dashboard.agent === "openclaw"
        ? profile.dashboard.url
        : profile.dashboard.agent === "hermes"
          ? (profile.dashboard.browserUrl ?? profile.dashboard.url)
          : null,
  };
  for (const [name, expected] of Object.entries(stringValues)) {
    const raw = presentEnvironmentValue(environment, name);
    if (raw !== null) assertEquivalent(name, raw, expected);
  }

  const numericValues: Readonly<Record<string, number | null>> = {
    NEMOCLAW_CONTEXT_WINDOW: profile.tuning.contextWindow,
    NEMOCLAW_MAX_TOKENS: profile.tuning.maxTokens,
    NEMOCLAW_PROXY_PORT: profile.proxy.managedPort,
    NEMOCLAW_AGENT_TIMEOUT:
      profile.agentConfig.agent === "openclaw" ? profile.agentConfig.agentTimeoutSeconds : null,
    NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE:
      profile.agentConfig.agent === "openclaw" ? profile.agentConfig.otel.sampleRate : null,
  };
  for (const [name, expected] of Object.entries(numericValues)) {
    const raw = presentEnvironmentValue(environment, name);
    if (raw !== null) assertEquivalent(name, Number(raw), expected);
  }

  const managedHost = presentEnvironmentValue(environment, "NEMOCLAW_PROXY_HOST");
  if (managedHost !== null)
    assertEquivalent("NEMOCLAW_PROXY_HOST", managedHost, profile.proxy.managedHost);

  const upstreamEndpoint = presentEnvironmentValue(environment, "NEMOCLAW_UPSTREAM_ENDPOINT_URL");
  if (upstreamEndpoint !== null) {
    assertEquivalent(
      "NEMOCLAW_UPSTREAM_ENDPOINT_URL",
      upstreamEndpoint,
      profile.inference.upstreamEndpointUrl,
    );
  }

  if (profile.agentConfig.agent === "openclaw") {
    const config = profile.agentConfig;
    const dashboard = profile.dashboard;
    if (dashboard.agent !== "openclaw") fail("OpenClaw dashboard state is inconsistent");
    const directValues: Readonly<Record<string, unknown>> = {
      NEMOCLAW_REASONING: String(profile.tuning.reasoning),
      NEMOCLAW_AGENT_HEARTBEAT_EVERY: config.heartbeatEvery,
      NEMOCLAW_DISABLE_DEVICE_AUTH: config.deviceAuth.disabled ? "1" : "0",
      NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE: config.deviceAuth.optOutSource,
      NEMOCLAW_WEB_SEARCH_ENABLED: config.webSearch.enabled ? "1" : "0",
      NEMOCLAW_WEB_SEARCH_PROVIDER: config.webSearch.provider,
      NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: config.otel.endpointUrl,
      NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: config.otel.serviceName,
      NEMOCLAW_DASHBOARD_BIND: dashboard.bindAddress === "0.0.0.0" ? "0.0.0.0" : null,
      NEMOCLAW_WSL_DASHBOARD_EXPOSURE: dashboard.wslExposure ? "1" : "0",
      NEMOCLAW_DASHBOARD_PORT: dashboard.port,
    };
    for (const [name, expected] of Object.entries(directValues)) {
      const raw = presentEnvironmentValue(environment, name);
      if (raw === null) continue;
      assertEquivalent(name, typeof expected === "number" ? Number(raw) : raw, expected);
    }
    const reasoningEffort = presentEnvironmentValue(environment, "NEMOCLAW_REASONING_EFFORT");
    if (reasoningEffort !== null) {
      assertEquivalent(
        "NEMOCLAW_REASONING_EFFORT",
        reasoningEffort.toLowerCase(),
        profile.tuning.reasoningEffort,
      );
    }
    if (presentEnvironmentValue(environment, "NEMOCLAW_OPENCLAW_OTEL") !== null) {
      assertEquivalent(
        "NEMOCLAW_OPENCLAW_OTEL",
        parseOpenClawOtelEnabled(environment),
        config.otel.enabled,
      );
    }
    if (presentEnvironmentValue(environment, "NEMOCLAW_MINIMAL_BOOTSTRAP") !== null) {
      assertEquivalent(
        "NEMOCLAW_MINIMAL_BOOTSTRAP",
        parseZeroOneFlag(environment, "NEMOCLAW_MINIMAL_BOOTSTRAP", false),
        config.minimalBootstrap,
      );
    }
    if (presentEnvironmentValue(environment, "NEMOCLAW_INFERENCE_INPUTS") !== null) {
      assertEquivalent(
        "NEMOCLAW_INFERENCE_INPUTS",
        [...parseInputModalities(environment)].sort(),
        profile.inference.inputModalities,
      );
    }
    const compatibility = parseEnvironmentJson(environment, "NEMOCLAW_INFERENCE_COMPAT_B64");
    if (compatibility !== undefined) {
      assertEquivalent(
        "NEMOCLAW_INFERENCE_COMPAT_B64",
        compatibility,
        profile.inference.compatibility,
      );
    }
    const extraAgents = parseEnvironmentJson(environment, "NEMOCLAW_EXTRA_AGENTS_JSON_B64");
    if (extraAgents !== undefined) {
      assertEquivalent(
        "NEMOCLAW_EXTRA_AGENTS_JSON_B64",
        normalizeExtraAgentsCandidate(extraAgents),
        config.extraAgents,
      );
    }
  } else if (profile.agentConfig.agent === "hermes") {
    const config = profile.agentConfig;
    const dashboard = profile.dashboard;
    if (dashboard.agent !== "hermes") fail("Hermes dashboard state is inconsistent");
    const directValues: Readonly<Record<string, unknown>> = {
      NEMOCLAW_WEB_SEARCH_ENABLED: config.webSearch.enabled ? "1" : "0",
      NEMOCLAW_WEB_SEARCH_PROVIDER: config.webSearch.provider,
      NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: profile.tools.enabledGateways.length > 0 ? "1" : "0",
      NEMOCLAW_HERMES_DASHBOARD_PORT: dashboard.publicPort,
      NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT: dashboard.internalPort,
    };
    for (const [name, expected] of Object.entries(directValues)) {
      const raw = presentEnvironmentValue(environment, name);
      if (raw === null) continue;
      assertEquivalent(name, typeof expected === "number" ? Number(raw) : raw, expected);
    }
    for (const [name, expected] of [
      ["NEMOCLAW_HERMES_DASHBOARD", dashboard.mode === "loopback-forwarded"],
      ["NEMOCLAW_HERMES_DASHBOARD_TUI", dashboard.tuiEnabled],
    ] as const) {
      if (presentEnvironmentValue(environment, name) !== null) {
        assertEquivalent(name, parseHumanBoolean(environment, name, false), expected);
      }
    }
    const hostDashboardPort = presentEnvironmentValue(environment, "NEMOCLAW_DASHBOARD_PORT");
    if (hostDashboardPort !== null) {
      assertEquivalent("NEMOCLAW_DASHBOARD_PORT", Number(hostDashboardPort), dashboard.publicPort);
    }
    const presets = parseEnvironmentJson(environment, "NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64");
    if (presets !== undefined) {
      if (!Array.isArray(presets)) {
        fail("NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64 must encode an array");
      }
      assertEquivalent(
        "NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64",
        [...presets].sort(),
        profile.tools.enabledGateways,
      );
    }
  } else if (profile.agentConfig.agent === "langchain-deepagents-code") {
    const config = profile.agentConfig;
    const approval = presentEnvironmentValue(environment, "NEMOCLAW_DCODE_AUTO_APPROVAL");
    if (approval !== null) {
      assertEquivalent("NEMOCLAW_DCODE_AUTO_APPROVAL", approval, config.autoApprovalMode);
    }
    const observability = presentEnvironmentValue(environment, "NEMOCLAW_OBSERVABILITY");
    if (observability !== null) {
      assertEquivalent(
        "NEMOCLAW_OBSERVABILITY",
        parseZeroOneFlag(environment, "NEMOCLAW_OBSERVABILITY", false),
        config.observabilityEnabled,
      );
    }
    const dcodeReasoningEffort = presentEnvironmentValue(environment, "NEMOCLAW_REASONING_EFFORT");
    if (dcodeReasoningEffort !== null) {
      assertEquivalent(
        "NEMOCLAW_REASONING_EFFORT",
        dcodeReasoningEffort.toLowerCase(),
        profile.tuning.reasoningEffort,
      );
    }
  }

  const messaging = parseEnvironmentJson(environment, "NEMOCLAW_MESSAGING_PLAN_B64");
  if (messaging !== undefined) {
    assertEquivalent(
      "NEMOCLAW_MESSAGING_PLAN_B64",
      normalizeMessagingPlan(profile.agent, messaging),
      profile.messaging.plan,
    );
  }
  if (presentEnvironmentValue(environment, "NEMOCLAW_CORPORATE_CA_B64") !== null) {
    fail("NEMOCLAW_CORPORATE_CA_B64 must use the separate corporateCa input");
  }
}

function buildCandidate(input: ManagedStartupProfileBuilderInput): {
  readonly profile: ManagedStartupProfile;
  readonly corporateCaB64?: string;
} {
  assertManagedStartupProfileBuilderInventoryCoverage();
  assertAgentSpecificInput(input);
  assertNoWrongAgentEnvironment(input.agent, input.environment);

  const inference = input.inference;
  const hostProxy = resolveHostProxy(input.agent, input.environment);
  const managedHost =
    presentEnvironmentValue(input.environment, "NEMOCLAW_PROXY_HOST") ?? DEFAULT_MANAGED_PROXY_HOST;
  const managedPort = parsePort(
    input.environment,
    "NEMOCLAW_PROXY_PORT",
    DEFAULT_MANAGED_PROXY_PORT,
  );
  const messagingPlan = normalizeMessagingPlan(input.agent, input.messagingPlan);
  const corporateCa = resolveCorporateCaMaterial(input.corporateCa);
  const webSearch = normalizeWebSearch(input.agent, input.webSearch);

  let agentConfig: ManagedStartupProfile["agentConfig"];
  let tuning: ManagedStartupProfile["tuning"];
  if (input.agent === "openclaw") {
    if (!webSearch) fail("OpenClaw web-search state is missing");
    const otelSampleRaw =
      presentEnvironmentValue(input.environment, "NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE") ?? "1.0";
    const otelSampleRate = Number(otelSampleRaw);
    if (!Number.isFinite(otelSampleRate) || otelSampleRate < 0 || otelSampleRate > 1) {
      fail("NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE must be between 0 and 1");
    }
    const otelEndpoint =
      presentEnvironmentValue(input.environment, "NEMOCLAW_OPENCLAW_OTEL_ENDPOINT") ??
      DEFAULT_OPENCLAW_OTEL_ENDPOINT;
    const otelServiceName =
      presentEnvironmentValue(input.environment, "NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME") ??
      DEFAULT_OPENCLAW_OTEL_SERVICE_NAME;
    agentConfig = {
      agent: "openclaw",
      webSearch,
      otel: {
        enabled: parseOpenClawOtelEnabled(input.environment),
        endpointUrl: otelEndpoint,
        serviceName: otelServiceName,
        sampleRate: otelSampleRate,
      },
      agentTimeoutSeconds:
        parsePositiveInteger(
          input.environment,
          "NEMOCLAW_AGENT_TIMEOUT",
          DEFAULT_OPENCLAW_AGENT_TIMEOUT_SECONDS,
        ) ?? DEFAULT_OPENCLAW_AGENT_TIMEOUT_SECONDS,
      heartbeatEvery: parseHeartbeat(input.environment),
      extraAgents: parseExtraAgents(input.environment),
      // Managed onboarding currently applies this compatibility opt-out to
      // every stock OpenClaw image, independently of dashboard exposure.
      deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
      minimalBootstrap: parseZeroOneFlag(input.environment, "NEMOCLAW_MINIMAL_BOOTSTRAP", false),
    };
    tuning = {
      contextWindow:
        parsePositiveInteger(input.environment, "NEMOCLAW_CONTEXT_WINDOW", DEFAULT_CONTEXT_WINDOW, {
          maximum: MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
        }) ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens:
        parsePositiveInteger(
          input.environment,
          "NEMOCLAW_MAX_TOKENS",
          DEFAULT_OPENCLAW_MAX_TOKENS,
        ) ?? DEFAULT_OPENCLAW_MAX_TOKENS,
      reasoning: parseReasoning(input.environment) ?? false,
      reasoningEffort: parseReasoningEffort(input.environment),
    };
  } else if (input.agent === "hermes") {
    if (!webSearch) fail("Hermes web-search state is missing");
    agentConfig = { agent: "hermes", webSearch };
    tuning = {
      contextWindow: parsePositiveInteger(input.environment, "NEMOCLAW_CONTEXT_WINDOW", null, {
        minimum: MIN_HERMES_CONTEXT_WINDOW,
        maximum: MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
      }),
      maxTokens: null,
      reasoning: null,
      reasoningEffort: null,
    };
  } else if (input.agent === "pi") {
    agentConfig = { agent: "pi" };
    tuning = {
      contextWindow: parsePositiveInteger(input.environment, "NEMOCLAW_CONTEXT_WINDOW", null, {
        maximum: MAX_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
      }),
      maxTokens: parsePositiveInteger(input.environment, "NEMOCLAW_MAX_TOKENS", null),
      reasoning: parseReasoning(input.environment),
      reasoningEffort: null,
    };
  } else {
    if (input.dcodeAutoApprovalMode === null || input.observabilityEnabled === null) {
      fail("DCode approval and observability state must be explicit");
    }
    agentConfig = {
      agent: "langchain-deepagents-code",
      autoApprovalMode: input.dcodeAutoApprovalMode,
      observabilityEnabled: input.observabilityEnabled,
    };
    tuning = {
      contextWindow: null,
      maxTokens: null,
      reasoning: null,
      reasoningEffort: parseReasoningEffort(input.environment),
    };
  }

  const candidate: ManagedStartupProfile = {
    schemaVersion: MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
    agent: input.agent,
    agentConfig,
    inference: {
      routeProvider: inference.routeProvider,
      upstreamProvider: inference.upstreamProvider,
      model: inference.model,
      routedBaseUrl: inference.routedBaseUrl,
      upstreamEndpointUrl: inference.upstreamEndpointUrl,
      api: inference.api,
      primaryModelRef: inference.primaryModelRef,
      // Docker's legacy JSON encoder maps a null compatibility result to {},
      // and the OpenClaw generator consumes an object in all cases.
      compatibility:
        input.agent === "openclaw"
          ? (JSON.parse(JSON.stringify(inference.compatibility ?? {})) as ManagedStartupJsonObject)
          : null,
      inputModalities: input.agent === "openclaw" ? parseInputModalities(input.environment) : null,
    },
    proxy: {
      managedHost,
      managedPort,
      ...hostProxy,
    },
    dashboard: input.dashboard,
    tools: {
      disclosure: input.toolDisclosure,
      enabledGateways:
        input.agent === "hermes"
          ? (input.hermesToolGateways as readonly ManagedStartupHermesToolGateway[])
          : [],
    },
    messaging: { plan: messagingPlan },
    tuning,
    corporateCa: { bundleSha256: corporateCa.bundleSha256 },
  };

  const profile = validateManagedStartupProfile(candidate);
  assertInventoryPathsResolved(profile);
  assertEnvironmentConsistency(profile, input.environment);
  return corporateCa.corporateCaB64 === undefined
    ? { profile }
    : { profile, corporateCaB64: corporateCa.corporateCaB64 };
}

/** Build a driver-neutral startup profile for later runtime-provider consumption. */
export function buildManagedStartupProfile(
  input: ManagedStartupProfileBuilderInput,
): BuiltManagedStartupProfile {
  try {
    const built = buildCandidate(input);
    // buildCandidate performs the initial messaging parse, hydration, second
    // parse, profile validation, and credential screening before this brand is
    // applied. Consumption remains a separate trust boundary.
    const encodedProfile = encodeManagedStartupProfile(
      built.profile,
    ) as ValidatedManagedStartupProfileTransport;
    const startupProfileSha256 = createHash("sha256").update(encodedProfile, "utf8").digest("hex");
    return Object.freeze(
      built.corporateCaB64 === undefined
        ? { profile: built.profile, encodedProfile, startupProfileSha256 }
        : {
            profile: built.profile,
            encodedProfile,
            startupProfileSha256,
            corporateCaB64: built.corporateCaB64,
          },
    );
  } catch (error) {
    if (error instanceof ManagedStartupProfileBuilderError) throw error;
    const message = error instanceof Error ? error.message : "unknown validation failure";
    throw new ManagedStartupProfileBuilderError(message);
  }
}
