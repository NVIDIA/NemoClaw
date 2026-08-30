// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import type { Session, SessionUpdates } from "../../../state/onboard-session";
import { normalizeAgentNameForResumeState } from "../../agent-resume-state";
import {
  getActiveChannelsFromPlan,
  getDisabledChannelsFromPlan,
} from "../../messaging-plan-session";
import type { HostLocalInferenceSandboxProofAuthority } from "../../runtime-provider/host-local-inference-routing";
import { advanceTo, type OnboardStateTransitionResult } from "../result";

export interface PolicyPresetEntry {
  name: string;
  [key: string]: unknown;
}

export interface ActiveSandboxPolicyState {
  messaging?: { plan: SandboxMessagingPlan } | null;
}

export interface PolicyResumeSelection {
  policyPresets: string[];
  livePolicyPresetsNeedUpdate: boolean;
  disabledMessagingPolicyPresetApplied: boolean;
  suppressedAgentRequiredPresetsLive: boolean;
}

export interface PoliciesStateOptions<Agent, WebSearchConfig> {
  resume: boolean;
  preserveRebuildLivePolicy?: boolean;
  sandboxName: string;
  provider: string;
  hostLocalInferenceRouteOnly?: boolean;
  hostLocalInferenceSandboxProofAuthority?: HostLocalInferenceSandboxProofAuthority | null;
  model: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  selectedMessagingChannels: string[];
  webSearchConfig: WebSearchConfig | null;
  webSearchConfigChanged?: boolean;
  webSearchSupported: boolean;
  hermesToolGateways: string[];
  agent: Agent;
  deps: {
    loadSession(): Session | null;
    getActiveSandbox(sandboxName: string): ActiveSandboxPolicyState | null | undefined;
    mergePolicyMessagingChannels(
      selectedMessagingChannels: string[],
      recordedMessagingChannels: string[],
      activeMessagingChannels: string[] | null | undefined,
      disabledChannels: string[] | null | undefined,
    ): string[];
    detectUnconfiguredMessagingChannels(
      planChannels: readonly string[],
      selectedChannels: readonly string[],
      agent: Agent,
    ): string[];
    verifyCompatibleEndpointSandboxSmoke(options: {
      sandboxName: string;
      provider: string;
      model: string;
      endpointUrl: string | null;
      credentialEnv: string | null;
      messagingChannels: string[];
      agent: Agent;
      forceCanonicalRoute?: boolean;
      hostLocalInferenceProofAuthority?: HostLocalInferenceSandboxProofAuthority;
      beforeSuccess?: () => void;
    }): void;
    preparePolicyPresetResumeSelection(
      sandboxName: string,
      options: {
        disabledChannels: string[] | null | undefined;
        enabledChannels: string[];
        hermesToolGateways: string[];
        agent?: string | null;
        observabilityEnabled?: boolean | null;
        webSearchConfig: WebSearchConfig | null;
        webSearchConfigChanged: boolean;
        webSearchSupported: boolean;
        tierName?: string | null;
      },
    ): PolicyResumeSelection;
    arePolicyPresetsApplied(sandboxName: string, selectedPresets: string[]): boolean;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    recordStateSkipped(
      state: "policies",
      metadata?: Record<string, unknown> | null,
    ): Promise<Session>;
    startRecordedStep(
      stepName: string,
      updates: { sandboxName: string; provider: string; model: string },
    ): Promise<void>;
    setupPoliciesWithSelection(
      sandboxName: string,
      options: {
        selectedPresets: string[] | null;
        enabledChannels: string[];
        disabledChannels?: string[] | null;
        webSearchConfig: WebSearchConfig | null;
        provider: string | null;
        excludedPresets?: readonly string[];
        agent?: string | null;
        observabilityEnabled?: boolean | null;
        tierName?: string | null;
        webSearchSupported: boolean;
        hermesToolGateways: string[];
        onSelection: (policyPresets: string[]) => void;
      },
    ): Promise<string[]>;
    recordStepComplete(stepName: string, updates: SessionUpdates): Promise<Session>;
    toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
  };
}

export interface PoliciesStateResult {
  session: Session | null;
  recordedMessagingChannels: string[];
  selectedMessagingChannels: string[];
  appliedPolicyPresets: string[];
  stateResult: OnboardStateTransitionResult;
}

