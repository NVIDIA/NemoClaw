// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { parseSandboxMessagingPlan } from "../../messaging/plan-validation";
import {
  MANAGED_STARTUP_RUNTIME_CLEANUP_OBLIGATIONS,
  type ManagedStartupAgent,
  type ManagedStartupDashboard,
  type ManagedStartupMessagingAgent,
  type ManagedStartupProfile,
  validateManagedStartupProfile,
} from "./profile";

export type ManagedStartupConfigAgent = ManagedStartupAgent;
export type { ManagedStartupMessagingAgent } from "./profile";

export interface ManagedStartupCorporateCaMaterial {
  readonly kind: "corporate-ca-handoff";
  readonly legacyInput: "NEMOCLAW_CORPORATE_CA_B64";
  /**
   * The certificate bytes use a separate bounded transport. Keeping only its
   * digest here prevents the driver-neutral profile mapper from becoming a
   * secret or arbitrary-file transport.
   */
  readonly expectedSha256: string | null;
}

export interface ManagedStartupRootOwnedFileMaterial {
  readonly kind: "root-owned-file";
  readonly legacyInput:
    | "NEMOCLAW_DCODE_AUTO_APPROVAL"
    | "NEMOCLAW_INFERENCE_BASE_URL"
    | "NEMOCLAW_PROXY_HOST"
    | "NEMOCLAW_PROXY_PORT"
    | "NEMOCLAW_REASONING_EFFORT"
    | "NEMOCLAW_UPSTREAM_PROVIDER";
  readonly path:
    | "/usr/local/share/nemoclaw/dcode-auto-approval"
    | "/usr/local/share/nemoclaw/dcode-inference-base-url"
    | "/usr/local/share/nemoclaw/dcode-proxy-host"
    | "/usr/local/share/nemoclaw/dcode-proxy-port"
    | "/usr/local/share/nemoclaw/dcode-reasoning-effort"
    | "/usr/local/share/nemoclaw/dcode-upstream-provider"
    | "/usr/local/share/nemoclaw/pi-proxy-host"
    | "/usr/local/share/nemoclaw/pi-proxy-port";
  readonly contents: string;
  readonly owner: "root";
  readonly group: "root";
  readonly mode: 0o444;
}

export type ManagedStartupAgentMaterial =
  | ManagedStartupCorporateCaMaterial
  | ManagedStartupRootOwnedFileMaterial;

export interface ManagedStartupApplicationRuntimePlan {
  /** Validated launch-only values that remain available to image setup and the agent runtime. */
  readonly exportEnvironment: Readonly<Record<string, string>>;
  /** Ambient launch values that are unsupported for the selected agent and must be removed. */
  readonly unsetEnvironment: readonly string[];
}

export interface ManagedStartupGenerateConfigAction {
  readonly kind: "generate-agent-config";
  readonly agent: ManagedStartupConfigAgent;
  readonly runAs: "sandbox";
}

interface ManagedStartupApplyMessagingActionBase {
  readonly kind: "apply-messaging-plan";
  readonly agent: ManagedStartupMessagingAgent;
  readonly mode: "apply" | "clear";
  /**
   * Complete managed images already contain the reviewed dependency union.
   * The runtime action vocabulary intentionally cannot express the
   * package-install phase.
   */
  readonly phase: "runtime-setup" | "post-agent-install";
}

export interface ManagedStartupApplyMessagingRuntimeAction extends ManagedStartupApplyMessagingActionBase {
  readonly phase: "runtime-setup";
  /** Writes the reduced, root-owned messaging runtime-plan artifact. */
  readonly runAs: "root";
}

export interface ManagedStartupApplyMessagingConfigAction extends ManagedStartupApplyMessagingActionBase {
  readonly phase: "post-agent-install";
  /** Renders only sandbox-owned agent configuration from preinstalled assets. */
  readonly runAs: "sandbox";
}

