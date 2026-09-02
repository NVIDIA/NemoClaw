// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { cloneAndDeepFreeze } from "../../core/immutable";
import { rebindLoopbackDashboardUrlPort } from "../../dashboard/url";
import { resolveContextWindowForModel } from "../../inference/context-window";
import { rebindSandboxMessagingPlanForClone } from "../../messaging/clone-rebind";
import { isValidName } from "../../name-validation";
import { DEFAULT_TOOL_DISCLOSURE } from "../../tool-disclosure";
import { resolveManagedStartupInferenceRoute } from "../inference-route";
import { validateManagedStartupCorporateCaTransport } from "./application";
import {
  decodeManagedStartupProfile,
  encodeManagedStartupProfile,
  type ManagedStartupAgent,
  type ManagedStartupDashboard,
  type ManagedStartupJsonObject,
  type ManagedStartupProfile,
  validateManagedStartupProfile,
} from "./profile";

export const managedStartupCloneRebinderDependencies = {
  resolveContextWindowForModel,
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MANAGED_INFERENCE_API_SET = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);

/**
 * Current durable state for the source sandbox. The managed-image receipt owns
 * immutable image affordances; mutable operator intent is re-read from this
 * state before a clone handoff can be prepared.
 */
export interface ManagedStartupCloneCurrentState {
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly endpointUrl?: string | null;
  readonly preferredInferenceApi?: string | null;
  readonly compatibleEndpointReasoning?: "true" | "false" | string | null;
  readonly compatibleEndpointReasoningEffort?: "low" | "medium" | "high" | string | null;
  readonly toolDisclosure?: "progressive" | "direct" | string;
  readonly webSearchEnabled?: boolean;
  readonly webSearchProvider?: "brave" | "tavily" | string | null;
  readonly messaging?: { readonly schemaVersion?: number; readonly plan?: unknown } | null;
  readonly hermesToolGateways?: readonly string[];
  readonly hermesDashboardEnabled?: boolean;
  readonly hermesDashboardPort?: number | null;
  readonly hermesDashboardInternalPort?: number | null;
  readonly hermesDashboardTui?: boolean;
  readonly dashboardPort?: number | null;
  readonly dashboardRemoteBindPrepared?: boolean;
  readonly dcodeAutoApprovalMode?: "disabled" | "thread-opt-in" | string;
  readonly observabilityEnabled?: boolean;
}

export interface ManagedStartupCloneRebindInput {
  readonly sourceSandboxName: string;
  readonly destinationSandboxName: string;
  readonly expectedAgent: ManagedStartupAgent;
  readonly destinationDashboardPort: number | null;
  /** Destination-scoped OpenShell identity for Hermes' host-minted inference key. */
  readonly destinationHermesInferenceProvider?: string;
  readonly encodedProfile: string;
  readonly startupProfileSha256: string;
  readonly corporateCaB64?: string;
  readonly currentSource: ManagedStartupCloneCurrentState;
}

export interface ReboundManagedStartupClone {
  readonly profile: ManagedStartupProfile;
  readonly encodedProfile: string;
  readonly startupProfileSha256: string;
  readonly corporateCaB64?: string;
}

