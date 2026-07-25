// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import { hashCredential } from "../../../security/credential-hash";
import { decisionSelected, decisionUnset } from "../../../state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type OnboardCheckpoint,
} from "../../../state/onboard-checkpoint-types";
import { createSession, type Session } from "../../../state/onboard-session";
import { reconcileReusedSandboxMessaging, reconcileSandboxMessaging } from "./sandbox-messaging";

const channelIds = ["telegram", "unsupported"];

function mixedChannelPlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "onboard",
    channels: channelIds.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "token-paste",
      active: channelId === "telegram",
      selected: true,
      configured: true,
      disabled: channelId !== "telegram",
      inputs: [],
      hooks: [],
    })),
    disabledChannels: ["unsupported"],
    credentialBindings: channelIds.map((channelId) => ({
      channelId,
      credentialId: "token",
      sourceInput: "token",
      providerName: `alpha-${channelId}`,
      providerEnvKey: `${channelId.toUpperCase()}_TOKEN`,
      placeholder: `openshell:resolve:env:${channelId.toUpperCase()}_TOKEN`,
      credentialAvailable: true,
    })),
    networkPolicy: {
      presets: [...channelIds],
      entries: channelIds.map((channelId) => ({
        channelId,
        presetName: channelId,
        policyKeys: [`${channelId}_api`],
        source: "manifest",
      })),
    },
    agentRender: channelIds.map((channelId) => ({
      channelId,
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      path: `channels.${channelId}`,
      value: { enabled: true },
      templateRefs: [],
    })),
    buildSteps: channelIds.map((channelId) => ({
      channelId,
      kind: "build-arg",
      outputId: `${channelId}-arg`,
      required: true,
      value: "enabled",
    })),
    runtimeSetup: {
      nodePreloads: channelIds.map((channelId) => ({
        channelId,
        module: `${channelId}-preload`,
        source: "manifest",
        target: "agent",
      })),
      envAliases: channelIds.map((channelId) => ({
        channelId,
        envKey: `${channelId.toUpperCase()}_TOKEN`,
        match: "source",
        value: "target",
      })),
      secretScans: channelIds.map((channelId) => ({
        channelId,
        path: `/sandbox/${channelId}`,
        pattern: "secret",
        message: "secret found",
      })),
    },
    stateUpdates: channelIds.map((channelId) => ({
      channelId,
      kind: "persist-inputs",
      stateKey: `${channelId}Config`,
      inputIds: ["token"],
    })),
    healthChecks: channelIds.map((channelId) => ({
      channelId,
      phase: "health-check",
      requiredBefore: "lifecycle-success",
      hookIds: [`${channelId}-health`],
    })),
  };
}

function channelIdsFrom<T extends { readonly channelId: string }>(entries: readonly T[]): string[] {
  return entries.map((entry) => entry.channelId);
}