export type ManagedStartupApplyMessagingAction =
  | ManagedStartupApplyMessagingRuntimeAction
  | ManagedStartupApplyMessagingConfigAction;

export interface ManagedStartupConfigureDashboardAction {
  readonly kind: "configure-dashboard";
  readonly dashboard: ManagedStartupDashboard;
}

export type ManagedStartupAgentAction =
  | ManagedStartupGenerateConfigAction
  | ManagedStartupApplyMessagingAction
  | ManagedStartupConfigureDashboardAction;

export interface ManagedStartupAgentEnvironment {
  readonly schemaVersion: ManagedStartupProfile["schemaVersion"];
  readonly agent: ManagedStartupAgent;
  /**
   * Inputs scoped to the trusted configuration-application phase. The
   * application boundary must not blindly retain this whole map in the agent
   * process environment.
   */
  readonly configurationEnvironment: Readonly<Record<string, string>>;
  /**
   * Non-secret values intentionally retained for existing entrypoints and
   * agent runtime adapters after generated configuration is committed.
   */
  readonly runtimeEnvironment: Readonly<Record<string, string>>;
  readonly applicationRuntime: ManagedStartupApplicationRuntimePlan;
  readonly materials: readonly ManagedStartupAgentMaterial[];
  readonly actions: readonly ManagedStartupAgentAction[];
}

export class ManagedStartupAgentEnvironmentError extends Error {
  constructor(message: string) {
    super(`Cannot map managed startup profile: ${message}`);
    this.name = "ManagedStartupAgentEnvironmentError";
  }
}

type MutableEnvironment = Record<string, string>;
type ApplicationEnvironment = Readonly<Record<string, string | undefined>>;
const EMPTY_APPLICATION_ENVIRONMENT: ApplicationEnvironment = Object.freeze({});

const OPENCLAW_APPLICATION_RUNTIME_INPUTS = Object.freeze([
  ["NEMOCLAW_AUTO_PAIR_DEADLINE_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS", "positive-safe-integer"],
  ["NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS", "positive-finite-seconds"],
  ["NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS", "positive-finite-seconds"],
] as const);

function booleanFlag(value: boolean): "0" | "1" {
  return value ? "1" : "0";
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item));
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalizeJson(record[key])]),
  );
}

function encodeCanonicalJson(value: unknown): string {
  return Buffer.from(JSON.stringify(canonicalizeJson(value)), "utf8").toString("base64");
}

function sortedEnvironment(environment: MutableEnvironment): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(environment).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
  );
}

function canonicalApplicationRuntimeValue(
  name: string,
  raw: string,
  kind: "positive-finite-seconds" | "positive-safe-integer",
): string {
  if (raw.includes("\0") || /[\r\n]/u.test(raw)) {
    throw new ManagedStartupAgentEnvironmentError(`${name} must be single-line text`);
  }
  const value = Number(raw.trim());
  const valid =
    kind === "positive-safe-integer"
      ? Number.isSafeInteger(value) && value > 0
      : Number.isFinite(value) && value > 0;
  if (!valid) {
    throw new ManagedStartupAgentEnvironmentError(
      `${name} must be ${
        kind === "positive-safe-integer" ? "a positive safe integer" : "finite positive seconds"
      }`,
    );
  }
  return String(value);
}

function applicationRuntimePlan(
  profile: ManagedStartupProfile,
  environment: ApplicationEnvironment,
): ManagedStartupApplicationRuntimePlan {
  const exportEnvironment: MutableEnvironment = {};
  if (profile.agent === "openclaw") {
    for (const [name, kind] of OPENCLAW_APPLICATION_RUNTIME_INPUTS) {
      const raw = environment[name];
      if (raw !== undefined) {
        exportEnvironment[name] = canonicalApplicationRuntimeValue(name, raw, kind);
      }
    }
  }
  const unsetEnvironment = new Set(
    MANAGED_STARTUP_RUNTIME_CLEANUP_OBLIGATIONS.filter(
      ({ supportedFor }) => !supportedFor.includes(profile.agent),
    ).map(({ input }) => input),
  );
  if (profile.agent !== "openclaw") {
    for (const [name] of OPENCLAW_APPLICATION_RUNTIME_INPUTS) {
      unsetEnvironment.add(name);
    }
  }
  return Object.freeze({
    exportEnvironment: sortedEnvironment(exportEnvironment),
    unsetEnvironment: Object.freeze([...unsetEnvironment].sort()),
  });
}