export class ManagedStartupCloneRebindError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Cannot prepare managed snapshot clone: ${message}`, options);
    this.name = "ManagedStartupCloneRebindError";
  }
}

function fail(message: string, cause?: unknown): never {
  throw new ManagedStartupCloneRebindError(message, cause === undefined ? undefined : { cause });
}

function requireSandboxName(value: string, label: string): string {
  if (!isValidName(value)) fail(`${label} sandbox name is invalid`);
  return value;
}

function requireDestinationPort(port: number | null, agent: ManagedStartupAgent): number {
  if (!Number.isInteger(port) || port === null || port < 1024 || port > 65_535) {
    fail(`${agent} requires an allocated destination dashboard port`);
  }
  return port;
}

function urlAtPort(raw: string, port: number): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    fail("source dashboard URL is invalid", error);
  }
  parsed.port = String(port);
  return parsed.toString();
}

function requireCurrentString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    fail(`current source ${label} is missing or invalid`);
  }
  return value;
}

function optionalCurrentString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return requireCurrentString(value, label);
}

function currentInference(
  profile: ManagedStartupProfile,
  current: ManagedStartupCloneCurrentState,
): ManagedStartupProfile["inference"] {
  const provider = requireCurrentString(current.provider, "inference provider");
  const model = requireCurrentString(current.model, "inference model");
  const preferredApi = optionalCurrentString(
    current.preferredInferenceApi,
    "preferred inference API",
  );
  if (preferredApi !== null && !MANAGED_INFERENCE_API_SET.has(preferredApi)) {
    fail("current source preferred inference API is unsupported");
  }
  const resolved = resolveManagedStartupInferenceRoute(
    profile.agent,
    provider,
    model,
    preferredApi,
  );
  if (!MANAGED_INFERENCE_API_SET.has(resolved.inferenceApi)) {
    fail("current source inference route resolved an unsupported API");
  }
  const upstreamEndpointUrl =
    profile.agent === "langchain-deepagents-code"
      ? optionalCurrentString(current.endpointUrl, "upstream endpoint URL")
      : null;
  return {
    routeProvider: resolved.providerKey,
    upstreamProvider: provider,
    model,
    routedBaseUrl: resolved.inferenceBaseUrl,
    upstreamEndpointUrl,
    api: resolved.inferenceApi as ManagedStartupProfile["inference"]["api"],
    primaryModelRef: profile.agent === "openclaw" ? resolved.primaryModelRef : null,
    compatibility:
      profile.agent === "openclaw"
        ? (JSON.parse(JSON.stringify(resolved.inferenceCompat ?? {})) as ManagedStartupJsonObject)
        : null,
    inputModalities: profile.agent === "openclaw" ? profile.inference.inputModalities : null,
  };
}

function currentToolDisclosure(
  current: ManagedStartupCloneCurrentState,
): ManagedStartupProfile["tools"]["disclosure"] {
  const value = current.toolDisclosure ?? DEFAULT_TOOL_DISCLOSURE;
  if (value !== "progressive" && value !== "direct") {
    fail("current source tool disclosure is invalid");
  }
  return value;
}

function currentWebSearch(
  profile: ManagedStartupProfile,
  current: ManagedStartupCloneCurrentState,
): Extract<ManagedStartupProfile["agentConfig"], { agent: "openclaw" | "hermes" }>["webSearch"] {
  if (profile.agentConfig.agent !== "openclaw" && profile.agentConfig.agent !== "hermes") {
    fail(`${profile.agentConfig.agent} cannot carry web-search state`);
  }
  const enabled = current.webSearchEnabled === true;
  const configuredProvider = current.webSearchProvider;
  if (
    configuredProvider !== undefined &&
    configuredProvider !== null &&
    configuredProvider !== "brave" &&
    configuredProvider !== "tavily"
  ) {
    fail("current source web-search provider is invalid");
  }
  const provider = enabled
    ? configuredProvider
    : (configuredProvider ?? profile.agentConfig.webSearch.provider);
  if (provider !== "brave" && provider !== "tavily") {
    fail("enabled current source web search has no valid provider");
  }
  if (profile.agent === "hermes" && provider !== "tavily") {
    fail("current Hermes web search must use Tavily");
  }
  return { enabled, provider };
}

function currentAgentConfig(
  profile: ManagedStartupProfile,
  current: ManagedStartupCloneCurrentState,
): ManagedStartupProfile["agentConfig"] {
  if (profile.agentConfig.agent === "pi") {
    return profile.agentConfig;
  }
  if (profile.agentConfig.agent !== "langchain-deepagents-code") {
    return {
      ...profile.agentConfig,
      webSearch: currentWebSearch(profile, current),
    };
  }
  const autoApprovalMode = current.dcodeAutoApprovalMode ?? "disabled";
  if (autoApprovalMode !== "disabled" && autoApprovalMode !== "thread-opt-in") {
    fail("current DCode auto-approval mode is invalid");
  }
  return {
    agent: "langchain-deepagents-code",
    autoApprovalMode,
    observabilityEnabled: current.observabilityEnabled === true,
  };
}

function currentSourceDashboard(
  profile: ManagedStartupProfile,
  current: ManagedStartupCloneCurrentState,
): ManagedStartupDashboard {
  if (profile.dashboard.agent === "openclaw") {
    const port =
      current.dashboardPort === undefined || current.dashboardPort === null
        ? profile.dashboard.port
        : requireDestinationPort(current.dashboardPort, profile.agent);
    const remoteBind = current.dashboardRemoteBindPrepared === true;
    if (remoteBind !== (profile.dashboard.bindAddress === "0.0.0.0")) {
      fail("current OpenClaw dashboard bind state conflicts with its managed receipt");
    }
    return {
      ...profile.dashboard,
      url: urlAtPort(profile.dashboard.url, port),
      port,
    };
  }
  if (profile.dashboard.agent === "hermes") {
    if (current.hermesDashboardEnabled === true && profile.dashboard.browserUrl === undefined) {
      fail(
        "current source Hermes dashboard has no recorded browser URL; rerun onboarding before cloning the sandbox",
      );
    }
    if (current.hermesDashboardEnabled !== true) {
      return {
        ...profile.dashboard,
        mode: "disabled",
        url: profile.dashboard.url,
        publicPort: null,
        internalPort: null,
        tuiEnabled: false,
      };
    }
    const publicPort = requireDestinationPort(
      current.hermesDashboardPort ?? current.dashboardPort ?? null,
      profile.agent,
    );
    const internalPort = requireDestinationPort(
      current.hermesDashboardInternalPort ?? null,
      profile.agent,
    );
    return {
      ...profile.dashboard,
      mode: "loopback-forwarded",
      url: urlAtPort(profile.dashboard.url, publicPort),
      ...(profile.dashboard.browserUrl === undefined
        ? {}
        : { browserUrl: rebindLoopbackDashboardUrlPort(profile.dashboard.browserUrl, publicPort) }),
      publicPort,
      internalPort,
      tuiEnabled: current.hermesDashboardTui === true,
    };
  }
  return profile.dashboard;
}

function currentMessagingPlan(current: ManagedStartupCloneCurrentState): unknown | null {
  if (current.messaging === undefined || current.messaging === null) return null;
  if (current.messaging.schemaVersion !== 1 || current.messaging.plan === undefined) {
    fail("current source messaging state is invalid");
  }
  return current.messaging.plan;
}

function reconcileCurrentSourceProfile(
  profile: ManagedStartupProfile,
  current: ManagedStartupCloneCurrentState,
): ManagedStartupProfile {
  const inference = currentInference(profile, current);
  const hermesToolGateways = current.hermesToolGateways ?? [];
  if (
    !Array.isArray(hermesToolGateways) ||
    !hermesToolGateways.every((value) => typeof value === "string")
  ) {
    fail("current Hermes tool gateways are invalid");
  }
  let reasoning = profile.tuning.reasoning;
  let reasoningEffort = profile.tuning.reasoningEffort;
  let contextWindow = profile.tuning.contextWindow;
  if (profile.agent === "openclaw") {
    const currentReasoning = current.compatibleEndpointReasoning;
    if (
      currentReasoning !== undefined &&
      currentReasoning !== null &&
      currentReasoning !== "true" &&
      currentReasoning !== "false"
    ) {
      fail("current source compatible-endpoint reasoning state is invalid");
    }
    reasoning = current.provider === "compatible-endpoint" ? currentReasoning === "true" : false;
    const currentReasoningEffort = current.compatibleEndpointReasoningEffort;
    if (
      currentReasoningEffort !== undefined &&
      currentReasoningEffort !== null &&
      currentReasoningEffort !== "low" &&
      currentReasoningEffort !== "medium" &&
      currentReasoningEffort !== "high"
    ) {
      fail("current source compatible-endpoint reasoning-effort state is invalid");
    }
    reasoningEffort =
      inference.upstreamProvider === "compatible-endpoint" && inference.api === "openai-completions"
        ? (currentReasoningEffort ?? "default")
        : "default";
    if (
      profile.inference.upstreamProvider !== current.provider ||
      profile.inference.model !== current.model
    ) {
      contextWindow = managedStartupCloneRebinderDependencies.resolveContextWindowForModel(
        requireCurrentString(current.provider, "inference provider"),
        requireCurrentString(current.model, "inference model"),
      );
      if (contextWindow === null) {
        fail("current OpenClaw inference route has no verifiable context window");
      }
    }
  }
  return validateManagedStartupProfile({
    ...profile,
    agentConfig: currentAgentConfig(profile, current),
    inference,
    dashboard: currentSourceDashboard(profile, current),
    tools: {
      disclosure: currentToolDisclosure(current),
      enabledGateways: profile.agent === "hermes" ? [...hermesToolGateways] : [],
    },
    messaging: { plan: currentMessagingPlan(current) },
    tuning: { ...profile.tuning, contextWindow, reasoning, reasoningEffort },
  });
}

function destinationDashboard(
  profile: ManagedStartupProfile,
  destinationDashboardPort: number | null,
): ManagedStartupDashboard {
  const dashboard = profile.dashboard;
  if (dashboard.agent === "openclaw") {
    const port = requireDestinationPort(destinationDashboardPort, profile.agent);
    return {
      ...dashboard,
      url: urlAtPort(dashboard.url, port),
      port,
    };
  }
  if (dashboard.agent === "hermes") {
    if (dashboard.mode === "disabled") {
      if (destinationDashboardPort === null) {
        return {
          ...dashboard,
          url: "http://127.0.0.1/",
        };
      }
      return {
        ...dashboard,
        url: urlAtPort(dashboard.url, destinationDashboardPort),
        ...(dashboard.browserUrl === undefined
          ? {}
          : {
              browserUrl: rebindLoopbackDashboardUrlPort(
                dashboard.browserUrl,
                destinationDashboardPort,
              ),
            }),
      };
    }
    const port = requireDestinationPort(destinationDashboardPort, profile.agent);
    return {
      ...dashboard,
      url: urlAtPort(dashboard.url, port),
      ...(dashboard.browserUrl === undefined
        ? {}
        : { browserUrl: rebindLoopbackDashboardUrlPort(dashboard.browserUrl, port) }),
      publicPort: port,
    };
  }
  if (destinationDashboardPort !== null) {
    fail("langchain-deepagents-code cannot accept a destination dashboard port");
  }
  return dashboard;
}

function destinationMessagingPlan(
  profile: ManagedStartupProfile,
  sourceSandboxName: string,
  destinationSandboxName: string,
): ManagedStartupJsonObject | null {
  if (profile.messaging.plan === null) return null;
  if (profile.agent === "langchain-deepagents-code" || profile.agent === "pi") {
    fail(`${profile.agent} cannot carry a messaging plan`);
  }
  const rebound = rebindSandboxMessagingPlanForClone({
    sourceSandboxName,
    destinationSandboxName,
    agent: profile.agent,
    sourcePlan: profile.messaging.plan,
    environment: {
      NEMOCLAW_PROXY_HOST: profile.proxy.managedHost,
      NEMOCLAW_PROXY_PORT: String(profile.proxy.managedPort),
    },
  });
  return JSON.parse(JSON.stringify(rebound)) as ManagedStartupJsonObject;
}

function destinationInference(
  profile: ManagedStartupProfile,
  input: ManagedStartupCloneRebindInput,
): ManagedStartupProfile["inference"] {
  if (profile.agent !== "hermes" || profile.tools.enabledGateways.length === 0) {
    return profile.inference;
  }
  const provider = requireCurrentString(
    input.destinationHermesInferenceProvider,
    "destination Hermes inference provider",
  );
  return {
    ...profile.inference,
    upstreamProvider: provider,
  };
}

/**
 * Verify a source managed receipt transport and bind its secret-free intent to
 * a newly allocated destination identity before any snapshot mutation occurs.
 */
export function rebindManagedStartupProfileForClone(
  input: ManagedStartupCloneRebindInput,
): ReboundManagedStartupClone {
  const sourceSandboxName = requireSandboxName(input.sourceSandboxName, "source");
  const destinationSandboxName = requireSandboxName(input.destinationSandboxName, "destination");
  if (sourceSandboxName === destinationSandboxName) {
    fail("source and destination sandbox names must differ");
  }
  if (
    !SHA256_PATTERN.test(input.startupProfileSha256) ||
    createHash("sha256").update(input.encodedProfile, "utf8").digest("hex") !==
      input.startupProfileSha256
  ) {
    fail("source profile transport does not match its receipt SHA-256 digest");
  }

  let sourceProfile: ManagedStartupProfile;
  try {
    sourceProfile = decodeManagedStartupProfile(input.encodedProfile);
  } catch (error) {
    fail("source profile transport is not canonical and valid", error);
  }
  if (sourceProfile.agent !== input.expectedAgent) {
    fail(`source profile targets ${sourceProfile.agent}, expected ${input.expectedAgent}`);
  }
  try {
    validateManagedStartupCorporateCaTransport(input.corporateCaB64, sourceProfile);
  } catch (error) {
    fail("source corporate CA transport does not match the profile", error);
  }

  let profile: ManagedStartupProfile;
  try {
    const currentSourceProfile = reconcileCurrentSourceProfile(sourceProfile, input.currentSource);
    profile = validateManagedStartupProfile({
      ...currentSourceProfile,
      inference: destinationInference(currentSourceProfile, input),
      dashboard: destinationDashboard(currentSourceProfile, input.destinationDashboardPort),
      messaging: {
        plan: destinationMessagingPlan(
          currentSourceProfile,
          sourceSandboxName,
          destinationSandboxName,
        ),
      },
    });
  } catch (error) {
    if (error instanceof ManagedStartupCloneRebindError) throw error;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    fail(`destination profile could not be validated${detail}`, error);
  }

  const encodedProfile = encodeManagedStartupProfile(profile);
  const startupProfileSha256 = createHash("sha256").update(encodedProfile, "utf8").digest("hex");
  return cloneAndDeepFreeze(
    input.corporateCaB64 === undefined
      ? { profile, encodedProfile, startupProfileSha256 }
      : {
          profile,
          encodedProfile,
          startupProfileSha256,
          corporateCaB64: input.corporateCaB64,
        },
  );
}
