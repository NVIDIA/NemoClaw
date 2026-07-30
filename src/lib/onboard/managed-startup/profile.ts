// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

/**
 * Versioned, secret-free configuration applied when a complete managed image
 * starts. This is the portable replacement for build-time Dockerfile ARG/env
 * mutation: Docker, Podman, and future OpenShell compute drivers consume the
 * same bounded profile.
 */
export const MANAGED_STARTUP_PROFILE_SCHEMA_VERSION = 1 as const;

/** Profiles are configuration, not a general-purpose transport. */
export const MANAGED_STARTUP_PROFILE_MAX_BYTES = 64 * 1024;

/** Maximum canonical base64url size for a profile at the decoded byte cap. */
export const MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES =
  Math.ceil(MANAGED_STARTUP_PROFILE_MAX_BYTES / 3) * 4;

const MAX_IDENTIFIER_BYTES = 256;
const MAX_MODEL_BYTES = 1024;
const MAX_URL_BYTES = 2048;
const MAX_LIST_ITEMS = 128;
const MAX_JSON_NODES = 4096;
const MAX_JSON_DEPTH = 32;
const MAX_TUNING_INTEGER = 1_000_000_000;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const RAW_CA_PEM_RE = /-----BEGIN (?:TRUSTED )?CERTIFICATE-----/iu;
const RAW_CA_DER_BASE64_RE = /^MII[A-Za-z0-9+/=\r\n]{253,}$/u;
const URL_CANDIDATE_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/gu;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CREDENTIAL_SHAPED_NAME_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|refresh[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?key|pass[_-]?code|personal[_-]?access[_-]?token|connection[_-]?string|webhook(?:[_-]?url)?|key|secret|token|password|passwd|passcode|auth|authorization|credential|credentials|bearer|bearer[_-]?token|cookie|cookies|pat|private|privatekey|pin|webhookurl|dsn|connectionstring)(?:$|[_-])/iu;
const CREDENTIAL_COMPOUND_NAME_PATTERN =
  /^(?:access|refresh|client|bearer|auth|api|private|signing|session|bot|app|resolved)(?:token|key|secret|password)$/iu;
const CREDENTIAL_ENV_NAME_PATTERN =
  /^(?:[A-Z0-9]+_)*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|PASSPHRASE|CREDENTIAL)S?$/u;
const CREDENTIAL_HEADER_NAME_PATTERN =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|.+-(?:key|token|secret|password|passphrase|credential|auth)s?)$/iu;
const PUBLIC_KEY_NAME_PATTERN = /(?:^|[-_])public[-_]?keys?$/iu;
const PASS_CREDENTIAL_NAME_PATTERN = /(?:^|[-_])pass(?:wd)?$/iu;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /nvapi-[A-Za-z0-9_-]{10,}/u,
  /nvcf-[A-Za-z0-9_-]{10,}/u,
  /ghp_[A-Za-z0-9_-]{10,}/u,
  /github_pat_[A-Za-z0-9_]{30,}/u,
  /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{10,}/u,
  /(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}/u,
  /A(?:K|S)IA[A-Z0-9]{16}/u,
  /hf_[A-Za-z0-9]{10,}/u,
  /glpat-[A-Za-z0-9_-]{10,}/u,
  /gsk_[A-Za-z0-9]{10,}/u,
  /pypi-[A-Za-z0-9_-]{10,}/u,
  /tvly-[A-Za-z0-9_-]{10,}/u,
  /lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*/u,
  /\bbot\d{8,10}:[A-Za-z0-9_-]{35}\b/u,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/u,
  /\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/u,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\bBearer\s+[A-Za-z0-9_.+/=-]{10,}/iu,
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/u,
];

export const MANAGED_STARTUP_INFERENCE_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;
export type ManagedStartupInferenceApi = (typeof MANAGED_STARTUP_INFERENCE_APIS)[number];
export type ManagedStartupToolDisclosure = "progressive" | "direct";
export const MANAGED_STARTUP_REASONING_EFFORTS = ["default", "low", "medium", "high"] as const;
export type ManagedStartupReasoningEffort = (typeof MANAGED_STARTUP_REASONING_EFFORTS)[number];
export const MANAGED_STARTUP_DCODE_AUTO_APPROVAL_MODES = ["disabled", "thread-opt-in"] as const;
export type ManagedStartupDcodeAutoApprovalMode =
  (typeof MANAGED_STARTUP_DCODE_AUTO_APPROVAL_MODES)[number];
export const MANAGED_STARTUP_HERMES_TOOL_GATEWAYS = [
  "nous-web",
  "nous-image",
  "nous-audio",
  "nous-browser",
  "nous-code",
] as const;
export type ManagedStartupHermesToolGateway = (typeof MANAGED_STARTUP_HERMES_TOOL_GATEWAYS)[number];
export type ManagedStartupInputModality = "text" | "image";
export type ManagedStartupWebSearchProvider = "brave" | "tavily";
export type ManagedStartupDeviceAuthOptOutSource = "operator" | "managed-onboard";

export const MANAGED_STARTUP_AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;

export type ManagedStartupAgent = (typeof MANAGED_STARTUP_AGENTS)[number];

export type ManagedStartupJsonScalar = string | number | boolean | null;
export type ManagedStartupJsonValue =
  | ManagedStartupJsonScalar
  | ManagedStartupJsonObject
  | readonly ManagedStartupJsonValue[];
export interface ManagedStartupJsonObject {
  readonly [key: string]: ManagedStartupJsonValue;
}

export interface ManagedStartupInference {
  /** Stable route name installed in the sandbox-facing inference config. */
  readonly routeProvider: string;
  /** User-selected provider upstream of the managed inference route. */
  readonly upstreamProvider: string;
  readonly model: string;
  /** Sandbox-facing managed inference route (normally inference.local). */
  readonly routedBaseUrl: string;
  /** Direct upstream metadata needed by DCode; never used as the sandbox route. */
  readonly upstreamEndpointUrl: string | null;
  readonly api: ManagedStartupInferenceApi;
  /** OpenClaw's provider/model reference. Other adapters require null. */
  readonly primaryModelRef: string | null;
  /** OpenClaw provider compatibility options. Other adapters require null. */
  readonly compatibility: ManagedStartupJsonObject | null;
  /** OpenClaw model inputs. Other adapters require null. */
  readonly inputModalities: readonly ManagedStartupInputModality[] | null;
}

export interface ManagedStartupProxy {
  /** Managed OpenShell policy-proxy route consumed by every adapter. */
  readonly managedHost: string;
  readonly managedPort: number;
  /**
   * Optional host-proxy intent is represented separately from the trusted
   * managed route. DCode retains this intent for OpenShell's create boundary,
   * while its long-running runtime still pins the root-owned managed route.
   */
  readonly hostHttpUrl: string | null;
  readonly hostHttpsUrl: string | null;
  readonly hostNoProxy: readonly string[];
}

export interface ManagedStartupOpenClawDashboard {
  readonly agent: "openclaw";
  readonly mode: "loopback" | "remote";
  readonly url: string;
  readonly port: number;
  readonly bindAddress: "127.0.0.1" | "0.0.0.0";
  readonly wslExposure: boolean;
}

export interface ManagedStartupHermesDashboardDisabled {
  readonly agent: "hermes";
  readonly mode: "disabled";
  /** CHAT_UI_URL remains a stock image input even when host forwarding is off. */
  readonly url: string;
  readonly publicPort: null;
  readonly internalPort: null;
  readonly tuiEnabled: false;
}