function commonConfigurationEnvironment(profile: ManagedStartupProfile): MutableEnvironment {
  return {
    NEMOCLAW_INFERENCE_API: profile.inference.api,
    NEMOCLAW_INFERENCE_BASE_URL: profile.inference.routedBaseUrl,
    NEMOCLAW_INFERENCE_PROVIDER_ID: profile.inference.routeProvider,
    NEMOCLAW_MODEL: profile.inference.model,
    NEMOCLAW_TOOL_DISCLOSURE: profile.tools.disclosure,
    NEMOCLAW_UPSTREAM_PROVIDER: profile.inference.upstreamProvider,
  };
}

function appendHostProxyEnvironment(
  environment: MutableEnvironment,
  profile: ManagedStartupProfile,
  options: { readonly preserveAmbientWhenAbsent?: boolean } = {},
): void {
  if (
    options.preserveAmbientWhenAbsent === true &&
    profile.proxy.hostHttpUrl === null &&
    profile.proxy.hostHttpsUrl === null &&
    profile.proxy.hostNoProxy.length === 0
  ) {
    return;
  }
  const httpProxy = profile.proxy.hostHttpUrl ?? "";
  const httpsProxy = profile.proxy.hostHttpsUrl ?? "";
  const noProxy = profile.proxy.hostNoProxy.join(",");
  environment.HTTP_PROXY = httpProxy;
  environment.HTTPS_PROXY = httpsProxy;
  environment.NO_PROXY = noProxy;
  environment.http_proxy = httpProxy;
  environment.https_proxy = httpsProxy;
  environment.no_proxy = noProxy;
}

function messagingEnvironment(
  profile: ManagedStartupProfile,
  expectedAgent: ManagedStartupMessagingAgent,
): MutableEnvironment {
  if (profile.messaging.plan === null) return {};
  const plan = parseSandboxMessagingPlan(profile.messaging.plan, { agent: expectedAgent });
  if (!plan) {
    throw new ManagedStartupAgentEnvironmentError(
      `messaging.plan must contain a validated ${expectedAgent} messaging plan`,
    );
  }
  const { workflow: _workflow, ...imageBuildPlan } = plan;
  return {
    NEMOCLAW_MESSAGING_PLAN_B64: encodeCanonicalJson(imageBuildPlan),
  };
}

function corporateCaMaterial(profile: ManagedStartupProfile): ManagedStartupCorporateCaMaterial {
  return Object.freeze({
    kind: "corporate-ca-handoff",
    legacyInput: "NEMOCLAW_CORPORATE_CA_B64",
    expectedSha256: profile.corporateCa.bundleSha256,
  });
}

function rootOwnedFile(
  legacyInput: ManagedStartupRootOwnedFileMaterial["legacyInput"],
  path: ManagedStartupRootOwnedFileMaterial["path"],
  value: string,
): ManagedStartupRootOwnedFileMaterial {
  return Object.freeze({
    kind: "root-owned-file",
    legacyInput,
    path,
    contents: `${value}\n`,
    owner: "root",
    group: "root",
    mode: 0o444,
  });
}

function dashboardAction(
  dashboard: ManagedStartupDashboard,
): ManagedStartupConfigureDashboardAction {
  return Object.freeze({
    kind: "configure-dashboard",
    dashboard: Object.freeze(structuredClone(dashboard)),
  });
}

