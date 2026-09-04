// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { rebindLoopbackDashboardUrlPort } from "../../../dashboard/url";
import { resolveContextWindowForModel } from "../../../inference/context-window";
import type { SandboxMessagingPlan } from "../../../messaging";
import { shouldManageDashboardForAgent } from "../../../onboard/dashboard-runtime";
import { resolveHermesDashboardOnboardState } from "../../../onboard/hermes-dashboard";
import { resolveManagedStartupInferenceRoute } from "../../../onboard/inference-route";
import {
  type ManagedWorkloadRebuildCatalogHandoff,
  type ManagedWorkloadRebuildHandoff,
  stageManagedWorkloadRebuildProfile,
} from "../../../onboard/workload/rebuild";
import type { RebuildRecreateOnboardOpts } from "../rebuild-gpu-opt-out";
import type { RebuildTargetConfig } from "../rebuild-target-preflight";

export const managedRebuildProfileDependencies = {
  resolveContextWindowForModel,
  resolveManagedStartupInferenceRoute,
};

type ManagedStartupInferenceApi = "openai-completions" | "openai-responses" | "anthropic-messages";

function requireManagedStartupInferenceApi(api: string): ManagedStartupInferenceApi {
  switch (api) {
    case "openai-completions":
    case "openai-responses":
    case "anthropic-messages":
      return api;
    default:
      throw new Error(`Unsupported managed startup inference API '${api}'.`);
  }
}

export function resolveManagedRebuildOpenClawReasoning(
  provider: string,
  compatibleEndpointReasoning: "true" | "false" | null,
): boolean {
  return provider === "compatible-endpoint" && compatibleEndpointReasoning === "true";
}

export function resolveManagedRebuildOpenClawReasoningEffort(
  provider: string,
  inferenceApi: string,
  compatibleEndpointReasoningEffort: "low" | "medium" | "high" | null,
): "default" | "low" | "medium" | "high" {
  return provider === "compatible-endpoint" && inferenceApi === "openai-completions"
    ? (compatibleEndpointReasoningEffort ?? "default")
    : "default";
}

/** Render the exact replacement profile while the old managed workload remains authoritative. */
export function prepareManagedRebuildProfileHandoff(input: {
  readonly catalogHandoff: ManagedWorkloadRebuildCatalogHandoff;
  readonly targetConfig: RebuildTargetConfig;
  readonly recreateOptions: RebuildRecreateOnboardOpts;
  readonly messagingPlan: SandboxMessagingPlan | null;
  readonly environment?: NodeJS.ProcessEnv;
}): ManagedWorkloadRebuildHandoff {
  const { catalogHandoff, targetConfig, recreateOptions, messagingPlan } = input;
  const agent = catalogHandoff.agent;
  const { resumeConfig, durableConfig } = targetConfig;
  const manageDashboard = shouldManageDashboardForAgent(targetConfig.agentDefinition);
  const effectiveDashboardPort = manageDashboard ? (recreateOptions.controlUiPort ?? 0) : 0;
  const previousDashboard = catalogHandoff.previousProfile.dashboard;
  const previousHermesBrowserUrl =
    agent === "hermes" && previousDashboard.agent === "hermes"
      ? previousDashboard.browserUrl
      : undefined;
  const hermesDashboardState = resolveHermesDashboardOnboardState({
    agentName: agent,
    effectivePort: effectiveDashboardPort,
    env: input.environment ?? process.env,
  });
  if (
    agent === "hermes" &&
    manageDashboard &&
    hermesDashboardState.enabled &&
    previousHermesBrowserUrl === undefined
  ) {
    throw new Error(
      "Cannot rebuild the Hermes dashboard because its managed startup profile has no recorded browser URL. Rerun onboarding, then rebuild the sandbox.",
    );
  }
  const chatUiUrl = manageDashboard
    ? previousHermesBrowserUrl === undefined
      ? `http://127.0.0.1:${String(effectiveDashboardPort)}`
      : rebindLoopbackDashboardUrlPort(previousHermesBrowserUrl, effectiveDashboardPort)
    : "";
  const inference = managedRebuildProfileDependencies.resolveManagedStartupInferenceRoute(
    agent,
    resumeConfig.provider,
    resumeConfig.model,
    resumeConfig.preferredInferenceApi,
  );
  const upstreamProvider =
    agent === "hermes" && resumeConfig.provider === "hermes-provider"
      ? catalogHandoff.previousProfile.inference.upstreamProvider
      : resumeConfig.provider;
  const currentOpenClawContextWindow =
    agent === "openclaw"
      ? managedRebuildProfileDependencies.resolveContextWindowForModel(
          resumeConfig.provider,
          resumeConfig.model,
        )
      : null;
  if (
    agent === "openclaw" &&
    currentOpenClawContextWindow === null &&
    (catalogHandoff.previousProfile.inference.model !== resumeConfig.model ||
      catalogHandoff.previousProfile.inference.upstreamProvider !== resumeConfig.provider)
  ) {
    throw new Error(
      `Cannot determine a context window for the current OpenClaw target '${resumeConfig.provider}/${resumeConfig.model}'.`,
    );
  }

  return stageManagedWorkloadRebuildProfile(
    catalogHandoff,
    {
      inference: {
        routeProvider: inference.providerKey,
        upstreamProvider,
        model: resumeConfig.model,
        routedBaseUrl: inference.inferenceBaseUrl,
        upstreamEndpointUrl:
          agent === "langchain-deepagents-code" ? resumeConfig.endpointUrl : null,
        api: requireManagedStartupInferenceApi(inference.inferenceApi),
        primaryModelRef: agent === "openclaw" ? inference.primaryModelRef : null,
        compatibility: agent === "openclaw" ? (inference.inferenceCompat ?? {}) : null,
      },
      chatUiUrl,
      effectiveDashboardPort,
      manageDashboard,
      dashboardBindAddress:
        previousDashboard.agent === "openclaw" && previousDashboard.bindAddress === "0.0.0.0"
          ? "0.0.0.0"
          : undefined,
      wslExposure: previousDashboard.agent === "openclaw" && previousDashboard.wslExposure,
      hermesDashboardState,
      webSearch: durableConfig.webSearchConfig,
      toolDisclosure: recreateOptions.toolDisclosure,
      hermesToolGateways: targetConfig.hermesToolGateways,
      messagingPlan,
      dcodeAutoApprovalMode: recreateOptions.dcodeAutoApprovalMode,
      observabilityEnabled: recreateOptions.observabilityEnabled,
    },
    input.environment,
    agent === "openclaw"
      ? {
          ...(currentOpenClawContextWindow === null
            ? {}
            : { openClawContextWindow: currentOpenClawContextWindow }),
          openClawReasoning: resolveManagedRebuildOpenClawReasoning(
            resumeConfig.provider,
            resumeConfig.compatibleEndpointReasoning,
          ),
          openClawReasoningEffort: resolveManagedRebuildOpenClawReasoningEffort(
            resumeConfig.provider,
            inference.inferenceApi,
            resumeConfig.compatibleEndpointReasoningEffort,
          ),
        }
      : {},
  );
}