export interface ManagedStartupHermesDashboardForwarded {
  readonly agent: "hermes";
  readonly mode: "loopback-forwarded";
  readonly url: string;
  readonly publicPort: number;
  readonly internalPort: number;
  readonly tuiEnabled: boolean;
}

export type ManagedStartupHermesDashboard =
  | ManagedStartupHermesDashboardDisabled
  | ManagedStartupHermesDashboardForwarded;

export interface ManagedStartupDcodeDashboard {
  readonly agent: "langchain-deepagents-code";
  readonly mode: "disabled";
}

export type ManagedStartupDashboard =
  | ManagedStartupOpenClawDashboard
  | ManagedStartupHermesDashboard
  | ManagedStartupDcodeDashboard;

export interface ManagedStartupWebSearch {
  readonly enabled: boolean;
  /**
   * The selected provider is retained even when disabled because the stock
   * Dockerfiles currently materialize both build inputs independently.
   */
  readonly provider: ManagedStartupWebSearchProvider;
}

export interface ManagedStartupTools {
  readonly disclosure: ManagedStartupToolDisclosure;
  /** Reviewed Hermes gateway preset IDs; required empty for other adapters. */
  readonly enabledGateways: readonly ManagedStartupHermesToolGateway[];
}

export interface ManagedStartupMessaging {
  /**
   * A host-prevalidated, secretless SandboxMessagingPlan. The existing
   * messaging validator/applier owns its versioned nested schema; this portable
   * module owns JSON shape, size, and secret scanning only.
   */
  readonly plan: ManagedStartupJsonObject | null;
}

export interface ManagedStartupTuning {
  readonly contextWindow: number | null;
  readonly maxTokens: number | null;
  readonly reasoning: boolean | null;
  readonly reasoningEffort: ManagedStartupReasoningEffort | null;
}

/**
 * Only the digest crosses the startup-profile boundary. The host-side CA
 * applicator owns the actual certificate bytes and verifies this digest before
 * making them available to the sandbox.
 */
export interface ManagedStartupCorporateCa {
  readonly bundleSha256: string | null;
}

export interface ManagedStartupExtraAgents {
  /**
   * Canonical form of NEMOCLAW_EXTRA_AGENTS_JSON. The existing OpenClaw
   * validator owns the nested agent schema; this boundary preserves all
   * prevalidated values without accepting the legacy array/object ambiguity.
   */
  readonly agents: readonly ManagedStartupJsonObject[];
  readonly defaults: ManagedStartupJsonObject;
  readonly main: ManagedStartupJsonObject;
}

export interface ManagedStartupOpenClawOtel {
  readonly enabled: boolean;
  readonly endpointUrl: string;
  readonly serviceName: string;
  readonly sampleRate: number;
}

export interface ManagedStartupDeviceAuth {
  readonly disabled: boolean;
  readonly optOutSource: ManagedStartupDeviceAuthOptOutSource;
}

export interface ManagedStartupOpenClawConfig {
  readonly agent: "openclaw";
  readonly webSearch: ManagedStartupWebSearch;
  readonly otel: ManagedStartupOpenClawOtel;
  readonly agentTimeoutSeconds: number;
  readonly heartbeatEvery: string | null;
  readonly extraAgents: ManagedStartupExtraAgents;
  readonly deviceAuth: ManagedStartupDeviceAuth;
  readonly minimalBootstrap: boolean;
}

export interface ManagedStartupHermesConfig {
  readonly agent: "hermes";
  readonly webSearch: ManagedStartupWebSearch;
}

export interface ManagedStartupDcodeConfig {
  readonly agent: "langchain-deepagents-code";
  readonly autoApprovalMode: ManagedStartupDcodeAutoApprovalMode;
  readonly observabilityEnabled: boolean;
}

export type ManagedStartupAgentConfig =
  | ManagedStartupOpenClawConfig
  | ManagedStartupHermesConfig
  | ManagedStartupDcodeConfig;

export interface ManagedStartupProfile {
  readonly schemaVersion: typeof MANAGED_STARTUP_PROFILE_SCHEMA_VERSION;
  readonly agent: ManagedStartupAgent;
  readonly agentConfig: ManagedStartupAgentConfig;
  readonly inference: ManagedStartupInference;
  readonly proxy: ManagedStartupProxy;
  readonly dashboard: ManagedStartupDashboard;
  readonly tools: ManagedStartupTools;
  readonly messaging: ManagedStartupMessaging;
  readonly tuning: ManagedStartupTuning;
  readonly corporateCa: ManagedStartupCorporateCa;
}

export type ManagedStartupDashboardMode = "disabled" | "loopback" | "remote" | "loopback-forwarded";

export interface ManagedStartupAgentCapabilities {
  readonly inferenceApis: readonly ManagedStartupInferenceApi[];
  readonly dashboardModes: readonly ManagedStartupDashboardMode[];
  readonly inputModalities: readonly ManagedStartupInputModality[];
  readonly webSearchProviders: readonly ManagedStartupWebSearchProvider[];
  readonly toolGateways: readonly ManagedStartupHermesToolGateway[];
  readonly tuningFields: readonly (
    | "contextWindow"
    | "maxTokens"
    | "reasoning"
    | "reasoningEffort"
  )[];
  readonly supportsMessaging: boolean;
  readonly supportsInferenceCompatibility: boolean;
  readonly supportsUpstreamEndpoint: boolean;
  readonly supportsHostProxyIntent: boolean;
  readonly supportsPrimaryModelRef: boolean;
  readonly supportsAgentTimeout: boolean;
  readonly supportsHeartbeat: boolean;
  readonly supportsExtraAgents: boolean;
  readonly supportsDeviceAuth: boolean;
  readonly observability: "openclaw-otel" | "dcode-marker" | "none";
  readonly supportsMinimalBootstrap: boolean;
}

/**
 * Host-side negotiation must use this table before dispatch. A runtime that
 * does not advertise the requested semantic capability is rejected instead of
 * silently dropping a field.
 */
export const MANAGED_STARTUP_PROFILE_CAPABILITIES = {
  openclaw: {
    inferenceApis: MANAGED_STARTUP_INFERENCE_APIS,
    dashboardModes: ["loopback", "remote"],
    inputModalities: ["text", "image"],
    webSearchProviders: ["brave", "tavily"],
    toolGateways: [],
    tuningFields: ["contextWindow", "maxTokens", "reasoning", "reasoningEffort"],
    supportsMessaging: true,
    supportsInferenceCompatibility: true,
    supportsUpstreamEndpoint: false,
    supportsHostProxyIntent: true,
    supportsPrimaryModelRef: true,
    supportsAgentTimeout: true,
    supportsHeartbeat: true,
    supportsExtraAgents: true,
    supportsDeviceAuth: true,
    observability: "openclaw-otel",
    supportsMinimalBootstrap: true,
  },
  hermes: {
    inferenceApis: MANAGED_STARTUP_INFERENCE_APIS,
    dashboardModes: ["disabled", "loopback-forwarded"],
    inputModalities: [],
    webSearchProviders: ["tavily"],
    toolGateways: MANAGED_STARTUP_HERMES_TOOL_GATEWAYS,
    tuningFields: ["contextWindow"],
    supportsMessaging: true,
    supportsInferenceCompatibility: false,
    supportsUpstreamEndpoint: false,
    supportsHostProxyIntent: true,
    supportsPrimaryModelRef: false,
    supportsAgentTimeout: false,
    supportsHeartbeat: false,
    supportsExtraAgents: false,
    supportsDeviceAuth: false,
    observability: "none",
    supportsMinimalBootstrap: false,
  },
  "langchain-deepagents-code": {
    inferenceApis: ["openai-completions"],
    dashboardModes: ["disabled"],
    inputModalities: [],
    webSearchProviders: [],
    toolGateways: [],
    tuningFields: [],
    supportsMessaging: false,
    supportsInferenceCompatibility: false,
    supportsUpstreamEndpoint: true,
    supportsHostProxyIntent: true,
    supportsPrimaryModelRef: false,
    supportsAgentTimeout: false,
    supportsHeartbeat: false,
    supportsExtraAgents: false,
    supportsDeviceAuth: false,
    observability: "dcode-marker",
    supportsMinimalBootstrap: false,
  },
} as const satisfies Record<ManagedStartupAgent, ManagedStartupAgentCapabilities>;

