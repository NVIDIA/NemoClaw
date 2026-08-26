// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import {
  assertRecordedPolicyAuthority,
  PolicyAuthorityRefusalError,
  type SandboxPolicyAuthority,
} from "../../../adapters/openshell/policy-authority";
import type { Session, SessionUpdates } from "../../../state/onboard-session";
import {
  getActiveChannelsFromPlan,
  getDisabledChannelsFromPlan,
} from "../../messaging-plan-session";
import { messagingChannelsForPolicyPresets } from "../../messaging-policy-presets";
import type { HostLocalInferenceSandboxProofAuthority } from "../../runtime-provider/host-local-inference-routing";
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
  policyAuthority?: SandboxPolicyAuthority;
  policyTier?: string | null;
  /** Preset names already applied to the sandbox, as recorded in the registry. */
  policies?: string[] | null;
}

export interface PolicyResumeSelection {
  policyPresets: string[];
  recordedPolicyPresetsNeedReconcile: boolean;
  disabledMessagingPolicyPresetApplied: boolean;
  suppressedAgentRequiredPresetsLive: boolean;
}

export interface PoliciesStateOptions<Agent, WebSearchConfig> {
  resume: boolean;
  /** Internal rebuild tier that takes precedence over a not-yet-complete registry row. */
  authoritativePolicyTier?: string | null;
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
  revalidatePolicyRequirements?: (operation: string) => void;
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
        recordedPolicyPresets: string[] | null;
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
      updates: { sandboxName: string; provider: string; model: string; policyPresets: string[] },
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
        revalidatePolicyRequirements?: (operation: string) => void;
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
  authoritativePolicyTier,
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
  revalidatePolicyRequirements,
  deps,
}: PoliciesStateOptions<Agent, WebSearchConfig>): Promise<PoliciesStateResult> {
  const latestSession = deps.loadSession();
  const observabilityEnabled = latestSession?.observabilityEnabled === true;
  const rawRecordedPolicyPresets = Array.isArray(latestSession?.policyPresets)
    ? latestSession.policyPresets
    : null;
  const recordedPolicyPresets = hostLocalInferenceRouteOnly
    ? (rawRecordedPolicyPresets?.filter((name) => name !== "local-inference") ?? null)
    : rawRecordedPolicyPresets;
  const recordedMessagingChannels = getActiveChannelsFromPlan(latestSession?.messagingPlan);
  const activeSandbox = deps.getActiveSandbox(sandboxName);
  const sessionPolicyAuthority = latestSession?.policyAuthority ?? null;
  const registryPolicyAuthority = activeSandbox?.policyAuthority ?? null;
  const authorityOperation = `continue policy setup for sandbox '${sandboxName}'`;
  if (sessionPolicyAuthority && registryPolicyAuthority) {
    assertRecordedPolicyAuthority(
      sessionPolicyAuthority,
      registryPolicyAuthority,
      authorityOperation,
    );
  }
  const policyAuthority = registryPolicyAuthority ?? sessionPolicyAuthority;
  if (!policyAuthority) {
    throw new PolicyAuthorityRefusalError(
      `Refusing to ${authorityOperation}: policy authority is not recorded. Resume onboarding so NemoClaw can inspect and bind the live authority.`,
    );
  }
  const externallyManagedPolicy = policyAuthority === "externally-managed";
  const effectivePolicyTier = authoritativePolicyTier ?? activeSandbox?.policyTier ?? null;
  const activePlan = activeSandbox?.messaging?.plan;
  const activeMessagingChannels = getActiveChannelsFromPlan(activePlan);
  const planDisabledChannels = getDisabledChannelsFromPlan(activePlan);
  // A channel the operator stopped configuring never reaches `disabledChannels`,
  // so without this the reused plan keeps it enabled and every later onboarding
  // run re-applies its egress preset. Adding it to `disabledChannels` here lets
  // the existing disabled-channel pruning drop the preset from both the merged
  // selection and the previously-applied set.
  //
  // The applied preset list is the third candidate source because it outlives
  // the plans: a sandbox can carry a channel's egress in `policies` after every
  // plan that named the channel is gone, and only a candidate here can retire
  // it.
  const appliedPresetMessagingChannels = messagingChannelsForPolicyPresets(activeSandbox?.policies);
  const unconfiguredMessagingChannels = deps.detectUnconfiguredMessagingChannels(
    [...recordedMessagingChannels, ...activeMessagingChannels, ...appliedPresetMessagingChannels],
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
      beforeSuccess: () =>
        revalidatePolicyRequirements?.(
          `publish verified inference route for sandbox '${sandboxName}'`,
        ),
    });
  if (externallyManagedPolicy) {
    revalidatePolicyRequirements?.(
      `verify the externally managed policy for sandbox '${sandboxName}'`,
    );
    verifySandboxInferenceRoute();
    revalidatePolicyRequirements?.(`record verified external policy for sandbox '${sandboxName}'`);
    deps.skippedStepMessage("policies", "externally managed");
    await deps.recordStateSkipped("policies", {
      reason: "externally_managed",
    });
    revalidatePolicyRequirements?.(
      `complete externally managed policy setup for sandbox '${sandboxName}'`,
    );
    const session = await deps.recordStepComplete(
      "policies",
      deps.toSessionUpdates({ sandboxName, provider, model, policyPresets: null }),
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
    recordedPolicyPresets,
    disabledChannels,
    enabledChannels: policyMessagingChannels,
    hermesToolGateways,
    agent: normalizeAgentName((agent as { name?: string } | null)?.name),
    observabilityEnabled,
    webSearchConfig,
    webSearchConfigChanged,
    webSearchSupported,
    tierName: effectivePolicyTier,
  });
  const recordedPolicyPresetsForSupport = policyResumeSelection.policyPresets;
  const staleLocalInferencePolicy =
    hostLocalInferenceRouteOnly &&
    (rawRecordedPolicyPresets?.includes("local-inference") === true ||
      deps.arePolicyPresetsApplied(sandboxName, ["local-inference"]));
  const resumePolicies =
    resume &&
    !staleLocalInferencePolicy &&
    !policyResumeSelection.recordedPolicyPresetsNeedReconcile &&
    !policyResumeSelection.disabledMessagingPolicyPresetApplied &&
    !policyResumeSelection.suppressedAgentRequiredPresetsLive &&
    deps.arePolicyPresetsApplied(sandboxName, recordedPolicyPresetsForSupport);

  let appliedPolicyPresets = recordedPolicyPresetsForSupport;
  let session: Session | null;
  // Whether the effective set was authoritatively reconciled onto the live
  // gateway, so it is safe to persist and mark final. Only a setup path that
  // runs syncPresetSelection (signalled by onSelection firing) qualifies:
  //   - the ordinary skip path (NEMOCLAW_POLICY_MODE=skip/none/no) returns []
  //     without touching the live set, so persisting [] would wipe real
  //     policies. A skip with exclusions or a missing tier-defining preset
  //     instead reconciles and persists the retained live set;
  //   - the resume path only checks recorded presets are a *subset* of what's
  //     applied (arePolicyPresetsApplied), not that the live set matches — an
  //     interrupted prior run may still have extra applied presets (e.g. an
  //     `npm` whose removal never completed), so we must not record the
  //     narrowed set as the finalized truth.
  // See #4621.
  let reflectsLiveAppliedSet = false;
  if (resumePolicies) {
    if (hostLocalInferenceRouteOnly) verifySandboxInferenceRoute();
    revalidatePolicyRequirements?.(`record resumed policy setup for sandbox '${sandboxName}'`);
    deps.skippedStepMessage("policies", recordedPolicyPresetsForSupport.join(", "));
    await deps.recordStateSkipped("policies", {
      reason: "resume",
      policyPresets: recordedPolicyPresetsForSupport,
    });
    revalidatePolicyRequirements?.(`complete resumed policy setup for sandbox '${sandboxName}'`);
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
    revalidatePolicyRequirements?.(`start policy setup for sandbox '${sandboxName}'`);
    await deps.startRecordedStep("policies", {
      sandboxName,
      provider,
      model,
      policyPresets: recordedPolicyPresetsForSupport,
    });
    revalidatePolicyRequirements?.(`apply policy presets to sandbox '${sandboxName}'`);
    appliedPolicyPresets = await deps.setupPoliciesWithSelection(sandboxName, {
      selectedPresets: Array.isArray(recordedPolicyPresets)
        ? recordedPolicyPresetsForSupport
        : null,
      enabledChannels: policyMessagingChannels,
      disabledChannels,
      webSearchConfig,
      provider: hostLocalInferenceRouteOnly ? null : provider,
      ...(hostLocalInferenceRouteOnly ? { excludedPresets: ["local-inference"] } : {}),
      // selectOnboardAgent returns null for the default OpenClaw path (no
      // --agent flag, no recorded agent). Normalise null/blank/whitespace
      // to "openclaw" so the auto-suggest gate still fires; explicit
      // Hermes runs keep their own name.
      agent: normalizeAgentName((agent as { name?: string } | null)?.name),
      observabilityEnabled,
      tierName: effectivePolicyTier,
      webSearchSupported,
      hermesToolGateways,
      revalidatePolicyRequirements,
      onSelection: (policyPresets) => {
        // onSelection fires only when a selection was reconciled to the live
        // gateway (resume reapply, non-interactive custom/suggested, the
        // interactive tier selector, or exclusion cleanup during skip). An
        // ordinary skip without exclusions returns before calling it.
        revalidatePolicyRequirements?.(
          `record selected policy presets for sandbox '${sandboxName}'`,
        );
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
    // Skipped only when no reconciliation occurred (including ordinary skip
    // without exclusions or a missing tier requirement), which leaves the live
    // applied set untouched and would otherwise be clobbered with []. See
    // #4621.
    if (reflectsLiveAppliedSet) {
      revalidatePolicyRequirements?.(`persist policy presets for sandbox '${sandboxName}'`);
      deps.persistAppliedPolicyPresets(sandboxName, appliedPolicyPresets);
    }
    if (hostLocalInferenceRouteOnly) verifySandboxInferenceRoute();
    revalidatePolicyRequirements?.(`complete policy setup for sandbox '${sandboxName}'`);
    session = await deps.recordStepComplete(
      "policies",
      deps.toSessionUpdates({
        sandboxName,
        provider,
        model,
        policyPresets: appliedPolicyPresets,
      }),
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