function applicationActions(
  profile: ManagedStartupProfile,
  messagingAgent: ManagedStartupMessagingAgent | null,
): readonly ManagedStartupAgentAction[] {
  const actions: ManagedStartupAgentAction[] = [];
  if (messagingAgent !== null) {
    actions.push(
      Object.freeze({
        kind: "apply-messaging-plan",
        agent: messagingAgent,
        mode: profile.messaging.plan === null ? "clear" : "apply",
        phase: "runtime-setup",
        runAs: "root",
      }),
    );
  }
  actions.push(
    Object.freeze({
      kind: "generate-agent-config",
      agent: profile.agent,
      runAs: "sandbox",
    }),
  );
  if (messagingAgent !== null) {
    actions.push(
      Object.freeze({
        kind: "apply-messaging-plan",
        agent: messagingAgent,
        mode: profile.messaging.plan === null ? "clear" : "apply",
        phase: "post-agent-install",
        runAs: "sandbox",
      }),
    );
  }
  actions.push(dashboardAction(profile.dashboard));
  return Object.freeze(actions);
}

function mapOpenClawProfile(
  profile: ManagedStartupProfile,
  environment: ApplicationEnvironment,
): ManagedStartupAgentEnvironment {
  if (
    profile.agent !== "openclaw" ||
    profile.agentConfig.agent !== "openclaw" ||
    profile.dashboard.agent !== "openclaw" ||
    profile.inference.primaryModelRef === null ||
    profile.inference.inputModalities === null ||
    profile.tuning.contextWindow === null ||
    profile.tuning.maxTokens === null ||
    profile.tuning.reasoning === null ||
    profile.tuning.reasoningEffort === null
  ) {
    throw new ManagedStartupAgentEnvironmentError("OpenClaw profile state is inconsistent");
  }

  const configurationEnvironment: MutableEnvironment = {
    ...commonConfigurationEnvironment(profile),
    ...messagingEnvironment(profile, "openclaw"),
    CHAT_UI_URL: profile.dashboard.url,
    NEMOCLAW_AGENT_HEARTBEAT_EVERY: profile.agentConfig.heartbeatEvery ?? "",
    NEMOCLAW_AGENT_TIMEOUT: String(profile.agentConfig.agentTimeoutSeconds),
    NEMOCLAW_CONTEXT_WINDOW: String(profile.tuning.contextWindow),
    NEMOCLAW_DASHBOARD_BIND:
      profile.dashboard.bindAddress === "0.0.0.0" ? profile.dashboard.bindAddress : "",
    NEMOCLAW_DISABLE_DEVICE_AUTH: booleanFlag(profile.agentConfig.deviceAuth.disabled),
    NEMOCLAW_DEVICE_AUTH_OPT_OUT_SOURCE: profile.agentConfig.deviceAuth.optOutSource,
    NEMOCLAW_EXTRA_AGENTS_JSON_B64: encodeCanonicalJson(profile.agentConfig.extraAgents),
    NEMOCLAW_INFERENCE_COMPAT_B64: encodeCanonicalJson(profile.inference.compatibility),
    NEMOCLAW_INFERENCE_INPUTS: profile.inference.inputModalities.join(","),
    NEMOCLAW_MAX_TOKENS: String(profile.tuning.maxTokens),
    NEMOCLAW_OPENCLAW_OTEL: booleanFlag(profile.agentConfig.otel.enabled),
    NEMOCLAW_OPENCLAW_OTEL_ENDPOINT: profile.agentConfig.otel.endpointUrl,
    NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE: String(profile.agentConfig.otel.sampleRate),
    NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME: profile.agentConfig.otel.serviceName,
    NEMOCLAW_PRIMARY_MODEL_REF: profile.inference.primaryModelRef,
    NEMOCLAW_PROXY_HOST: profile.proxy.managedHost,
    NEMOCLAW_PROXY_PORT: String(profile.proxy.managedPort),
    NEMOCLAW_REASONING: String(profile.tuning.reasoning),
    NEMOCLAW_REASONING_EFFORT: profile.tuning.reasoningEffort,
    NEMOCLAW_WEB_SEARCH_ENABLED: booleanFlag(profile.agentConfig.webSearch.enabled),
    NEMOCLAW_WEB_SEARCH_PROVIDER: profile.agentConfig.webSearch.provider,
    NEMOCLAW_WSL_DASHBOARD_EXPOSURE: booleanFlag(profile.dashboard.wslExposure),
  };

  const runtimeEnvironment: MutableEnvironment = { ...configurationEnvironment };
  delete runtimeEnvironment.NEMOCLAW_MESSAGING_PLAN_B64;
  runtimeEnvironment.NEMOCLAW_DASHBOARD_PORT = String(profile.dashboard.port);
  runtimeEnvironment.NEMOCLAW_MINIMAL_BOOTSTRAP = booleanFlag(profile.agentConfig.minimalBootstrap);
  appendHostProxyEnvironment(runtimeEnvironment, profile, { preserveAmbientWhenAbsent: true });

  return Object.freeze({
    schemaVersion: profile.schemaVersion,
    agent: profile.agent,
    configurationEnvironment: sortedEnvironment(configurationEnvironment),
    runtimeEnvironment: sortedEnvironment(runtimeEnvironment),
    applicationRuntime: applicationRuntimePlan(profile, environment),
    materials: Object.freeze([corporateCaMaterial(profile)]),
    actions: applicationActions(profile, "openclaw"),
  });
}