export type ManagedStartupAffordanceSource = "docker-arg" | "runtime-env" | "host-material";
export type ManagedStartupAffordanceRepresentation = "value" | "derived" | "digest-handoff";

export interface ManagedStartupAffordance {
  readonly input: string;
  readonly profilePath: string;
  readonly source: ManagedStartupAffordanceSource;
  readonly representation: ManagedStartupAffordanceRepresentation;
}

function affordance(
  input: string,
  profilePath: string,
  source: ManagedStartupAffordanceSource = "docker-arg",
  representation: ManagedStartupAffordanceRepresentation = "value",
): ManagedStartupAffordance {
  return { input, profilePath, source, representation };
}

const HOST_PROXY_AFFORDANCES = [
  affordance("HTTP_PROXY", "proxy.hostHttpUrl", "runtime-env"),
  affordance("http_proxy", "proxy.hostHttpUrl", "runtime-env", "derived"),
  affordance("HTTPS_PROXY", "proxy.hostHttpsUrl", "runtime-env"),
  affordance("https_proxy", "proxy.hostHttpsUrl", "runtime-env", "derived"),
  affordance("NO_PROXY", "proxy.hostNoProxy", "runtime-env"),
  affordance("no_proxy", "proxy.hostNoProxy", "runtime-env", "derived"),
] as const;

/**
 * Complete v1 mapping from the deployment-specific Docker/start inputs that
 * managed-image startup replaces to typed profile fields. This is deliberately
 * data rather than prose so Dockerfile drift tests can fail closed.
 */
export const MANAGED_STARTUP_PROFILE_AFFORDANCE_INVENTORY = {
  openclaw: [
    affordance("NEMOCLAW_MODEL", "inference.model"),
    affordance("NEMOCLAW_INFERENCE_PROVIDER_ID", "inference.routeProvider"),
    affordance("NEMOCLAW_UPSTREAM_PROVIDER", "inference.upstreamProvider"),
    affordance("NEMOCLAW_PRIMARY_MODEL_REF", "inference.primaryModelRef"),
    affordance("NEMOCLAW_INFERENCE_BASE_URL", "inference.routedBaseUrl"),
    affordance("NEMOCLAW_INFERENCE_API", "inference.api"),
    affordance("NEMOCLAW_INFERENCE_COMPAT_B64", "inference.compatibility"),
    affordance("NEMOCLAW_INFERENCE_INPUTS", "inference.inputModalities"),
    affordance("NEMOCLAW_CONTEXT_WINDOW", "tuning.contextWindow"),
    affordance("NEMOCLAW_MAX_TOKENS", "tuning.maxTokens"),
    affordance("NEMOCLAW_REASONING", "tuning.reasoning"),
    affordance("NEMOCLAW_REASONING_EFFORT", "tuning.reasoningEffort"),
    affordance("NEMOCLAW_TOOL_DISCLOSURE", "tools.disclosure"),
    affordance("NEMOCLAW_AGENT_TIMEOUT", "agentConfig.agentTimeoutSeconds"),
    affordance("NEMOCLAW_AGENT_HEARTBEAT_EVERY", "agentConfig.heartbeatEvery"),
    affordance("NEMOCLAW_EXTRA_AGENTS_JSON_B64", "agentConfig.extraAgents"),
    affordance("NEMOCLAW_DISABLE_DEVICE_AUTH", "agentConfig.deviceAuth.disabled"),
    affordance("NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE", "agentConfig.deviceAuth.optOutSource"),
    affordance("NEMOCLAW_WEB_SEARCH_ENABLED", "agentConfig.webSearch.enabled"),
    affordance("NEMOCLAW_WEB_SEARCH_PROVIDER", "agentConfig.webSearch.provider"),
    affordance("NEMOCLAW_OPENCLAW_OTEL", "agentConfig.otel.enabled"),
    affordance("NEMOCLAW_OPENCLAW_OTEL_ENDPOINT", "agentConfig.otel.endpointUrl"),
    affordance("NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME", "agentConfig.otel.serviceName"),
    affordance("NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE", "agentConfig.otel.sampleRate"),
    affordance("CHAT_UI_URL", "dashboard.url"),
    affordance("NEMOCLAW_DASHBOARD_BIND", "dashboard.bindAddress"),
    affordance("NEMOCLAW_WSL_DASHBOARD_EXPOSURE", "dashboard.wslExposure"),
    affordance("NEMOCLAW_DASHBOARD_PORT", "dashboard.port", "runtime-env"),
    affordance("NEMOCLAW_PROXY_HOST", "proxy.managedHost"),
    affordance("NEMOCLAW_PROXY_PORT", "proxy.managedPort"),
    affordance("NEMOCLAW_MESSAGING_PLAN_B64", "messaging.plan"),
    affordance("NEMOCLAW_MINIMAL_BOOTSTRAP", "agentConfig.minimalBootstrap", "runtime-env"),
    affordance(
      "NEMOCLAW_CORPORATE_CA_B64",
      "corporateCa.bundleSha256",
      "host-material",
      "digest-handoff",
    ),
    ...HOST_PROXY_AFFORDANCES,
  ],
  hermes: [
    affordance("NEMOCLAW_MODEL", "inference.model"),
    affordance("NEMOCLAW_INFERENCE_PROVIDER_ID", "inference.routeProvider"),
    affordance("NEMOCLAW_UPSTREAM_PROVIDER", "inference.upstreamProvider"),
    affordance("NEMOCLAW_INFERENCE_BASE_URL", "inference.routedBaseUrl"),
    affordance("NEMOCLAW_INFERENCE_API", "inference.api"),
    affordance("NEMOCLAW_CONTEXT_WINDOW", "tuning.contextWindow"),
    affordance("NEMOCLAW_TOOL_DISCLOSURE", "tools.disclosure"),
    affordance(
      "NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER",
      "tools.enabledGateways",
      "docker-arg",
      "derived",
    ),
    affordance("NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64", "tools.enabledGateways"),
    affordance("NEMOCLAW_WEB_SEARCH_ENABLED", "agentConfig.webSearch.enabled"),
    affordance("NEMOCLAW_WEB_SEARCH_PROVIDER", "agentConfig.webSearch.provider"),
    affordance("NEMOCLAW_MESSAGING_PLAN_B64", "messaging.plan"),
    affordance("CHAT_UI_URL", "dashboard.url"),
    affordance("NEMOCLAW_HERMES_DASHBOARD", "dashboard.mode", "runtime-env"),
    affordance("NEMOCLAW_HERMES_DASHBOARD_PORT", "dashboard.publicPort", "runtime-env"),
    affordance("NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT", "dashboard.internalPort", "runtime-env"),
    affordance("NEMOCLAW_HERMES_DASHBOARD_TUI", "dashboard.tuiEnabled", "runtime-env"),
    affordance("NEMOCLAW_PROXY_HOST", "proxy.managedHost", "runtime-env"),
    affordance("NEMOCLAW_PROXY_PORT", "proxy.managedPort", "runtime-env"),
    affordance(
      "NEMOCLAW_CORPORATE_CA_B64",
      "corporateCa.bundleSha256",
      "host-material",
      "digest-handoff",
    ),
    ...HOST_PROXY_AFFORDANCES,
  ],
  "langchain-deepagents-code": [
    affordance("NEMOCLAW_MODEL", "inference.model"),
    affordance("NEMOCLAW_INFERENCE_PROVIDER_ID", "inference.routeProvider"),
    affordance("NEMOCLAW_UPSTREAM_PROVIDER", "inference.upstreamProvider"),
    affordance("NEMOCLAW_UPSTREAM_ENDPOINT_URL", "inference.upstreamEndpointUrl"),
    affordance("NEMOCLAW_INFERENCE_BASE_URL", "inference.routedBaseUrl"),
    affordance("NEMOCLAW_INFERENCE_API", "inference.api"),
    affordance("NEMOCLAW_TOOL_DISCLOSURE", "tools.disclosure"),
    affordance("NEMOCLAW_DCODE_AUTO_APPROVAL", "agentConfig.autoApprovalMode"),
    affordance("NEMOCLAW_PROXY_HOST", "proxy.managedHost"),
    affordance("NEMOCLAW_PROXY_PORT", "proxy.managedPort"),
    affordance("NEMOCLAW_OBSERVABILITY", "agentConfig.observabilityEnabled", "runtime-env"),
    affordance(
      "NEMOCLAW_CORPORATE_CA_B64",
      "corporateCa.bundleSha256",
      "host-material",
      "digest-handoff",
    ),
    ...HOST_PROXY_AFFORDANCES,
  ],
} as const satisfies Record<ManagedStartupAgent, readonly ManagedStartupAffordance[]>;