export async function handlePoliciesState<Agent, WebSearchConfig>({
  resume,
  preserveRebuildLivePolicy = false,
  sandboxName,
  provider,
  hostLocalInferenceRouteOnly = false,
  hostLocalInferenceSandboxProofAuthority = null,
  model,
  endpointUrl,
  credentialEnv,
  selectedMessagingChannels,
  webSearchConfig,
  webSearchConfigChanged = false,
  webSearchSupported,
  hermesToolGateways,
  agent,
  deps,
}: PoliciesStateOptions<Agent, WebSearchConfig>): Promise<PoliciesStateResult> {
  const latestSession = deps.loadSession();
  const observabilityEnabled = latestSession?.observabilityEnabled === true;
  const recordedMessagingChannels = getActiveChannelsFromPlan(latestSession?.messagingPlan);
  const activeSandbox = deps.getActiveSandbox(sandboxName);
  const activePlan = activeSandbox?.messaging?.plan;
  const activeMessagingChannels = getActiveChannelsFromPlan(activePlan);
  const planDisabledChannels = getDisabledChannelsFromPlan(activePlan);
  // A channel the operator stopped configuring never reaches `disabledChannels`,
  // so without this the reused plan keeps it enabled and every later onboarding
  // run re-applies its egress preset. Adding it to `disabledChannels` here lets
  // the existing disabled-channel pruning drop the preset from both the merged
  // selection and the previously-applied set.
  //
  const unconfiguredMessagingChannels = deps.detectUnconfiguredMessagingChannels(
    [...recordedMessagingChannels, ...activeMessagingChannels],
    selectedMessagingChannels,
    agent,
  );
  const disabledChannels =
    unconfiguredMessagingChannels.length > 0
      ? [...new Set([...planDisabledChannels, ...unconfiguredMessagingChannels])]
      : planDisabledChannels;
  const policyMessagingChannels = deps.mergePolicyMessagingChannels(
    selectedMessagingChannels,
    recordedMessagingChannels,
    activeMessagingChannels,
    disabledChannels,
  );
  const verifySandboxInferenceRoute = () =>
    deps.verifyCompatibleEndpointSandboxSmoke({
      sandboxName,
      provider,
      model,
      endpointUrl,
      credentialEnv,
      messagingChannels: policyMessagingChannels,
      agent,
      ...(hostLocalInferenceRouteOnly ? { forceCanonicalRoute: true } : {}),
      ...(hostLocalInferenceRouteOnly
        ? { hostLocalInferenceProofAuthority: hostLocalInferenceSandboxProofAuthority ?? undefined }
        : {}),
    });
  if (preserveRebuildLivePolicy) {
    verifySandboxInferenceRoute();
    deps.skippedStepMessage("policies", "live OpenShell rebuild policy");
    await deps.recordStateSkipped("policies", {
      reason: "rebuild-live-policy",
    });
    const session = await deps.recordStepComplete(
      "policies",
      deps.toSessionUpdates({
        sandboxName,
        provider,
        model,
      }),
    );
    return {
      session,
      recordedMessagingChannels,
      selectedMessagingChannels: policyMessagingChannels,
      appliedPolicyPresets: [],
      stateResult: advanceTo("finalizing", {
        metadata: { state: "policies" },
      }),
    };
  }
  if (!hostLocalInferenceRouteOnly) verifySandboxInferenceRoute();

  const policyResumeSelection = deps.preparePolicyPresetResumeSelection(sandboxName, {
    disabledChannels,
    enabledChannels: policyMessagingChannels,
    hermesToolGateways,
    agent: normalizeAgentNameForResumeState((agent as { name?: string } | null)?.name),
    observabilityEnabled,
    webSearchConfig,
    webSearchConfigChanged,
    webSearchSupported,
    tierName: null,
  });
  const livePolicyPresetsForSupport = policyResumeSelection.policyPresets;
  const staleLocalInferencePolicy =
    hostLocalInferenceRouteOnly && deps.arePolicyPresetsApplied(sandboxName, ["local-inference"]);
  const resumePolicies =
    resume &&
    !staleLocalInferencePolicy &&
    !policyResumeSelection.livePolicyPresetsNeedUpdate &&
    !policyResumeSelection.disabledMessagingPolicyPresetApplied &&
    !policyResumeSelection.suppressedAgentRequiredPresetsLive &&
    deps.arePolicyPresetsApplied(sandboxName, livePolicyPresetsForSupport);

  let appliedPolicyPresets = livePolicyPresetsForSupport;
  let session: Session | null;
  if (resumePolicies) {
    if (hostLocalInferenceRouteOnly) verifySandboxInferenceRoute();
    deps.skippedStepMessage("policies", livePolicyPresetsForSupport.join(", "));
    await deps.recordStateSkipped("policies", {
      reason: "resume",
    });
    session = await deps.recordStepComplete(
      "policies",
      deps.toSessionUpdates({
        sandboxName,
        provider,
        model,
      }),
    );
  } else {
    await deps.startRecordedStep("policies", {
      sandboxName,
      provider,
      model,
    });
    appliedPolicyPresets = await deps.setupPoliciesWithSelection(sandboxName, {
      selectedPresets: resume ? livePolicyPresetsForSupport : null,
      enabledChannels: policyMessagingChannels,
      disabledChannels,
      webSearchConfig,
      provider: hostLocalInferenceRouteOnly ? null : provider,
      ...(hostLocalInferenceRouteOnly ? { excludedPresets: ["local-inference"] } : {}),
      // selectOnboardAgent returns null for the default OpenClaw path (no
      // --agent flag, no recorded agent). Normalise null/blank/whitespace
      // to "openclaw" so the auto-suggest gate still fires; explicit
      // Hermes runs keep their own name.
      agent: normalizeAgentNameForResumeState((agent as { name?: string } | null)?.name),
      observabilityEnabled,
      tierName: null,
      webSearchSupported,
      hermesToolGateways,
      onSelection: () => undefined,
    });
    if (hostLocalInferenceRouteOnly) verifySandboxInferenceRoute();
    session = await deps.recordStepComplete(
      "policies",
      deps.toSessionUpdates({
        sandboxName,
        provider,
        model,
      }),
    );
  }

  return {
    session,
    recordedMessagingChannels,
    selectedMessagingChannels: policyMessagingChannels,
    appliedPolicyPresets,
    stateResult: advanceTo("finalizing", {
      metadata: { state: "policies" },
    }),
  };
}
