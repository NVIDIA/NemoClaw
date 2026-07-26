// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import type { PoliciesStateOptions } from "./policies";

export type PolicyTestAgent = { name: string } | null;
export type PolicyTestWebSearchConfig = { fetchEnabled: true };
type MessagingPlan = NonNullable<Session["messagingPlan"]>;
type MessagingChannelId = MessagingPlan["channels"][number]["channelId"];

export function makeMessagingPlan(
  sandboxName: string,
  channels: readonly MessagingChannelId[],
  disabledChannels: readonly MessagingChannelId[] = [],
): MessagingPlan {
  const disabled = new Set(disabledChannels);
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: channels.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "token-paste",
      active: !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      inputs: [],
      hooks: [],
    })),
    disabledChannels,
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

export function createPolicyHandlerDeps(
  overrides: Partial<PoliciesStateOptions<PolicyTestAgent, PolicyTestWebSearchConfig>["deps"]> = {},
) {
  let session = createSession();
  const calls = {
    load: vi.fn(() => session),
    activeSandbox: vi.fn(() => ({
      messaging: { plan: makeMessagingPlan("my-assistant", ["telegram"]) },
    })),
    mergeChannels: vi.fn(
      (selected: string[], recorded: string[], active: string[] | null | undefined) =>
        selected.length > 0 ? selected : (active ?? recorded),
    ),
    smoke: vi.fn(),
    prepareResume: vi.fn(
      (
        _sandboxName: string,
        options: Parameters<
          PoliciesStateOptions<
            PolicyTestAgent,
            PolicyTestWebSearchConfig
          >["deps"]["preparePolicyPresetResumeSelection"]
        >[1],
      ) => ({
        policyPresets: (options.recordedPolicyPresets ?? []).filter(
          (name) => name !== "unsupported",
        ),
        recordedPolicyPresetsNeedReconcile: (options.recordedPolicyPresets ?? []).includes(
          "unsupported",
        ),
        disabledMessagingPolicyPresetApplied: false,
        suppressedAgentRequiredPresetsLive: false,
      }),
    ),
    appliedCheck: vi.fn(() => false),
    skipped: vi.fn(),
    recordSkip: vi.fn(async () => session),
    startStep: vi.fn(async () => undefined),
    setupPolicies: vi.fn(async () => ["npm"]),
    updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
      session = mutator(session) ?? session;
      return session;
    }),
    complete: vi.fn(async () => session),
    persistPolicies: vi.fn((_sandboxName: string, _appliedPolicyPresets: string[]) => undefined),
  };
  return {
    calls,
    deps: {
      loadSession: calls.load,
      getActiveSandbox: calls.activeSandbox,
      mergePolicyMessagingChannels: calls.mergeChannels,
      verifyCompatibleEndpointSandboxSmoke: calls.smoke,
      preparePolicyPresetResumeSelection: calls.prepareResume,
      arePolicyPresetsApplied: calls.appliedCheck,
      skippedStepMessage: calls.skipped,
      recordStateSkipped: calls.recordSkip,
      startRecordedStep: calls.startStep,
      setupPoliciesWithSelection: calls.setupPolicies,
      updateSession: calls.updateSession,
      recordStepComplete: calls.complete,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      persistAppliedPolicyPresets: calls.persistPolicies,
      ...overrides,
    },
    setSession(next: Session) {
      session = next;
    },
    getSession: () => session,
  };
}

export function basePolicyHandlerOptions(
  deps: PoliciesStateOptions<PolicyTestAgent, PolicyTestWebSearchConfig>["deps"],
): PoliciesStateOptions<PolicyTestAgent, PolicyTestWebSearchConfig> {
  return {
    resume: false,
    sandboxName: "my-assistant",
    provider: "provider",
    model: "model",
    endpointUrl: "https://example.com/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    selectedMessagingChannels: [],
    webSearchConfig: null,
    webSearchSupported: true,
    hermesToolGateways: [],
    agent: null,
    deps,
  };
}