export interface ManagedStartupExcludedDockerInput {
  readonly input: string;
  readonly reason:
    | "release-composition"
    | "integrity-pin"
    | "build-provenance"
    | "platform-build"
    | "fixed-image-contract";
}

/**
 * Docker inputs intentionally outside a startup profile. None are resolved
 * deployment behavior: they select/pin release artifacts, invalidate build
 * caches, or perform a platform-specific image ownership rewrite.
 */
export const MANAGED_STARTUP_PROFILE_EXCLUDED_DOCKER_INPUTS = {
  openclaw: [
    { input: "BASE_IMAGE", reason: "release-composition" },
    { input: "OPENCLAW_VERSION", reason: "release-composition" },
    { input: "OPENCLAW_2026_7_1_INTEGRITY", reason: "integrity-pin" },
    { input: "OPENCLAW_2026_7_1_TARBALL", reason: "release-composition" },
    { input: "OPENCLAW_DIAGNOSTICS_OTEL_2026_7_1_INTEGRITY", reason: "integrity-pin" },
    { input: "OPENCLAW_BRAVE_PLUGIN_2026_7_1_INTEGRITY", reason: "integrity-pin" },
    { input: "NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW", reason: "release-composition" },
    { input: "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION", reason: "release-composition" },
    { input: "OPENCLAW_2026_3_11_INTEGRITY", reason: "integrity-pin" },
    { input: "OPENCLAW_2026_3_11_TARBALL", reason: "release-composition" },
    { input: "OPENCLAW_2026_4_24_INTEGRITY", reason: "integrity-pin" },
    { input: "OPENCLAW_2026_4_24_TARBALL", reason: "release-composition" },
    { input: "CODEX_ACP_0_11_1_INTEGRITY", reason: "integrity-pin" },
    { input: "MCPORTER_VERSION", reason: "release-composition" },
    { input: "MCPORTER_0_7_3_INTEGRITY", reason: "integrity-pin" },
    { input: "MCPORTER_0_7_3_TARBALL", reason: "release-composition" },
    { input: "NEMOCLAW_BUILD_ID", reason: "build-provenance" },
    { input: "NEMOCLAW_DARWIN_VM_COMPAT", reason: "platform-build" },
    { input: "NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER", reason: "fixed-image-contract" },
  ],
  hermes: [
    { input: "BASE_IMAGE", reason: "release-composition" },
    { input: "SSL_CERT_FILE", reason: "fixed-image-contract" },
    { input: "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION", reason: "release-composition" },
    { input: "NEMOCLAW_HERMES_PROFILE_POLICY_PATCHER_SHA256", reason: "integrity-pin" },
    { input: "NEMOCLAW_HERMES_GATEWAY_RUNTIME_METADATA_PATCHER_SHA256", reason: "integrity-pin" },
    { input: "NEMOCLAW_HERMES_DISCORD_RECOVERY_PATCHER_SHA256", reason: "integrity-pin" },
    { input: "NEMOCLAW_HERMES_LANGFUSE_PATCHER_SHA256", reason: "integrity-pin" },
    { input: "NEMOCLAW_HERMES_WRAPPER_SHA256", reason: "integrity-pin" },
    { input: "NEMOCLAW_HERMES_VALIDATOR_SHA256", reason: "integrity-pin" },
    { input: "NEMOCLAW_HERMES_TIRITH_FINALIZER_SHA256", reason: "integrity-pin" },
    { input: "NEMOCLAW_BUILD_ID", reason: "build-provenance" },
    { input: "NEMOCLAW_DARWIN_VM_COMPAT", reason: "platform-build" },
    { input: "NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER", reason: "fixed-image-contract" },
  ],
  "langchain-deepagents-code": [
    { input: "BASE_IMAGE", reason: "release-composition" },
    { input: "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION", reason: "release-composition" },
    { input: "NEMOCLAW_BUILD_ID", reason: "build-provenance" },
    { input: "NEMOCLAW_DARWIN_VM_COMPAT", reason: "platform-build" },
    { input: "NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER", reason: "fixed-image-contract" },
  ],
} as const satisfies Record<ManagedStartupAgent, readonly ManagedStartupExcludedDockerInput[]>;

export class ManagedStartupProfileError extends Error {
  constructor(message: string) {
    super(`Invalid managed startup profile: ${message}`);
    this.name = "ManagedStartupProfileError";
  }
}

