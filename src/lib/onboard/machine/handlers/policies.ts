// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session, SessionUpdates } from "../../../state/onboard-session";

// Inlined to avoid pulling sandbox-agent's transitive runner.ts deps into
// the generic state handler. Matches normalizeSandboxAgentName: trim,
// default null/blank/"openclaw" to "openclaw".
function normalizeAgentName(name: string | null | undefined): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed && trimmed !== "openclaw" ? trimmed : "openclaw";
}

export interface PolicyPresetEntry {
  name: string;
  [key: string]: unknown;
}

export interface ActiveSandboxPolicyState {
  messagingChannels?: string[] | null;
  disabledChannels?: string[] | null;
}

export interface PolicyResumeSelection {
  policyPresets: string[];
  recordedPolicyPresetsNeedReconcile: boolean;
  disabledMessagingPolicyPresetApplied: boolean;
}

export interface PoliciesStateOptions<Agent, WebSearchConfig> {
  resume: boolean;
  sandboxName: string;
  provider: string;
  model: string;
  endpointUrl: string | null;
  credentialEnv: string | null;
  selectedMessagingChannels: string[];
  webSearchConfig: WebSearchConfig | null;
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
    verifyCompatibleEndpointSandboxSmoke(options: {
      sandboxName: string;
      provider: string;
      model: string;
      endpointUrl: string | null;
      credentialEnv: string | null;
      messagingChannels: string[];
      agent: Agent;
    }): void;
    preparePolicyPresetResumeSelection(
      sandboxName: string,
      options: {
        recordedPolicyPresets: string[] | null;
        disabledChannels: string[] | null | undefined;
        enabledChannels: string[];
        hermesToolGateways: string[];
        webSearchConfig: WebSearchConfig | null;
        webSearchSupported: boolean;
      },
    ): PolicyResumeSelection;
    arePolicyPresetsApplied(sandboxName: string, selectedPresets: string[]): boolean;
    skippedStepMessage(stepName: string, detail?: string | null): void;
    recordStateSkipped(state: "policies", metadata?: Record<string, unknown> | null): Promise<Session>;
    startRecordedStep(
      stepName: string,
      updates: { sandboxName: string; provider: string; model: string; policyPresets: string[] },
    ): Promise<void>;
    setupPoliciesWithSelection(
      sandboxName: string,
      options: {
        selectedPresets: string[] | null;
        enabledChannels: string[];
        disabledChannels?: string[] | null;
        webSearchConfig: WebSearchConfig | null;
        provider: string;
        agent?: string | null;
        webSearchSupported: boolean;
        hermesToolGateways: string[];
        onSelection: (policyPresets: string[]) => void;
      },
    ): Promise<string[]>;
    updateSession(mutator: (session: Session) => Session | void): Session;
    recordStepComplete(stepName: string, updates: SessionUpdates): Promise<Session>;
    toSessionUpdates(updates: Record<string, unknown>): SessionUpdates;
  };
}

export interface PoliciesStateResult {
  session: Session | null;
  recordedMessagingChannels: string[];
  appliedPolicyPresets: string[];
}

export async function handlePoliciesState<Agent, WebSearchConfig>({
  resume,
  sandboxName,
  provider,
  model,
  endpointUrl,
  credentialEnv,
  selectedMessagingChannels,
  webSearchConfig,
  webSearchSupported,
  hermesToolGateways,
  agent,
  deps,
}: PoliciesStateOptions<Agent, WebSearchConfig>): Promise<PoliciesStateResult> {
  const latestSession = deps.loadSession();
  const recordedPolicyPresets = Array.isArray(latestSession?.policyPresets)
    ? latestSession.policyPresets
    : null;
  const recordedMessagingChannels = Array.isArray(latestSession?.messagingChannels)
    ? latestSession.messagingChannels
    : [];
  const activeSandbox = deps.getActiveSandbox(sandboxName);
  const policyMessagingChannels = deps.mergePolicyMessagingChannels(
    selectedMessagingChannels,
    recordedMessagingChannels,
    activeSandbox?.messagingChannels,
    activeSandbox?.disabledChannels,
  );
  deps.verifyCompatibleEndpointSandboxSmoke({
    sandboxName,
    provider,
    model,
    endpointUrl,
    credentialEnv,
    messagingChannels: policyMessagingChannels,
    agent,
  });

  const policyResumeSelection = deps.preparePolicyPresetResumeSelection(sandboxName, {
    recordedPolicyPresets,
    disabledChannels: activeSandbox?.disabledChannels,
    enabledChannels: policyMessagingChannels,
    hermesToolGateways,
    webSearchConfig,
    webSearchSupported,
  });
  const recordedPolicyPresetsForSupport = policyResumeSelection.policyPresets;
  const resumePolicies =
    resume &&
    !policyResumeSelection.recordedPolicyPresetsNeedReconcile &&
    !policyResumeSelection.disabledMessagingPolicyPresetApplied &&
    deps.arePolicyPresetsApplied(sandboxName, recordedPolicyPresetsForSupport);

  let appliedPolicyPresets = recordedPolicyPresetsForSupport;
  let session: Session | null;
  if (resumePolicies) {
    deps.skippedStepMessage("policies", recordedPolicyPresetsForSupport.join(", "));
    await deps.recordStateSkipped("policies", {
      reason: "resume",
      policyPresets: recordedPolicyPresetsForSupport,
    });
    session = await deps.recordStepComplete(
      "policies",
      deps.toSessionUpdates({
        sandboxName,
        provider,
        model,
        policyPresets: recordedPolicyPresetsForSupport,
      }),
    );
  } else {
    await deps.startRecordedStep("policies", {
      sandboxName,
      provider,
      model,
      policyPresets: recordedPolicyPresetsForSupport,
    });
    appliedPolicyPresets = await deps.setupPoliciesWithSelection(sandboxName, {
      selectedPresets: Array.isArray(recordedPolicyPresets)
        ? recordedPolicyPresetsForSupport
        : null,
      enabledChannels: policyMessagingChannels,
      disabledChannels: activeSandbox?.disabledChannels,
      webSearchConfig,
      provider,
      // selectOnboardAgent returns null for the default OpenClaw path (no
      // --agent flag, no recorded agent). Normalise null/blank/whitespace
      // to "openclaw" so the auto-suggest gate still fires; explicit
      // Hermes runs keep their own name.
      agent: normalizeAgentName((agent as { name?: string } | null)?.name),
      webSearchSupported,
      hermesToolGateways,
      onSelection: (policyPresets) => {
        deps.updateSession((current) => {
          current.policyPresets = policyPresets;
          return current;
        });
      },
    });
    session = await deps.recordStepComplete(
      "policies",
      deps.toSessionUpdates({ sandboxName, provider, model, policyPresets: appliedPolicyPresets }),
    );
  }

  return { session, recordedMessagingChannels, appliedPolicyPresets };
}
