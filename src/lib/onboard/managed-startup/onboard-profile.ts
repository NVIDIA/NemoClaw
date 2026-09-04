// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../messaging/manifest";
import type { ToolDisclosure } from "../../tool-disclosure";
import type { ResolvedCorporateCa } from "../corporate-ca-types";
import type { DcodeAutoApprovalMode } from "../dcode-auto-approval";
import type { HermesDashboardOnboardState } from "../hermes-dashboard";
import { hasCredentialBearingHostProxyEnvironment } from "../host-proxy-env";
import {
  MANAGED_STARTUP_AGENTS,
  MANAGED_STARTUP_PROFILE_CAPABILITIES,
  type ManagedStartupAgent,
  type ManagedStartupDashboard,
} from "./profile";
import {
  type BuiltManagedStartupProfile,
  buildManagedStartupProfile,
  MANAGED_STARTUP_HOST_PROXY_URL_INPUTS,
  type ManagedStartupResolvedInferenceInput,
} from "./profile-builder";

const PROFILE_ENVIRONMENT_INPUTS = {
  openclaw: [
    "NEMOCLAW_AGENT_HEARTBEAT_EVERY",
    "NEMOCLAW_AGENT_TIMEOUT",
    "NEMOCLAW_CONTEXT_WINDOW",
    "NEMOCLAW_EXTRA_AGENTS_JSON",
    "NEMOCLAW_EXTRA_AGENTS_JSON_B64",
    "NEMOCLAW_INFERENCE_INPUTS",
    "NEMOCLAW_MAX_TOKENS",
    "NEMOCLAW_MINIMAL_BOOTSTRAP",
    "NEMOCLAW_OPENCLAW_OTEL",
    "NEMOCLAW_OPENCLAW_OTEL_ENDPOINT",
    "NEMOCLAW_OPENCLAW_OTEL_SAMPLE_RATE",
    "NEMOCLAW_OPENCLAW_OTEL_SERVICE_NAME",
    "NEMOCLAW_PROXY_HOST",
    "NEMOCLAW_PROXY_PORT",
    "NEMOCLAW_REASONING",
    "NEMOCLAW_REASONING_EFFORT",
  ],
  hermes: ["NEMOCLAW_CONTEXT_WINDOW", "NEMOCLAW_PROXY_HOST", "NEMOCLAW_PROXY_PORT"],
  "langchain-deepagents-code": [
    "NEMOCLAW_PROXY_HOST",
    "NEMOCLAW_PROXY_PORT",
    "NEMOCLAW_REASONING_EFFORT",
  ],
  pi: [
    "NEMOCLAW_CONTEXT_WINDOW",
    "NEMOCLAW_MAX_TOKENS",
    "NEMOCLAW_PROXY_HOST",
    "NEMOCLAW_PROXY_PORT",
    "NEMOCLAW_REASONING",
  ],
} as const satisfies Record<ManagedStartupAgent, readonly string[]>;

const HOST_NO_PROXY_INPUTS = ["NO_PROXY", "no_proxy"] as const;

export interface ManagedStartupOnboardProfileInput {
  readonly agentName: string;
  readonly inference: ManagedStartupResolvedInferenceInput;
  readonly chatUiUrl: string;
  readonly effectiveDashboardPort: number;
  readonly manageDashboard: boolean;
  readonly dashboardBindAddress: string | undefined;
  readonly wslExposure: boolean;
  readonly hermesDashboardState: HermesDashboardOnboardState;
  readonly webSearch: {
    readonly fetchEnabled: boolean;
    readonly provider?: "brave" | "tavily";
  } | null;
  readonly toolDisclosure: ToolDisclosure;
  readonly hermesToolGateways: readonly string[];
  readonly messagingPlan: SandboxMessagingPlan | null;
  readonly dcodeAutoApprovalMode: DcodeAutoApprovalMode;
  readonly observabilityEnabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  /** CA material that the host resolved and validated before profile construction. */
  readonly corporateCa: ResolvedCorporateCa | null;
}

export type BuiltManagedStartupOnboardProfile = BuiltManagedStartupProfile & {
  /**
   * Non-secret replay intent. Proxy credentials remain launch-only and never
   * enter the canonical startup profile or durable receipt.
   */
  readonly credentialProxyReplayRequired: boolean;
};

export class ManagedStartupOnboardProfileError extends Error {
  constructor(message: string) {
    super(`Cannot prepare managed onboarding profile: ${message}`);
    this.name = "ManagedStartupOnboardProfileError";
  }
}

function exactManagedAgent(agentName: string): ManagedStartupAgent {
  if ((MANAGED_STARTUP_AGENTS as readonly string[]).includes(agentName)) {
    return agentName as ManagedStartupAgent;
  }
  throw new ManagedStartupOnboardProfileError(`unsupported agent '${agentName}'`);
}

function requireDashboardPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new ManagedStartupOnboardProfileError("dashboard port is missing or invalid");
  }
  return port;
}

function loopbackDashboardUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}`;
}

function dashboardHostname(chatUiUrl: string): string {
  try {
    return new URL(chatUiUrl).hostname;
  } catch {
    throw new ManagedStartupOnboardProfileError("chatUiUrl must be a valid HTTP(S) URL");
  }
}

function dashboardForInput(
  agent: ManagedStartupAgent,
  input: ManagedStartupOnboardProfileInput,
): ManagedStartupDashboard {
  if (agent === "langchain-deepagents-code") {
    if (input.manageDashboard) {
      throw new ManagedStartupOnboardProfileError("DCode must not enable a dashboard");
    }
    return { agent, mode: "disabled" };
  }

  if (agent === "pi") {
    if (input.manageDashboard) {
      throw new ManagedStartupOnboardProfileError("Pi must not enable a dashboard");
    }
    return { agent, mode: "disabled" };
  }

  if (!input.manageDashboard) {
    throw new ManagedStartupOnboardProfileError(`${agent} requires managed dashboard state`);
  }

  if (agent === "openclaw") {
    const requestedBind = input.dashboardBindAddress?.trim();
    if (requestedBind && requestedBind !== "0.0.0.0") {
      throw new ManagedStartupOnboardProfileError(
        "dashboard bind address must be empty or 0.0.0.0",
      );
    }
    const bindAddress = requestedBind === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1";
    const remote =
      bindAddress === "0.0.0.0" ||
      input.wslExposure ||
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(dashboardHostname(input.chatUiUrl));
    return {
      agent,
      mode: remote ? "remote" : "loopback",
      url: input.chatUiUrl,
      port: requireDashboardPort(input.effectiveDashboardPort),
      bindAddress,
      wslExposure: input.wslExposure,
    };
  }

  const config = input.hermesDashboardState.config;
  const effectivePort = requireDashboardPort(input.effectiveDashboardPort);
  if (!input.hermesDashboardState.enabled) {
    return {
      agent,
      mode: "disabled",
      url: loopbackDashboardUrl(effectivePort),
      browserUrl: input.chatUiUrl,
      publicPort: null,
      internalPort: null,
      tuiEnabled: false,
    };
  }
  if (!config?.enabled) {
    throw new ManagedStartupOnboardProfileError(
      "Hermes dashboard is enabled without resolved configuration",
    );
  }
  const publicPort = requireDashboardPort(config.port);
  if (publicPort !== effectivePort) {
    throw new ManagedStartupOnboardProfileError(
      "Hermes dashboard state must match the allocated dashboard port",
    );
  }
  return {
    agent,
    mode: "loopback-forwarded",
    url: loopbackDashboardUrl(publicPort),
    browserUrl: input.chatUiUrl,
    publicPort,
    internalPort: requireDashboardPort(config.internalPort),
    tuiEnabled: config.tuiEnabled,
  };
}

/**
 * Copy only knobs whose values remain environment-owned at the managed-image
 * boundary. Model, route, dashboard, tool, messaging, and agent-specific
 * selections are passed explicitly so CLI precedence cannot be reversed by a
 * stale ambient variable.
 */
function profileEnvironment(
  agent: ManagedStartupAgent,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of PROFILE_ENVIRONMENT_INPUTS[agent]) {
    const value = environment[name];
    if (value !== undefined) selected[name] = value;
  }
  const credentialProxy = hasCredentialBearingHostProxyEnvironment(environment);
  if (!credentialProxy) {
    for (const name of MANAGED_STARTUP_HOST_PROXY_URL_INPUTS) {
      const value = environment[name]?.trim();
      if (!value) continue;
      selected[name] = value;
    }
    const hasCredentialFreeProxy = MANAGED_STARTUP_HOST_PROXY_URL_INPUTS.some(
      (name) => selected[name],
    );
    if (hasCredentialFreeProxy) {
      for (const name of HOST_NO_PROXY_INPUTS) {
        const value = environment[name];
        if (value !== undefined) selected[name] = value;
      }
    }
  }
  return selected;
}

export function buildManagedStartupOnboardProfile(
  input: ManagedStartupOnboardProfileInput,
): BuiltManagedStartupOnboardProfile {
  const agent = exactManagedAgent(input.agentName);
  const capabilities = MANAGED_STARTUP_PROFILE_CAPABILITIES[agent];
  if (
    capabilities.inputModalities.length === 0 &&
    typeof input.environment.NEMOCLAW_INFERENCE_INPUTS === "string" &&
    input.environment.NEMOCLAW_INFERENCE_INPUTS.trim() !== ""
  ) {
    throw new ManagedStartupOnboardProfileError(
      `NEMOCLAW_INFERENCE_INPUTS is not supported by ${agent}`,
    );
  }
  if (!capabilities.supportsMessaging && input.messagingPlan !== null) {
    throw new ManagedStartupOnboardProfileError(`${agent} does not support messaging`);
  }
  const dashboard = dashboardForInput(agent, input);
  const environment = profileEnvironment(agent, input.environment);
  const credentialProxyReplayRequired =
    capabilities.supportsMessaging && hasCredentialBearingHostProxyEnvironment(input.environment);
  const built = buildManagedStartupProfile({
    agent,
    inference: input.inference,
    dashboard,
    webSearch: capabilities.webSearchProviders.length > 0 ? input.webSearch : null,
    toolDisclosure: input.toolDisclosure,
    hermesToolGateways: agent === "hermes" ? input.hermesToolGateways : [],
    messagingPlan: capabilities.supportsMessaging ? input.messagingPlan : null,
    dcodeAutoApprovalMode:
      agent === "langchain-deepagents-code" ? input.dcodeAutoApprovalMode : null,
    observabilityEnabled: agent === "langchain-deepagents-code" ? input.observabilityEnabled : null,
    environment,
    corporateCa: input.corporateCa,
  });
  return Object.freeze({ ...built, credentialProxyReplayRequired });
}