const PROFILE_KEYS = new Set([
  "schemaVersion",
  "agent",
  "agentConfig",
  "inference",
  "proxy",
  "dashboard",
  "tools",
  "messaging",
  "tuning",
  "corporateCa",
]);
const INFERENCE_KEYS = new Set([
  "routeProvider",
  "upstreamProvider",
  "model",
  "routedBaseUrl",
  "upstreamEndpointUrl",
  "api",
  "primaryModelRef",
  "compatibility",
  "inputModalities",
]);
const PROXY_KEYS = new Set([
  "managedHost",
  "managedPort",
  "hostHttpUrl",
  "hostHttpsUrl",
  "hostNoProxy",
]);
const OPENCLAW_DASHBOARD_KEYS = new Set([
  "agent",
  "mode",
  "url",
  "port",
  "bindAddress",
  "wslExposure",
]);
const HERMES_DASHBOARD_KEYS = new Set([
  "agent",
  "mode",
  "url",
  "publicPort",
  "internalPort",
  "tuiEnabled",
]);
const DCODE_DASHBOARD_KEYS = new Set(["agent", "mode"]);
const TOOLS_KEYS = new Set(["disclosure", "enabledGateways"]);
const MESSAGING_KEYS = new Set(["plan"]);
const TUNING_KEYS = new Set(["contextWindow", "maxTokens", "reasoning", "reasoningEffort"]);
const CORPORATE_CA_KEYS = new Set(["bundleSha256"]);
const OPENCLAW_CONFIG_KEYS = new Set([
  "agent",
  "webSearch",
  "otel",
  "agentTimeoutSeconds",
  "heartbeatEvery",
  "extraAgents",
  "deviceAuth",
  "minimalBootstrap",
]);
const HERMES_CONFIG_KEYS = new Set(["agent", "webSearch"]);
const DCODE_CONFIG_KEYS = new Set(["agent", "autoApprovalMode", "observabilityEnabled"]);
const WEB_SEARCH_KEYS = new Set(["enabled", "provider"]);
const OTEL_KEYS = new Set(["enabled", "endpointUrl", "serviceName", "sampleRate"]);
const DEVICE_AUTH_KEYS = new Set(["disabled", "optOutSource"]);
const EXTRA_AGENTS_KEYS = new Set(["agents", "defaults", "main"]);
const MANAGED_STARTUP_AGENT_SET = new Set<string>(MANAGED_STARTUP_AGENTS);
const DCODE_AUTO_APPROVAL_MODE_SET = new Set<string>(MANAGED_STARTUP_DCODE_AUTO_APPROVAL_MODES);
const INFERENCE_API_SET = new Set<string>(MANAGED_STARTUP_INFERENCE_APIS);
const REASONING_EFFORT_SET = new Set<string>(MANAGED_STARTUP_REASONING_EFFORTS);
const HERMES_GATEWAY_SET = new Set<string>(MANAGED_STARTUP_HERMES_TOOL_GATEWAYS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCredentialShapedName(name: string): boolean {
  if (PUBLIC_KEY_NAME_PATTERN.test(name)) return false;
  return (
    CREDENTIAL_SHAPED_NAME_PATTERN.test(name) ||
    CREDENTIAL_COMPOUND_NAME_PATTERN.test(name) ||
    CREDENTIAL_ENV_NAME_PATTERN.test(name) ||
    CREDENTIAL_HEADER_NAME_PATTERN.test(name) ||
    PASS_CREDENTIAL_NAME_PATTERN.test(name)
  );
}

function valueLooksLikeSecret(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function containsUrlWithUserinfo(value: string): boolean {
  for (const candidate of value.match(URL_CANDIDATE_RE) ?? []) {
    try {
      const url = new URL(candidate);
      if (url.username || url.password) return true;
    } catch {
      // A field-level URL validator owns malformed strings where a URL is expected.
    }
  }
  return false;
}

function invalid(reason: string): never {
  throw new ManagedStartupProfileError(reason);
}

function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) invalid(`${where} must be an object`);
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    invalid(`${where} contains unsupported fields`);
  }
}

function requireBoolean(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") invalid(`${where} must be a boolean`);
  return value;
}

function requireNullableBoolean(value: unknown, where: string): boolean | null {
  if (value === null) return null;
  return requireBoolean(value, where);
}

function requireBoundedString(
  value: unknown,
  where: string,
  maxBytes = MAX_IDENTIFIER_BYTES,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    CONTROL_CHARACTER_RE.test(value)
  ) {
    invalid(`${where} must be a bounded, non-empty string without control characters`);
  }
  return value;
}

function requireStringEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  where: string,
): T {
  const normalized = requireBoundedString(value, where);
  if (!allowed.has(normalized)) invalid(`${where} is not supported`);
  return normalized as T;
}

function requireNullablePositiveInteger(value: unknown, where: string): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TUNING_INTEGER
  ) {
    invalid(`${where} must be null or a bounded positive integer`);
  }
  return value;
}

function requirePositiveInteger(
  value: unknown,
  where: string,
  maximum = MAX_TUNING_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    invalid(`${where} must be a bounded positive integer`);
  }
  return value;
}

function requirePort(value: unknown, where: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    invalid(`${where} must be a valid TCP port`);
  }
  if (value < minimum) invalid(`${where} must be at least ${String(minimum)}`);
  return value;
}

function requireStringList(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    invalid(`${where} must be a bounded string list`);
  }
  const items = value.map((item) => requireBoundedString(item, `${where} item`));
  if (new Set(items).size !== items.length) invalid(`${where} must not contain duplicates`);
  return items.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function requireEnumList<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  where: string,
  options: { readonly allowEmpty: boolean },
): readonly T[] {
  const items = requireStringList(value, where);
  if (!options.allowEmpty && items.length === 0) invalid(`${where} must not be empty`);
  for (const item of items) {
    if (!allowed.has(item)) invalid(`${where} contains an unsupported value`);
  }
  return items as readonly T[];
}

function cloneJsonValue(value: unknown, where: string): ManagedStartupJsonValue {
  const clone = (current: unknown, depth: number): ManagedStartupJsonValue => {
    if (depth > MAX_JSON_DEPTH) invalid(`${where} exceeds the JSON depth limit`);
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalid(`${where} contains a non-finite number`);
      return current;
    }
    if (Array.isArray(current)) {
      return current.map((item) => clone(item, depth + 1));
    }
    if (!isPlainObject(current)) invalid(`${where} contains a non-JSON value`);
    return Object.fromEntries(
      Object.entries(current).map(([key, child]) => {
        if (
          key.length === 0 ||
          Buffer.byteLength(key, "utf8") > MAX_IDENTIFIER_BYTES ||
          CONTROL_CHARACTER_RE.test(key)
        ) {
          invalid(`${where} contains an invalid object key`);
        }
        return [key, clone(child, depth + 1)];
      }),
    );
  };
  return clone(value, 0);
}

function requireJsonObjectOrNull(value: unknown, where: string): ManagedStartupJsonObject | null {
  if (value === null) return null;
  if (!isPlainObject(value)) invalid(`${where} must be null or a plain JSON object`);
  return cloneJsonValue(value, where) as ManagedStartupJsonObject;
}

function requireJsonObject(value: unknown, where: string): ManagedStartupJsonObject {
  const object = requireJsonObjectOrNull(value, where);
  if (object === null) invalid(`${where} must be a plain JSON object`);
  return object;
}

function requireHttpUrl(value: unknown, where: string): string {
  const raw = requireBoundedString(value, where, MAX_URL_BYTES);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    invalid(`${where} must be a valid HTTP(S) URL`);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    invalid(`${where} must be a credential-free HTTP(S) URL without query or fragment data`);
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  return pathname === "" ? parsed.origin : `${parsed.origin}${pathname}`;
}

function requireProxyUrl(
  value: unknown,
  allowedSchemes: ReadonlySet<string>,
  where: string,
): string | null {
  if (value === null) return null;
  const raw = requireBoundedString(value, where, MAX_URL_BYTES);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    invalid(`${where} must be a valid HTTP(S) proxy URL`);
  }
  if (
    !allowedSchemes.has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    invalid(`${where} must be a credential-free HTTP(S) proxy origin`);
  }
  return parsed.origin;
}

function requireManagedProxyHost(value: unknown, where: string): string {
  const host = requireBoundedString(value, where);
  if (!/^[A-Za-z0-9._-]+$/u.test(host)) {
    invalid(`${where} must be a hostname or IPv4 address without a scheme or separators`);
  }
  return host;
}

function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function configuredDashboardPort(value: string): number {
  const explicit = new URL(value).port;
  return explicit === "" ? 18_789 : Number(explicit);
}