function mapHermesProfile(
  profile: ManagedStartupProfile,
  environment: ApplicationEnvironment,
): ManagedStartupAgentEnvironment {
  if (
    profile.agent !== "hermes" ||
    profile.agentConfig.agent !== "hermes" ||
    profile.dashboard.agent !== "hermes"
  ) {
    throw new ManagedStartupAgentEnvironmentError("Hermes profile state is inconsistent");
  }

  let chatUiUrl = profile.dashboard.browserUrl ?? profile.dashboard.url;
  if (profile.dashboard.mode === "loopback-forwarded") {
    if (profile.dashboard.browserUrl === undefined) {
      throw new ManagedStartupAgentEnvironmentError(
        "Cannot start the Hermes dashboard because its managed startup profile has no recorded browser URL. Rerun onboarding before starting the sandbox.",
      );
    }
    chatUiUrl = profile.dashboard.browserUrl;
  }

  const configurationEnvironment: MutableEnvironment = {
    ...commonConfigurationEnvironment(profile),
    ...messagingEnvironment(profile, "hermes"),
    CHAT_UI_URL: chatUiUrl,
    NEMOCLAW_CONTEXT_WINDOW:
      profile.tuning.contextWindow === null ? "" : String(profile.tuning.contextWindow),
    NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER: booleanFlag(profile.tools.enabledGateways.length > 0),
    NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64: encodeCanonicalJson(profile.tools.enabledGateways),
    NEMOCLAW_WEB_SEARCH_ENABLED: booleanFlag(profile.agentConfig.webSearch.enabled),
    NEMOCLAW_WEB_SEARCH_PROVIDER: profile.agentConfig.webSearch.provider,
  };

  const runtimeEnvironment: MutableEnvironment = { ...configurationEnvironment };
  delete runtimeEnvironment.NEMOCLAW_MESSAGING_PLAN_B64;
  runtimeEnvironment.NEMOCLAW_DASHBOARD_PORT =
    profile.dashboard.publicPort === null ? "" : String(profile.dashboard.publicPort);
  runtimeEnvironment.NEMOCLAW_HERMES_DASHBOARD =
    profile.dashboard.mode === "loopback-forwarded" ? "1" : "0";
  runtimeEnvironment.NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT =
    profile.dashboard.internalPort === null ? "" : String(profile.dashboard.internalPort);
  runtimeEnvironment.NEMOCLAW_HERMES_DASHBOARD_PORT =
    profile.dashboard.publicPort === null ? "" : String(profile.dashboard.publicPort);
  runtimeEnvironment.NEMOCLAW_HERMES_DASHBOARD_TUI = booleanFlag(profile.dashboard.tuiEnabled);
  runtimeEnvironment.NEMOCLAW_PROXY_HOST = profile.proxy.managedHost;
  runtimeEnvironment.NEMOCLAW_PROXY_PORT = String(profile.proxy.managedPort);
  appendHostProxyEnvironment(runtimeEnvironment, profile, { preserveAmbientWhenAbsent: true });

  return Object.freeze({
    schemaVersion: profile.schemaVersion,
    agent: profile.agent,
    configurationEnvironment: sortedEnvironment(configurationEnvironment),
    runtimeEnvironment: sortedEnvironment(runtimeEnvironment),
    applicationRuntime: applicationRuntimePlan(profile, environment),
    materials: Object.freeze([corporateCaMaterial(profile)]),
    actions: applicationActions(profile, "hermes"),
  });
}

