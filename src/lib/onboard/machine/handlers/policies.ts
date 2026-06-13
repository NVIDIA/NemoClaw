// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import type { Session, SessionUpdates } from "../../../state/onboard-session";
import {
  getActiveChannelsFromPlan,
  getDisabledChannelsFromPlan,
} from "../../messaging-plan-session";
import { advanceTo, type OnboardStateTransitionResult } from "../result";

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
  messaging?: { plan: SandboxMessagingPlan } | null;
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
        agent?: string | null;
        webSearchConfig: WebSearchConfig | null;
        webSearchSupported: boolean;
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
    // Persist the operator's effective policy preset selection back to the
    // sandbox registry. The sandbox is registered earlier with only the
    // create-time/boot presets (messaging/Hermes setup), so without this
    // write-back the registry keeps a stale `policies` list and recreate /
    // re-onboard reintroduces removed tier defaults (e.g. a removed Balanced
    // `npm`). See #4621.
    persistAppliedPolicyPresets(sandboxName: string, appliedPolicyPresets: string[]): void;
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
  const recordedMessagingChannels = getActiveChannelsFromPlan(latestSession?.messagingPlan) ?? [];
  const activeSandbox = deps.getActiveSandbox(sandboxName);
  const activePlan = activeSandbox?.messaging?.plan;
  const activeMessagingChannels = getActiveChannelsFromPlan(activePlan);
  const disabledChannels = getDisabledChannelsFromPlan(activePlan);
  const policyMessagingChannels = deps.mergePolicyMessagingChannels(
    selectedMessagingChannels,
    recordedMessagingChannels,
    activeMessagingChannels,
    disabledChannels,
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
    disabledChannels,
    enabledChannels: policyMessagingChannels,
    hermesToolGateways,
    agent: normalizeAgentName((agent as { name?: string } | null)?.name),
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
  // Whether the effective set was authoritatively reconciled onto the live
  // gateway, so it is safe to persist and mark final. Only the setup path that
  // runs syncPresetSelection (signalled by onSelection firing) qualifies:
  //   - the skip path (NEMOCLAW_POLICY_MODE=skip/none/no) returns [] without
  //     touching the live set, so persisting [] would wipe real policies;
  //   - the resume path only checks recorded presets are a *subset* of what's
  //     applied (arePolicyPresetsApplied), not that the live set matches — an
  //     interrupted prior run may still have extra applied presets (e.g. an
  //     `npm` whose removal never completed), so we must not record the
  //     narrowed set as the finalized truth.
  // See #4621.
  let reflectsLiveAppliedSet = false;
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
      disabledChannels,
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
        // onSelection fires only when a selection was reconciled to the live
        // gateway (resume reapply, non-interactive custom/suggested, or the
        // interactive tier selector). The skip path returns before calling it.
        reflectsLiveAppliedSet = true;
        deps.updateSession((current) => {
          current.policyPresets = policyPresets;
          return current;
        });
      },
    });
    // Reconcile the registry with the *effective* preset selection so a later
    // recreate/re-onboard carries the operator's exact set forward instead of
    // reapplying stale tier defaults. Done *before* recordStepComplete so an
    // interruption can't leave a completed-resumable session without the
    // finalized marker (--resume would then skip the persist permanently).
    // Skipped for the skip path (onSelection never fired), which leaves the live
    // applied set untouched and would otherwise be clobbered with []. See #4621.
    if (reflectsLiveAppliedSet) {
      deps.persistAppliedPolicyPresets(sandboxName, appliedPolicyPresets);
    }
    session = await deps.recordStepComplete(
      "policies",
      deps.toSessionUpdates({ sandboxName, provider, model, policyPresets: appliedPolicyPresets }),
    );
  }

  return {
    session,
    recordedMessagingChannels,
    selectedMessagingChannels: policyMessagingChannels,
    appliedPolicyPresets,
    stateResult: advanceTo("finalizing", {
      metadata: { state: "policies", policyPresets: appliedPolicyPresets },
    }),
  };
}