function requireSampleRate(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${where} must be a number between 0 and 1`);
  }
  return value;
}

function assertNoSecretMaterial(root: unknown): void {
  const pending: Array<{
    value: unknown;
    depth: number;
    path: readonly string[];
    allowCredentialFieldNames: boolean;
  }> = [{ value: root, depth: 0, path: [], allowCredentialFieldNames: false }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visited += 1;
    if (visited > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      invalid("payload structure exceeds the complexity limit");
    }

    if (typeof current.value === "string") {
      if (valueLooksLikeSecret(current.value)) {
        invalid("payload contains credential-shaped string data");
      }
      if (RAW_CA_PEM_RE.test(current.value) || RAW_CA_DER_BASE64_RE.test(current.value)) {
        invalid("payload contains raw certificate data; provide only the CA SHA-256 digest");
      }
      if (containsUrlWithUserinfo(current.value)) {
        invalid("payload contains a URL with embedded credentials");
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({
          value: item,
          depth: current.depth + 1,
          path: current.path,
          allowCredentialFieldNames: current.allowCredentialFieldNames,
        });
      }
      continue;
    }
    if (current.value !== null && typeof current.value === "object") {
      if (!isPlainObject(current.value)) invalid("payload must contain only plain JSON objects");
      for (const [key, child] of Object.entries(current.value)) {
        if (!current.allowCredentialFieldNames && isCredentialShapedName(key)) {
          invalid("payload contains a credential-shaped field name");
        }
        pending.push({
          value: child,
          depth: current.depth + 1,
          path: [...current.path, key],
          // A messaging plan legitimately contains schema-owned names such as
          // credentialBindings/providerEnvKey. Its dedicated validator proves
          // those bindings are placeholders rather than secrets; this module
          // still scans every nested value for raw credential material.
          allowCredentialFieldNames:
            current.allowCredentialFieldNames ||
            (current.path.length === 1 && current.path[0] === "messaging" && key === "plan"),
        });
      }
    }
  }
}

function assertPayloadWithinByteLimit(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid("payload is not serializable JSON");
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > MANAGED_STARTUP_PROFILE_MAX_BYTES
  ) {
    invalid(`payload exceeds ${String(MANAGED_STARTUP_PROFILE_MAX_BYTES)} bytes`);
  }
}

function validateWebSearch(value: unknown, agent: "openclaw" | "hermes"): ManagedStartupWebSearch {
  const webSearch = requireRecord(value, "agentConfig.webSearch");
  rejectUnknownKeys(webSearch, WEB_SEARCH_KEYS, "agentConfig.webSearch");
  const provider = requireStringEnum<ManagedStartupWebSearchProvider>(
    webSearch.provider,
    new Set(agent === "openclaw" ? ["brave", "tavily"] : ["tavily"]),
    "agentConfig.webSearch.provider",
  );
  return {
    enabled: requireBoolean(webSearch.enabled, "agentConfig.webSearch.enabled"),
    provider,
  };
}

function validateOpenClawOtel(value: unknown): ManagedStartupOpenClawOtel {
  const otel = requireRecord(value, "agentConfig.otel");
  rejectUnknownKeys(otel, OTEL_KEYS, "agentConfig.otel");
  return {
    enabled: requireBoolean(otel.enabled, "agentConfig.otel.enabled"),
    endpointUrl: requireHttpUrl(otel.endpointUrl, "agentConfig.otel.endpointUrl"),
    serviceName: requireBoundedString(
      otel.serviceName,
      "agentConfig.otel.serviceName",
      MAX_IDENTIFIER_BYTES,
    ),
    sampleRate: requireSampleRate(otel.sampleRate, "agentConfig.otel.sampleRate"),
  };
}

function validateExtraAgents(value: unknown): ManagedStartupExtraAgents {
  const extraAgents = requireRecord(value, "agentConfig.extraAgents");
  rejectUnknownKeys(extraAgents, EXTRA_AGENTS_KEYS, "agentConfig.extraAgents");
  if (!Array.isArray(extraAgents.agents) || extraAgents.agents.length > MAX_LIST_ITEMS) {
    invalid("agentConfig.extraAgents.agents must be a bounded JSON object list");
  }
  return {
    agents: extraAgents.agents.map((agent, index) =>
      requireJsonObject(agent, `agentConfig.extraAgents.agents[${String(index)}]`),
    ),
    defaults: requireJsonObject(extraAgents.defaults, "agentConfig.extraAgents.defaults"),
    main: requireJsonObject(extraAgents.main, "agentConfig.extraAgents.main"),
  };
}

function validateDeviceAuth(value: unknown): ManagedStartupDeviceAuth {
  const deviceAuth = requireRecord(value, "agentConfig.deviceAuth");
  rejectUnknownKeys(deviceAuth, DEVICE_AUTH_KEYS, "agentConfig.deviceAuth");
  return {
    disabled: requireBoolean(deviceAuth.disabled, "agentConfig.deviceAuth.disabled"),
    optOutSource: requireStringEnum<ManagedStartupDeviceAuthOptOutSource>(
      deviceAuth.optOutSource,
      new Set(["operator", "managed-onboard"]),
      "agentConfig.deviceAuth.optOutSource",
    ),
  };
}

function validateAgentConfig(
  value: unknown,
  expectedAgent: ManagedStartupAgent,
): ManagedStartupAgentConfig {
  const config = requireRecord(value, "agentConfig");
  const agent = requireStringEnum<ManagedStartupAgent>(
    config.agent,
    MANAGED_STARTUP_AGENT_SET,
    "agentConfig.agent",
  );
  if (agent !== expectedAgent) invalid("agentConfig.agent must match agent");

  if (agent === "openclaw") {
    rejectUnknownKeys(config, OPENCLAW_CONFIG_KEYS, "agentConfig");
    const heartbeatEvery =
      config.heartbeatEvery === null
        ? null
        : requireBoundedString(
            config.heartbeatEvery,
            "agentConfig.heartbeatEvery",
            MAX_IDENTIFIER_BYTES,
          );
    if (heartbeatEvery !== null && !/^\d+(?:s|m|h)$/u.test(heartbeatEvery)) {
      invalid("agentConfig.heartbeatEvery must be null or a duration ending in s, m, or h");
    }
    return {
      agent,
      webSearch: validateWebSearch(config.webSearch, agent),
      otel: validateOpenClawOtel(config.otel),
      agentTimeoutSeconds: requirePositiveInteger(
        config.agentTimeoutSeconds,
        "agentConfig.agentTimeoutSeconds",
      ),
      heartbeatEvery,
      extraAgents: validateExtraAgents(config.extraAgents),
      deviceAuth: validateDeviceAuth(config.deviceAuth),
      minimalBootstrap: requireBoolean(config.minimalBootstrap, "agentConfig.minimalBootstrap"),
    };
  }
  if (agent === "hermes") {
    rejectUnknownKeys(config, HERMES_CONFIG_KEYS, "agentConfig");
    return { agent, webSearch: validateWebSearch(config.webSearch, agent) };
  }

  rejectUnknownKeys(config, DCODE_CONFIG_KEYS, "agentConfig");
  return {
    agent,
    autoApprovalMode: requireStringEnum<ManagedStartupDcodeAutoApprovalMode>(
      config.autoApprovalMode,
      DCODE_AUTO_APPROVAL_MODE_SET,
      "agentConfig.autoApprovalMode",
    ),
    observabilityEnabled: requireBoolean(
      config.observabilityEnabled,
      "agentConfig.observabilityEnabled",
    ),
  };
}

function validateDashboard(
  value: unknown,
  expectedAgent: ManagedStartupAgent,
): ManagedStartupDashboard {
  const dashboard = requireRecord(value, "dashboard");
  const agent = requireStringEnum<ManagedStartupAgent>(
    dashboard.agent,
    MANAGED_STARTUP_AGENT_SET,
    "dashboard.agent",
  );
  if (agent !== expectedAgent) invalid("dashboard.agent must match agent");

  if (agent === "openclaw") {
    rejectUnknownKeys(dashboard, OPENCLAW_DASHBOARD_KEYS, "dashboard");
    const mode = requireStringEnum<"loopback" | "remote">(
      dashboard.mode,
      new Set(["loopback", "remote"]),
      "dashboard.mode",
    );
    const url = requireHttpUrl(dashboard.url, "dashboard.url");
    const bindAddress = requireStringEnum<"127.0.0.1" | "0.0.0.0">(
      dashboard.bindAddress,
      new Set(["127.0.0.1", "0.0.0.0"]),
      "dashboard.bindAddress",
    );
    const wslExposure = requireBoolean(dashboard.wslExposure, "dashboard.wslExposure");
    const hasRemoteExposure = !isLoopbackUrl(url) || bindAddress === "0.0.0.0" || wslExposure;
    if ((mode === "remote") !== hasRemoteExposure) {
      invalid("OpenClaw dashboard.mode must reflect its URL, bind address, and WSL exposure");
    }
    const port = requirePort(dashboard.port, "dashboard.port", 1024);
    if (port === 8642)
      invalid("OpenClaw dashboard.port must not use reserved Hermes API port 8642");
    if (configuredDashboardPort(url) !== port) {
      invalid("OpenClaw dashboard.port must match dashboard.url");
    }
    return {
      agent,
      mode,
      url,
      port,
      bindAddress,
      wslExposure,
    };
  }
  if (agent === "hermes") {
    rejectUnknownKeys(dashboard, HERMES_DASHBOARD_KEYS, "dashboard");
    const mode = requireStringEnum<"disabled" | "loopback-forwarded">(
      dashboard.mode,
      new Set(["disabled", "loopback-forwarded"]),
      "dashboard.mode",
    );
    const url = requireHttpUrl(dashboard.url, "dashboard.url");
    if (!isLoopbackUrl(url)) {
      invalid("Hermes dashboard.url must remain loopback; OpenShell owns the host forward");
    }
    if (mode === "disabled") {
      if (
        dashboard.publicPort !== null ||
        dashboard.internalPort !== null ||
        dashboard.tuiEnabled !== false
      ) {
        invalid("disabled Hermes dashboard must not configure ports or TUI");
      }
      return {
        agent,
        mode,
        url,
        publicPort: null,
        internalPort: null,
        tuiEnabled: false,
      };
    }
    const publicPort = requirePort(dashboard.publicPort, "dashboard.publicPort", 1024);
    const internalPort = requirePort(dashboard.internalPort, "dashboard.internalPort", 1024);
    if (publicPort === internalPort) {
      invalid("Hermes dashboard publicPort and internalPort must differ");
    }
    if (publicPort === 8642) {
      invalid("Hermes dashboard publicPort must not use reserved API port 8642");
    }
    if (configuredDashboardPort(url) !== publicPort) {
      invalid("Hermes dashboard.publicPort must match dashboard.url");
    }
    return {
      agent,
      mode,
      url,
      publicPort,
      internalPort,
      tuiEnabled: requireBoolean(dashboard.tuiEnabled, "dashboard.tuiEnabled"),
    };
  }

  rejectUnknownKeys(dashboard, DCODE_DASHBOARD_KEYS, "dashboard");
  if (dashboard.mode !== "disabled") {
    invalid("langchain-deepagents-code dashboard.mode must be disabled");
  }
  return { agent, mode: "disabled" };
}

function validateInference(value: unknown, agent: ManagedStartupAgent): ManagedStartupInference {
  const inference = requireRecord(value, "inference");
  rejectUnknownKeys(inference, INFERENCE_KEYS, "inference");
  const api = requireStringEnum<ManagedStartupInferenceApi>(
    inference.api,
    INFERENCE_API_SET,
    "inference.api",
  );
  const supportedInferenceApis: readonly string[] =
    MANAGED_STARTUP_PROFILE_CAPABILITIES[agent].inferenceApis;
  if (!supportedInferenceApis.includes(api)) {
    invalid(`inference.api is not supported by ${agent}`);
  }
  const upstreamEndpointUrl =
    inference.upstreamEndpointUrl === null
      ? null
      : requireHttpUrl(inference.upstreamEndpointUrl, "inference.upstreamEndpointUrl");
  const primaryModelRef =
    inference.primaryModelRef === null
      ? null
      : requireBoundedString(
          inference.primaryModelRef,
          "inference.primaryModelRef",
          MAX_MODEL_BYTES,
        );
  const compatibility = requireJsonObjectOrNull(inference.compatibility, "inference.compatibility");
  const inputModalities =
    inference.inputModalities === null
      ? null
      : requireEnumList<ManagedStartupInputModality>(
          inference.inputModalities,
          new Set(["text", "image"]),
          "inference.inputModalities",
          { allowEmpty: false },
        );

  if (agent === "openclaw") {
    if (upstreamEndpointUrl !== null) {
      invalid("inference.upstreamEndpointUrl must be null for openclaw");
    }
    if (primaryModelRef === null || inputModalities === null) {
      invalid("openclaw requires primaryModelRef and inputModalities");
    }
  } else {
    if (primaryModelRef !== null || compatibility !== null || inputModalities !== null) {
      invalid(`${agent} does not support primaryModelRef, compatibility, or inputModalities`);
    }
    if (agent === "hermes" && upstreamEndpointUrl !== null) {
      invalid("inference.upstreamEndpointUrl must be null for hermes");
    }
  }

  return {
    routeProvider: requireBoundedString(inference.routeProvider, "inference.routeProvider"),
    upstreamProvider: requireBoundedString(
      inference.upstreamProvider,
      "inference.upstreamProvider",
    ),
    model: requireBoundedString(inference.model, "inference.model", MAX_MODEL_BYTES),
    routedBaseUrl: requireHttpUrl(inference.routedBaseUrl, "inference.routedBaseUrl"),
    upstreamEndpointUrl,
    api,
    primaryModelRef,
    compatibility,
    inputModalities,
  };
}

function validateProxy(value: unknown, agent: ManagedStartupAgent): ManagedStartupProxy {
  const proxy = requireRecord(value, "proxy");
  rejectUnknownKeys(proxy, PROXY_KEYS, "proxy");
  const hostHttpUrl = requireProxyUrl(proxy.hostHttpUrl, new Set(["http:"]), "proxy.hostHttpUrl");
  // HTTPS_PROXY conventionally names an HTTP CONNECT proxy, so either scheme
  // is valid while credentials and non-origin paths remain forbidden.
  const hostHttpsUrl = requireProxyUrl(
    proxy.hostHttpsUrl,
    new Set(["http:", "https:"]),
    "proxy.hostHttpsUrl",
  );
  const hostNoProxy = requireStringList(proxy.hostNoProxy, "proxy.hostNoProxy");
  if (
    !MANAGED_STARTUP_PROFILE_CAPABILITIES[agent].supportsHostProxyIntent &&
    (hostHttpUrl !== null || hostHttpsUrl !== null || hostNoProxy.length > 0)
  ) {
    invalid(`${agent} rejects host proxy intent and uses only its trusted managed route`);
  }
  return {
    managedHost: requireManagedProxyHost(proxy.managedHost, "proxy.managedHost"),
    managedPort: requirePort(proxy.managedPort, "proxy.managedPort"),
    hostHttpUrl,
    hostHttpsUrl,
    hostNoProxy,
  };
}

function validateTools(value: unknown, agent: ManagedStartupAgent): ManagedStartupTools {
  const tools = requireRecord(value, "tools");
  rejectUnknownKeys(tools, TOOLS_KEYS, "tools");
  const enabledGateways = requireEnumList<ManagedStartupHermesToolGateway>(
    tools.enabledGateways,
    HERMES_GATEWAY_SET,
    "tools.enabledGateways",
    { allowEmpty: true },
  );
  if (agent !== "hermes" && enabledGateways.length > 0) {
    invalid("tools.enabledGateways is supported only by hermes");
  }
  return {
    disclosure: requireStringEnum<ManagedStartupToolDisclosure>(
      tools.disclosure,
      new Set(["progressive", "direct"]),
      "tools.disclosure",
    ),
    enabledGateways,
  };
}

function validateTuning(value: unknown, agent: ManagedStartupAgent): ManagedStartupTuning {
  const tuning = requireRecord(value, "tuning");
  rejectUnknownKeys(tuning, TUNING_KEYS, "tuning");
  const result: ManagedStartupTuning = {
    contextWindow: requireNullablePositiveInteger(tuning.contextWindow, "tuning.contextWindow"),
    maxTokens: requireNullablePositiveInteger(tuning.maxTokens, "tuning.maxTokens"),
    reasoning: requireNullableBoolean(tuning.reasoning, "tuning.reasoning"),
    reasoningEffort:
      tuning.reasoningEffort === null
        ? null
        : requireStringEnum<ManagedStartupReasoningEffort>(
            tuning.reasoningEffort,
            REASONING_EFFORT_SET,
            "tuning.reasoningEffort",
          ),
  };
  if (agent === "openclaw") {
    if (
      result.contextWindow === null ||
      result.maxTokens === null ||
      result.reasoning === null ||
      result.reasoningEffort === null
    ) {
      invalid("openclaw requires contextWindow, maxTokens, reasoning, and reasoningEffort tuning");
    }
  } else if (agent === "hermes") {
    if (result.maxTokens !== null || result.reasoning !== null || result.reasoningEffort !== null) {
      invalid("hermes supports only contextWindow tuning");
    }
  } else if (
    result.contextWindow !== null ||
    result.maxTokens !== null ||
    result.reasoning !== null ||
    result.reasoningEffort !== null
  ) {
    invalid("langchain-deepagents-code does not support startup tuning fields");
  }
  return result;
}

/**
 * Validate unknown input and return a canonical, deeply rebuilt profile.
 * Unknown keys are rejected at every object boundary, and unordered set-like
 * lists are sorted so all producers fingerprint the same resolved intent.
 */
export function validateManagedStartupProfile(value: unknown): ManagedStartupProfile {
  assertPayloadWithinByteLimit(value);
  assertNoSecretMaterial(value);
  const profile = requireRecord(value, "profile");
  rejectUnknownKeys(profile, PROFILE_KEYS, "profile");
  if (profile.schemaVersion !== MANAGED_STARTUP_PROFILE_SCHEMA_VERSION) {
    invalid(`schemaVersion must be ${String(MANAGED_STARTUP_PROFILE_SCHEMA_VERSION)}`);
  }
  const agent = requireStringEnum<ManagedStartupAgent>(
    profile.agent,
    MANAGED_STARTUP_AGENT_SET,
    "agent",
  );

  const messaging = requireRecord(profile.messaging, "messaging");
  rejectUnknownKeys(messaging, MESSAGING_KEYS, "messaging");
  const messagingPlan = requireJsonObjectOrNull(messaging.plan, "messaging.plan");
  if (agent === "langchain-deepagents-code" && messagingPlan !== null) {
    invalid("messaging.plan must be null for langchain-deepagents-code");
  }

  const corporateCa = requireRecord(profile.corporateCa, "corporateCa");
  rejectUnknownKeys(corporateCa, CORPORATE_CA_KEYS, "corporateCa");
  const bundleSha256 = corporateCa.bundleSha256;
  if (
    bundleSha256 !== null &&
    (typeof bundleSha256 !== "string" || !SHA256_RE.test(bundleSha256))
  ) {
    invalid("corporateCa.bundleSha256 must be null or a lowercase SHA-256 digest");
  }

  const agentConfig = validateAgentConfig(profile.agentConfig, agent);
  const dashboard = validateDashboard(profile.dashboard, agent);
  if (
    agentConfig.agent === "openclaw" &&
    dashboard.agent === "openclaw" &&
    dashboard.mode === "remote" &&
    !agentConfig.deviceAuth.disabled
  ) {
    invalid("remote OpenClaw dashboard exposure requires device auth to be disabled");
  }

  return {
    schemaVersion: MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
    agent,
    agentConfig,
    inference: validateInference(profile.inference, agent),
    proxy: validateProxy(profile.proxy, agent),
    dashboard,
    tools: validateTools(profile.tools, agent),
    messaging: {
      plan: messagingPlan,
    },
    tuning: validateTuning(profile.tuning, agent),
    corporateCa: { bundleSha256 },
  };
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJson(value[key])]),
  );
}

/** Canonical JSON used by both the transport and fingerprint. */
export function serializeManagedStartupProfile(profile: ManagedStartupProfile): string {
  const validated = validateManagedStartupProfile(profile);
  const serialized = JSON.stringify(canonicalizeJson(validated));
  if (Buffer.byteLength(serialized, "utf8") > MANAGED_STARTUP_PROFILE_MAX_BYTES) {
    invalid(`canonical payload exceeds ${String(MANAGED_STARTUP_PROFILE_MAX_BYTES)} bytes`);
  }
  return serialized;
}

/** Encode canonical JSON as unpadded base64url for an argv/env-safe handoff. */
export function encodeManagedStartupProfile(profile: ManagedStartupProfile): string {
  return Buffer.from(serializeManagedStartupProfile(profile), "utf8").toString("base64url");
}

/** Decode only the canonical representation produced by encodeManagedStartupProfile. */
export function decodeManagedStartupProfile(encoded: string): ManagedStartupProfile {
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    Buffer.byteLength(encoded, "ascii") > MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES ||
    !BASE64URL_RE.test(encoded) ||
    encoded.length % 4 === 1
  ) {
    invalid("encoded payload is malformed or exceeds the size limit");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (
    bytes.length === 0 ||
    bytes.length > MANAGED_STARTUP_PROFILE_MAX_BYTES ||
    bytes.toString("base64url") !== encoded
  ) {
    invalid("encoded payload is malformed or exceeds the size limit");
  }

  let raw: string;
  try {
    raw = UTF8_DECODER.decode(bytes);
  } catch {
    invalid("payload is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid("payload is not valid JSON");
  }
  const profile = validateManagedStartupProfile(parsed);
  if (serializeManagedStartupProfile(profile) !== raw) {
    invalid("payload is not in canonical form");
  }
  return profile;
}

/** SHA-256 over canonical decoded JSON, independent of object key insertion order. */
export function fingerprintManagedStartupProfile(profile: ManagedStartupProfile): string {
  return createHash("sha256").update(serializeManagedStartupProfile(profile), "utf8").digest("hex");
}