function mapDcodeProfile(
  profile: ManagedStartupProfile,
  environment: ApplicationEnvironment,
): ManagedStartupAgentEnvironment {
  if (
    profile.agent !== "langchain-deepagents-code" ||
    profile.agentConfig.agent !== "langchain-deepagents-code" ||
    profile.dashboard.agent !== "langchain-deepagents-code" ||
    profile.messaging.plan !== null
  ) {
    throw new ManagedStartupAgentEnvironmentError(
      "LangChain Deep Agents Code profile state is inconsistent",
    );
  }

  const reasoningEffort =
    profile.tuning.reasoningEffort === null || profile.tuning.reasoningEffort === "default"
      ? ""
      : profile.tuning.reasoningEffort;
  const configurationEnvironment: MutableEnvironment = {
    ...commonConfigurationEnvironment(profile),
    NEMOCLAW_REASONING_EFFORT: reasoningEffort,
    NEMOCLAW_UPSTREAM_ENDPOINT_URL: profile.inference.upstreamEndpointUrl ?? "",
  };
  appendHostProxyEnvironment(configurationEnvironment, profile);
  const runtimeEnvironment: MutableEnvironment = {
    ...configurationEnvironment,
    NEMOCLAW_OBSERVABILITY: booleanFlag(profile.agentConfig.observabilityEnabled),
  };
  // The config generator needs the routed base URL and the reasoning effort,
  // but the long-running DCode process trusts only the root-owned files
  // consumed by managed-dcode-runtime.py.
  delete runtimeEnvironment.NEMOCLAW_INFERENCE_BASE_URL;
  delete runtimeEnvironment.NEMOCLAW_REASONING_EFFORT;
  delete runtimeEnvironment.NEMOCLAW_UPSTREAM_PROVIDER;
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    delete runtimeEnvironment[name];
  }
  const materials: readonly ManagedStartupAgentMaterial[] = Object.freeze([
    corporateCaMaterial(profile),
    rootOwnedFile(
      "NEMOCLAW_DCODE_AUTO_APPROVAL",
      "/usr/local/share/nemoclaw/dcode-auto-approval",
      profile.agentConfig.autoApprovalMode,
    ),
    rootOwnedFile(
      "NEMOCLAW_INFERENCE_BASE_URL",
      "/usr/local/share/nemoclaw/dcode-inference-base-url",
      profile.inference.routedBaseUrl,
    ),
    rootOwnedFile(
      "NEMOCLAW_UPSTREAM_PROVIDER",
      "/usr/local/share/nemoclaw/dcode-upstream-provider",
      profile.inference.upstreamProvider,
    ),
    rootOwnedFile(
      "NEMOCLAW_PROXY_HOST",
      "/usr/local/share/nemoclaw/dcode-proxy-host",
      profile.proxy.managedHost,
    ),
    rootOwnedFile(
      "NEMOCLAW_PROXY_PORT",
      "/usr/local/share/nemoclaw/dcode-proxy-port",
      String(profile.proxy.managedPort),
    ),
    rootOwnedFile(
      "NEMOCLAW_REASONING_EFFORT",
      "/usr/local/share/nemoclaw/dcode-reasoning-effort",
      reasoningEffort,
    ),
  ]);

  return Object.freeze({
    schemaVersion: profile.schemaVersion,
    agent: profile.agent,
    configurationEnvironment: sortedEnvironment(configurationEnvironment),
    runtimeEnvironment: sortedEnvironment(runtimeEnvironment),
    applicationRuntime: applicationRuntimePlan(profile, environment),
    materials,
    actions: applicationActions(profile, null),
  });
}