function telegramPlan(credentialHash: string): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "onboard",
    channels: [
      {
        channelId: "telegram",
        displayName: "Telegram",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [
      {
        channelId: "telegram",
        credentialId: "botToken",
        sourceInput: "botToken",
        providerName: "alpha-telegram-bridge",
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
        credentialHash,
      },
    ],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function completedCheckpointSession(
  plan: SandboxMessagingPlan,
  stagedCredentialProviders: string[] = [],
) {
  const session = createSession();
  session.sandboxName = plan.sandboxName;
  session.messagingPlan = plan;
  session.stagedCredentialProviders = stagedCredentialProviders;
  session.sandboxPromptProgress.sandboxName = true;
  session.sandboxPromptProgress.messaging = true;
  return session;
}

function withMessagingCheckpoint(
  session: Session,
  selectedChannels: string[],
  disabledChannels: string[] = [],
): Session {
  const checkpoint: OnboardCheckpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: session.sessionId,
    machineState: session.machine.state,
    updatedAt: "2026-01-01T00:00:00.000Z",
    sandboxIdentity: decisionUnset(),
    webSearch: decisionUnset(),
    messaging: decisionSelected({ selectedChannels, disabledChannels }),
    resourceProfile: decisionUnset(),
    gatewayAuthority: decisionUnset(),
    effectGroups: {},
    bindings: { credentialEnvs: [], registeredProviders: [] },
  };
  session.checkpoint = checkpoint;
  return session;
}

function reconcileDeps(plans: readonly (SandboxMessagingPlan | null)[]) {
  return {
    note: vi.fn(),
    showMessagingStage: vi.fn(),
    getRecordedMessagingChannelsForResume: vi.fn(() => null),
    setupMessagingChannels: vi.fn(
      async (
        _agent: unknown,
        _existingChannels: string[] | null,
        _sandboxName: string,
        _options?: { readonly selectionCompleted?: boolean },
      ) => ["telegram"],
    ),
    readMessagingPlanFromEnv: vi
      .fn()
      .mockReturnValueOnce(plans[0] ?? null)
      .mockReturnValue(plans[1] ?? plans[0] ?? null),
    writePlanToEnv: vi.fn(),
    clearPlanEnv: vi.fn(),
    getRegistrySandboxMessagingPlan: vi.fn(() => null),
    providerMatchesGatewayCredential: vi.fn(() => false),
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("reconcileReusedSandboxMessaging", () => {
  it("removes every unsupported channel artifact from a reused plan", () => {
    const result = reconcileReusedSandboxMessaging(
      mixedChannelPlan(),
      { name: "openclaw" },
      { clearPlanEnv() {} },
    );
    const filtered = result.plan;

    expect(filtered).not.toBeNull();
    expect(result.selectedChannels).toEqual(["telegram"]);
    expect(result.changed).toBe(true);
    expect({
      channels: channelIdsFrom(filtered?.channels ?? []),
      disabledChannels: filtered?.disabledChannels,
      credentialBindings: channelIdsFrom(filtered?.credentialBindings ?? []),
      networkPolicyPresets: filtered?.networkPolicy.presets,
      networkPolicyEntries: channelIdsFrom(filtered?.networkPolicy.entries ?? []),
      agentRender: channelIdsFrom(filtered?.agentRender ?? []),
      buildSteps: channelIdsFrom(filtered?.buildSteps ?? []),
      nodePreloads: channelIdsFrom(filtered?.runtimeSetup?.nodePreloads ?? []),
      envAliases: channelIdsFrom(filtered?.runtimeSetup?.envAliases ?? []),
      secretScans: channelIdsFrom(filtered?.runtimeSetup?.secretScans ?? []),
      stateUpdates: channelIdsFrom(filtered?.stateUpdates ?? []),
      healthChecks: channelIdsFrom(filtered?.healthChecks ?? []),
    }).toEqual({
      channels: ["telegram"],
      disabledChannels: [],
      credentialBindings: ["telegram"],
      networkPolicyPresets: ["telegram"],
      networkPolicyEntries: ["telegram"],
      agentRender: ["telegram"],
      buildSteps: ["telegram"],
      nodePreloads: ["telegram"],
      envAliases: ["telegram"],
      secretScans: ["telegram"],
      stateUpdates: ["telegram"],
      healthChecks: ["telegram"],
    });
  });
});

describe("reconcileSandboxMessaging completed checkpoint credentials", () => {
  it("reuses an active channel only when the process credential matches the persisted hash", async () => {
    const token = "123456:accepted-telegram-token";
    const plan = telegramPlan(hashCredential(token) ?? "");
    const deps = reconcileDeps([null]);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", token);

    const result = await reconcileSandboxMessaging({
      resume: true,
      session: completedCheckpointSession(plan),
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(deps.writePlanToEnv).toHaveBeenCalledWith(plan);
    expect(deps.showMessagingStage).toHaveBeenCalledOnce();
    expect(result).toEqual({ plan, selectedChannels: ["telegram"] });
  });

  it("runs existing setup validation before accepting a changed Telegram token", async () => {
    const previousToken = "123456:previous-telegram-token";
    const changedToken = "123456:changed-telegram-token";
    const persistedPlan = telegramPlan(hashCredential(previousToken) ?? "");
    const validatedPlan = telegramPlan(hashCredential(changedToken) ?? "");
    const deps = reconcileDeps([persistedPlan, validatedPlan]);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", changedToken);

    const result = await reconcileSandboxMessaging({
      resume: true,
      session: completedCheckpointSession(persistedPlan),
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.setupMessagingChannels).toHaveBeenCalledWith(
      { name: "openclaw" },
      ["telegram"],
      "alpha",
      { selectionCompleted: true },
    );
    expect(deps.writePlanToEnv).toHaveBeenCalledWith(persistedPlan);
    expect(result).toEqual({ plan: validatedPlan, selectedChannels: ["telegram"] });
  });

  it("propagates Telegram rejection instead of refreshing the persisted hash", async () => {
    const previousToken = "123456:previous-telegram-token";
    const rejectedToken = "123456:rejected-telegram-token";
    const persistedPlan = telegramPlan(hashCredential(previousToken) ?? "");
    const deps = reconcileDeps([persistedPlan]);
    deps.setupMessagingChannels.mockRejectedValueOnce(
      new Error("Bot token was rejected by Telegram"),
    );
    vi.stubEnv("TELEGRAM_BOT_TOKEN", rejectedToken);

    await expect(
      reconcileSandboxMessaging({
        resume: true,
        session: completedCheckpointSession(persistedPlan),
        sandboxName: "alpha",
        agent: { name: "openclaw" },
        deps,
      }),
    ).rejects.toThrow("Bot token was rejected by Telegram");

    expect(deps.setupMessagingChannels).toHaveBeenCalledWith(
      { name: "openclaw" },
      ["telegram"],
      "alpha",
      { selectionCompleted: true },
    );
    expect(deps.writePlanToEnv).toHaveBeenCalledWith(persistedPlan);
    expect(persistedPlan.credentialBindings[0]?.credentialHash).toBe(hashCredential(previousToken));
  });

  it("runs existing setup validation when the checkpointed credential lacks a staging receipt", async () => {
    const persistedPlan = telegramPlan(hashCredential("123456:previous-token") ?? "");
    const deps = reconcileDeps([persistedPlan]);
    deps.providerMatchesGatewayCredential.mockReturnValueOnce(true);
    deps.setupMessagingChannels.mockRejectedValueOnce(new Error("Telegram token is required"));

    await expect(
      reconcileSandboxMessaging({
        resume: true,
        session: completedCheckpointSession(persistedPlan),
        sandboxName: "alpha",
        agent: { name: "openclaw" },
        deps,
      }),
    ).rejects.toThrow("Telegram token is required");

    expect(deps.setupMessagingChannels).toHaveBeenCalledWith(
      { name: "openclaw" },
      ["telegram"],
      "alpha",
      { selectionCompleted: true },
    );
    expect(deps.providerMatchesGatewayCredential).not.toHaveBeenCalled();
  });

  it("reuses an exact OpenShell provider when the raw credential is unavailable (#6743)", async () => {
    const persistedPlan = telegramPlan(hashCredential("123456:previous-token") ?? "");
    const deps = reconcileDeps([null]);
    deps.providerMatchesGatewayCredential.mockReturnValueOnce(true);

    const result = await reconcileSandboxMessaging({
      resume: true,
      session: completedCheckpointSession(persistedPlan, ["alpha-telegram-bridge"]),
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "alpha-telegram-bridge",
      "generic",
      "TELEGRAM_BOT_TOKEN",
    );
    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(result).toEqual({ plan: persistedPlan, selectedChannels: ["telegram"] });
  });

  it("does not reconcile when the checkpointed channel selection matches the durable plan (#7022)", async () => {
    const persistedPlan = telegramPlan(hashCredential("123456:previous-token") ?? "");
    const deps = reconcileDeps([null]);
    deps.providerMatchesGatewayCredential.mockReturnValueOnce(true);
    const session = withMessagingCheckpoint(
      completedCheckpointSession(persistedPlan, ["alpha-telegram-bridge"]),
      ["telegram"],
    );

    const result = await reconcileSandboxMessaging({
      resume: true,
      session,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(deps.note).not.toHaveBeenCalledWith(
      expect.stringContaining("Reconciling messaging selection"),
    );
    expect(result).toEqual({ plan: persistedPlan, selectedChannels: ["telegram"] });
  });

  it("reconciles the messaging selection with the checkpoint when the durable plan disagrees (#7022)", async () => {
    const persistedPlan = telegramPlan(hashCredential("123456:previous-token") ?? "");
    const deps = reconcileDeps([null]);
    deps.setupMessagingChannels.mockImplementationOnce(
      async (_agent: unknown, existing: string[] | null) => existing ?? [],
    );
    const session = withMessagingCheckpoint(completedCheckpointSession(persistedPlan), ["discord"]);

    const result = await reconcileSandboxMessaging({
      resume: true,
      session,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.note).toHaveBeenCalledWith(
      expect.stringContaining("Reconciling messaging selection"),
    );
    expect(deps.setupMessagingChannels).toHaveBeenCalledWith(
      { name: "openclaw" },
      ["discord"],
      "alpha",
      { selectionCompleted: true },
    );
    expect(result.selectedChannels).toEqual(["discord"]);
  });
});