function mapPiProfile(
  profile: ManagedStartupProfile,
  environment: ApplicationEnvironment,
): ManagedStartupAgentEnvironment {
  if (
    profile.agent !== "pi" ||
    profile.agentConfig.agent !== "pi" ||
    profile.dashboard.agent !== "pi" ||
    profile.messaging.plan !== null
  ) {
    throw new ManagedStartupAgentEnvironmentError("Pi profile state is inconsistent");
  }

  const configurationEnvironment: MutableEnvironment = {
    ...commonConfigurationEnvironment(profile),
    NEMOCLAW_CONTEXT_WINDOW:
      profile.tuning.contextWindow === null ? "" : String(profile.tuning.contextWindow),
    NEMOCLAW_MAX_TOKENS: profile.tuning.maxTokens === null ? "" : String(profile.tuning.maxTokens),
    NEMOCLAW_REASONING:
      profile.tuning.reasoning === null ? "" : String(profile.tuning.reasoning),
  };
  appendHostProxyEnvironment(configurationEnvironment, profile);
  const runtimeEnvironment: MutableEnvironment = { ...configurationEnvironment };
  delete runtimeEnvironment.NEMOCLAW_INFERENCE_BASE_URL;
  delete runtimeEnvironment.NEMOCLAW_CONTEXT_WINDOW;
  delete runtimeEnvironment.NEMOCLAW_MAX_TOKENS;
  delete runtimeEnvironment.NEMOCLAW_REASONING;
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    delete runtimeEnvironment[name];
  }
  const materials: readonly ManagedStartupAgentMaterial[] = Object.freeze([
    corporateCaMaterial(profile),
    rootOwnedFile(
      "NEMOCLAW_PROXY_HOST",
      "/usr/local/share/nemoclaw/pi-proxy-host",
      profile.proxy.managedHost,
    ),
    rootOwnedFile(
      "NEMOCLAW_PROXY_PORT",
      "/usr/local/share/nemoclaw/pi-proxy-port",
      String(profile.proxy.managedPort),
    ),
  ]);

  return Object.freeze({
    schemaVersion: profile.schemaVersion,
    agent: profile.agent,
    configurationEnvironment: sortedEnvironment(configurationEnvironment),
    runtimeEnvironment: sortedEnvironment(runtimeEnvironment),
    applicationRuntime: applicationRuntimePlan(profile, environment),
    materials,
    actions: applicationActions(profile, null),
  });
}

/**
 * Convert a secret-free validated profile into existing agent-generator and
 * entrypoint inputs without depending on Docker, Podman, or another compute
 * driver. Validation is repeated at this trust boundary so callers cannot use
 * a TypeScript assertion to bypass agent capability checks.
 */
export function mapManagedStartupProfileToAgentEnvironment(
  profile: ManagedStartupProfile,
  environment: ApplicationEnvironment = EMPTY_APPLICATION_ENVIRONMENT,
): ManagedStartupAgentEnvironment {
  const validated = validateManagedStartupProfile(profile);
  switch (validated.agent) {
    case "openclaw":
      return mapOpenClawProfile(validated, environment);
    case "hermes":
      return mapHermesProfile(validated, environment);
    case "langchain-deepagents-code":
      return mapDcodeProfile(validated, environment);
    case "pi":
      return mapPiProfile(validated, environment);
  }
}
