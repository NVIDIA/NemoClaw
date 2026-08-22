// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../../agent/defs";
import { MessagingSetupApplier } from "../../../messaging/applier/setup-applier";
import { MESSAGING_SETUP_APPLIER_ENV_KEY } from "../../../messaging/applier/types";
import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import type { RegistryMessagingAuthority } from "../../../messaging/plan-authority";
import { hashCredential } from "../../../security/credential-hash";
import { decisionSelected, decisionUnset } from "../../../state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type OnboardCheckpoint,
} from "../../../state/onboard-checkpoint-types";
import { createSession, type Session } from "../../../state/onboard-session";
import { setupMessagingChannels } from "../../messaging-channel-setup";
import { getActiveChannelsFromPlan } from "../../messaging-plan-session";
import {
  hasMessagingCredentialDrift,
  reconcileReusedSandboxMessaging,
  reconcileSandboxMessaging,
} from "./sandbox-messaging";

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

function discordPlan(
  credentialHash: string,
  agent: SandboxMessagingPlan["agent"] = "openclaw",
): SandboxMessagingPlan {
  return {
    ...telegramPlan(credentialHash),
    agent,
    channels: [
      {
        channelId: "discord",
        displayName: "Discord",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    credentialBindings: [
      {
        channelId: "discord",
        credentialId: "discordBotToken",
        sourceInput: "botToken",
        providerName: "alpha-discord-bridge",
        providerEnvKey: "DISCORD_BOT_TOKEN",
        placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
        credentialAvailable: true,
        credentialHash,
      },
    ],
  };
}

function withChannelDisabled(
  plan: SandboxMessagingPlan,
  channelId: string,
): SandboxMessagingPlan {
  return {
    ...plan,
    channels: plan.channels.map((channel) =>
      channel.channelId === channelId
        ? { ...channel, active: false, selected: false, disabled: true }
        : channel,
    ),
    disabledChannels: [...new Set([...plan.disabledChannels, channelId])],
  };
}

function whatsappPlan(): SandboxMessagingPlan {
  return {
    ...telegramPlan(""),
    channels: [
      {
        channelId: "whatsapp",
        displayName: "WhatsApp",
        authMode: "in-sandbox-qr",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    credentialBindings: [],
  };
}

function slackPlan(
  botCredentialHash: string,
  appCredentialHash?: string,
  agent: SandboxMessagingPlan["agent"] = "openclaw",
): SandboxMessagingPlan {
  const appBinding = appCredentialHash
    ? [
        {
          channelId: "slack",
          credentialId: "slackAppToken",
          sourceInput: "appToken",
          providerName: "alpha-slack-app",
          providerEnvKey: "SLACK_APP_TOKEN",
          placeholder: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
          credentialAvailable: true,
          credentialHash: appCredentialHash,
        },
      ]
    : [];
  return {
    ...telegramPlan(botCredentialHash),
    agent,
    channels: [
      {
        channelId: "slack",
        displayName: "Slack",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    credentialBindings: [
      {
        channelId: "slack",
        credentialId: "slackBotToken",
        sourceInput: "botToken",
        providerName: "alpha-slack-bridge",
        providerEnvKey: "SLACK_BOT_TOKEN",
        placeholder: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        credentialAvailable: true,
        credentialHash: botCredentialHash,
      },
      ...appBinding,
    ],
  };
}

describe("hasMessagingCredentialDrift", () => {
  const oldToken = "123456:old-telegram-token";
  const plan = telegramPlan(hashCredential(oldToken) ?? "");

  it("detects only an explicitly supplied replacement credential", () => {
    expect(hasMessagingCredentialDrift(plan, {})).toBe(false);
    expect(hasMessagingCredentialDrift(plan, { TELEGRAM_BOT_TOKEN: oldToken })).toBe(false);
    expect(
      hasMessagingCredentialDrift(plan, {
        TELEGRAM_BOT_TOKEN: "123456:new-telegram-token",
      }),
    ).toBe(true);
  });

  it("ignores replacement credentials for disabled channels", () => {
    const disabledPlan = mixedChannelPlan();
    expect(
      hasMessagingCredentialDrift(disabledPlan, {
        UNSUPPORTED_TOKEN: "replacement-disabled-channel-token",
      }),
    ).toBe(false);
  });
});
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
    profile: { kind: "selected", value: "default" },
    runtimeAuthority: { kind: "unset" },
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
    sandboxRecreate: null,
  };
  session.checkpoint = checkpoint;
  return session;
}

function reconcileDeps(plans: readonly (SandboxMessagingPlan | null)[]) {
  return {
    note: vi.fn(),
    showMessagingStage: vi.fn(),
    getRecordedMessagingChannelsForResume: vi.fn((): string[] | null => null),
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
    getRegistrySandboxMessagingAuthority: vi.fn((): RegistryMessagingAuthority => ({
      authoritative: false,
      plan: null,
    })),
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
  it("does not clear an equal recorded plan from a different authority", () => {
    const plan = telegramPlan(hashCredential("123456:registry-token") ?? "");
    const clearPlanEnv = vi.fn();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:registry-token");

    const result = reconcileReusedSandboxMessaging(
      structuredClone(plan),
      { name: "openclaw" },
      { clearPlanEnv, note: vi.fn(), writePlanToEnv: vi.fn() },
      plan,
    );

    expect(result).toEqual({ plan, selectedChannels: ["telegram"], changed: false });
    expect(clearPlanEnv).not.toHaveBeenCalled();
  });

  it("omits a retired host-backed channel from a reused sandbox selection (#9283)", () => {
    const plan = discordPlan(hashCredential("previous-discord-token") ?? "");
    const deps = { clearPlanEnv: vi.fn(), note: vi.fn(), writePlanToEnv: vi.fn() };
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    const result = reconcileReusedSandboxMessaging(
      structuredClone(plan),
      { name: "openclaw" },
      deps,
      plan,
    );

    // Persist the removal so later readers cannot re-enable the channel and
    // re-apply its egress preset.
    expect(result).toEqual({
      plan: withChannelDisabled(plan, "discord"),
      selectedChannels: [],
      changed: true,
    });
    expect(deps.clearPlanEnv).not.toHaveBeenCalled();
  });

  it("keeps a still-configured channel in a reused sandbox selection (#9283)", () => {
    const plan = discordPlan(hashCredential("previous-discord-token") ?? "");
    vi.stubEnv("DISCORD_BOT_TOKEN", "123456:live-discord-token");

    const result = reconcileReusedSandboxMessaging(
      structuredClone(plan),
      { name: "openclaw" },
      { clearPlanEnv: vi.fn(), note: vi.fn(), writePlanToEnv: vi.fn() },
      plan,
    );

    expect(result.selectedChannels).toEqual(["discord"]);
  });

  it("keeps an in-sandbox QR channel in a reused sandbox selection (#9283)", () => {
    const plan = whatsappPlan();
    vi.stubEnv("WHATSAPP_MODE", "");
    vi.stubEnv("WHATSAPP_ALLOWED_IDS", "");

    const result = reconcileReusedSandboxMessaging(
      structuredClone(plan),
      { name: "openclaw" },
      { clearPlanEnv: vi.fn(), note: vi.fn(), writePlanToEnv: vi.fn() },
      plan,
    );

    // The host environment holds no value that reports whether an in-sandbox
    // QR channel is still paired, so reuse must keep it selected.
    expect(result.selectedChannels).toEqual(["whatsapp"]);
  });

  it("removes every unsupported channel artifact from a reused plan", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:registry-token");
    const result = reconcileReusedSandboxMessaging(
      mixedChannelPlan(),
      { name: "openclaw" },
      { clearPlanEnv() {}, note() {}, writePlanToEnv() {} },
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

  it("disables and stages an unconfigured host-backed channel for Ready sandbox reuse (#9283)", () => {
    const plan = discordPlan(hashCredential("previous-discord-token") ?? "");
    const deps = reconcileDeps([]);
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    const result = reconcileReusedSandboxMessaging(
      plan,
      { name: "openclaw" },
      deps,
      structuredClone(plan),
    );
    const disabledPlan = withChannelDisabled(plan, "discord");

    expect(result).toEqual({ plan: disabledPlan, selectedChannels: [], changed: true });
    expect(deps.writePlanToEnv).toHaveBeenLastCalledWith(disabledPlan);
    expect(deps.clearPlanEnv).not.toHaveBeenCalled();
    expect(deps.note).toHaveBeenCalledWith(expect.stringContaining("No host inputs configure"));
  });
});

describe("reconcileSandboxMessaging plan authority", () => {
  it("uses the registry plan before a staged plan for an existing sandbox", async () => {
    const registryToken = "123456:registry-token";
    const registryPlan = telegramPlan(hashCredential(registryToken) ?? "");
    const deps = reconcileDeps([mixedChannelPlan()]);
    deps.getRegistrySandboxMessagingAuthority.mockReturnValueOnce({
      authoritative: true,
      plan: registryPlan,
    });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", registryToken);

    const result = await reconcileSandboxMessaging({
      resume: false,
      session: null,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(result).toEqual({ plan: registryPlan, selectedChannels: ["telegram"] });
  });

  it("uses the registry plan without reading an invalid environment plan", async () => {
    const registryToken = "123456:registry-token";
    const registryPlan = telegramPlan(hashCredential(registryToken) ?? "");
    const deps = reconcileDeps([]);
    deps.readMessagingPlanFromEnv.mockImplementation(() => {
      throw new Error("invalid environment plan");
    });
    deps.getRegistrySandboxMessagingAuthority.mockReturnValue({
      authoritative: true,
      plan: registryPlan,
    });
    vi.stubEnv("TELEGRAM_BOT_TOKEN", registryToken);

    const result = await reconcileSandboxMessaging({
      resume: false,
      session: null,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.readMessagingPlanFromEnv).not.toHaveBeenCalled();
    expect(deps.getRecordedMessagingChannelsForResume).not.toHaveBeenCalled();
    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(result).toEqual({ plan: registryPlan, selectedChannels: ["telegram"] });
  });

  it("omits a removed host-backed channel from fresh registry re-onboarding (#9109)", async () => {
    const registryPlan = discordPlan(hashCredential("previous-discord-token") ?? "");
    const deps = reconcileDeps([]);
    deps.getRegistrySandboxMessagingAuthority.mockReturnValue({
      authoritative: true,
      plan: registryPlan,
    });
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    const result = await reconcileSandboxMessaging({
      resume: false,
      session: null,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(result).toEqual({
      plan: withChannelDisabled(registryPlan, "discord"),
      selectedChannels: [],
    });
  });

  it("records the removal in the plan so a later reader cannot re-enable it (#9283)", async () => {
    const registryPlan = discordPlan(hashCredential("previous-discord-token") ?? "");
    const disabledPlan = withChannelDisabled(registryPlan, "discord");
    const deps = reconcileDeps([]);
    deps.getRegistrySandboxMessagingAuthority.mockReturnValue({
      authoritative: true,
      plan: registryPlan,
    });
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    const result = await reconcileSandboxMessaging({
      resume: false,
      session: null,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(getActiveChannelsFromPlan(result.plan)).toEqual([]);
    expect(result.plan?.disabledChannels).toEqual(["discord"]);
    expect(deps.writePlanToEnv).toHaveBeenLastCalledWith(disabledPlan);
    expect(deps.note).toHaveBeenCalledWith(expect.stringContaining("No host inputs configure"));
  });

  it("omits a removed host-backed channel from a lifecycle-workflow registry plan (#9283)", async () => {
    const registryPlan = {
      ...discordPlan(hashCredential("previous-discord-token") ?? ""),
      workflow: "add-channel" as const,
    };
    const deps = reconcileDeps([]);
    deps.getRegistrySandboxMessagingAuthority.mockReturnValue({
      authoritative: true,
      plan: registryPlan,
    });
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    const result = await reconcileSandboxMessaging({
      resume: false,
      session: null,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(result).toEqual({
      plan: withChannelDisabled(registryPlan, "discord"),
      selectedChannels: [],
    });
  });

  it("keeps a still-configured channel in a lifecycle-workflow registry plan (#9283)", async () => {
    const token = "still-configured-discord-token";
    const registryPlan = {
      ...discordPlan(hashCredential(token) ?? ""),
      workflow: "add-channel" as const,
    };
    const deps = reconcileDeps([]);
    deps.getRegistrySandboxMessagingAuthority.mockReturnValue({
      authoritative: true,
      plan: registryPlan,
    });
    vi.stubEnv("DISCORD_BOT_TOKEN", token);

    const result = await reconcileSandboxMessaging({
      resume: false,
      session: null,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(result.selectedChannels).toEqual(["discord"]);
    expect(result.plan?.disabledChannels).toEqual([]);
  });

  it("omits a removed host-backed channel from a completed registry resume (#9109)", async () => {
    const registryPlan = discordPlan(hashCredential("previous-discord-token") ?? "");
    const deps = reconcileDeps([]);
    deps.getRegistrySandboxMessagingAuthority.mockReturnValue({
      authoritative: true,
      plan: registryPlan,
    });
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    const result = await reconcileSandboxMessaging({
      resume: true,
      session: completedCheckpointSession(registryPlan),
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(result).toEqual({
      plan: withChannelDisabled(registryPlan, "discord"),
      selectedChannels: [],
    });
  });

  it("omits a retired host-backed channel from recorded resume channels (#9283)", async () => {
    const deps = reconcileDeps([]);
    deps.getRecordedMessagingChannelsForResume.mockReturnValue(["discord"]);
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    const result = await reconcileSandboxMessaging({
      resume: true,
      session: null,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    // A recorded selection is the previous run's choice, not the current host
    // input; a channel the environment no longer configures must not re-enter
    // the selection, or its egress preset is re-applied.
    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(deps.note).toHaveBeenCalledWith(expect.stringContaining("No host inputs configure discord"));
    expect(deps.clearPlanEnv).toHaveBeenCalledOnce();
    expect(deps.writePlanToEnv).not.toHaveBeenCalled();
    expect(result).toEqual({ plan: null, selectedChannels: [] });
  });

  it("keeps an in-sandbox QR channel in recorded resume channels (#9283)", async () => {
    const deps = reconcileDeps([]);
    deps.getRecordedMessagingChannelsForResume.mockReturnValue(["whatsapp"]);
    vi.stubEnv("WHATSAPP_MODE", "");
    vi.stubEnv("WHATSAPP_ALLOWED_IDS", "");

    const result = await reconcileSandboxMessaging({
      resume: true,
      session: null,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(result).toEqual({ plan: null, selectedChannels: ["whatsapp"] });
  });

  it("keeps an in-sandbox QR channel in a completed registry resume (#9109)", async () => {
    const registryPlan = whatsappPlan();
    const deps = reconcileDeps([]);
    deps.getRegistrySandboxMessagingAuthority.mockReturnValue({
      authoritative: true,
      plan: registryPlan,
    });
    vi.stubEnv("WHATSAPP_MODE", "");
    vi.stubEnv("WHATSAPP_ALLOWED_IDS", "");

    const result = await reconcileSandboxMessaging({
      resume: true,
      session: completedCheckpointSession(registryPlan),
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(result).toEqual({ plan: registryPlan, selectedChannels: ["whatsapp"] });
  });

  it("uses the staged plan before a matching session plan during resume for a pending target", async () => {
    const sessionPlan = telegramPlan(hashCredential("123456:session-token") ?? "");
    const stagedPlan = slackPlan(hashCredential("staged-slack-token") ?? "");
    const deps = reconcileDeps([stagedPlan]);
    deps.providerMatchesGatewayCredential.mockReturnValueOnce(true);
    const session = withMessagingCheckpoint(
      completedCheckpointSession(sessionPlan, ["alpha-slack-bridge"]),
      ["telegram"],
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "");

    const result = await reconcileSandboxMessaging({
      resume: true,
      session,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(deps.providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "alpha-slack-bridge",
      "generic",
      "SLACK_BOT_TOKEN",
    );
    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(result).toEqual({ plan: stagedPlan, selectedChannels: ["slack"] });
  });

  it("rejects a staged plan that targets another sandbox", async () => {
    const mismatchedPlan = {
      ...slackPlan(hashCredential("staged-slack-token") ?? ""),
      sandboxName: "beta",
    };
    const deps = reconcileDeps([mismatchedPlan]);
    deps.getRecordedMessagingChannelsForResume.mockReturnValueOnce(["telegram"]);

    await expect(
      reconcileSandboxMessaging({
        resume: true,
        session: null,
        sandboxName: "alpha",
        agent: { name: "openclaw" },
        deps,
      }),
    ).rejects.toThrow("Staged messaging plan targets 'beta', not 'alpha'.");
    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
  });

  it("rejects a completed resume session plan that targets another sandbox before messaging effects (#7701)", async () => {
    const mismatchedPlan = {
      ...telegramPlan(hashCredential("123456:session-token") ?? ""),
      sandboxName: "beta",
    };
    const session = completedCheckpointSession(mismatchedPlan, ["beta-telegram-bridge"]);
    session.sandboxName = "alpha";
    const deps = reconcileDeps([null]);
    deps.providerMatchesGatewayCredential.mockReturnValueOnce(true);

    await expect(
      reconcileSandboxMessaging({
        resume: true,
        session,
        sandboxName: "alpha",
        agent: { name: "openclaw" },
        deps,
      }),
    ).rejects.toThrow("Session messaging plan targets 'beta', not 'alpha'.");

    expect(deps.providerMatchesGatewayCredential).not.toHaveBeenCalled();
    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(deps.writePlanToEnv).not.toHaveBeenCalled();
    expect(deps.clearPlanEnv).not.toHaveBeenCalled();
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
    expect(result.plan).toMatchObject(validatedPlan);
    expect(result.selectedChannels).toEqual(["telegram"]);
  });

  it("validates only the channel whose supplied credential changed (#3631)", async () => {
    const previousTelegramToken = "123456:previous-telegram-token";
    const changedTelegramToken = "123456:changed-telegram-token";
    const telegram = telegramPlan(hashCredential(previousTelegramToken) ?? "");
    const slack = slackPlan(
      hashCredential("xoxb-existing-slack-bot-token") ?? "",
      hashCredential("xapp-existing-slack-app-token") ?? "",
    );
    const persistedPlan: SandboxMessagingPlan = {
      ...telegram,
      channels: [...telegram.channels, ...slack.channels],
      credentialBindings: [...telegram.credentialBindings, ...slack.credentialBindings],
    };
    const validatedTelegramPlan = telegramPlan(hashCredential(changedTelegramToken) ?? "");
    const deps = reconcileDeps([persistedPlan, validatedTelegramPlan]);
    deps.setupMessagingChannels.mockResolvedValueOnce(["telegram"]);
    deps.providerMatchesGatewayCredential.mockReturnValue(true);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", changedTelegramToken);
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");

    const result = await reconcileSandboxMessaging({
      resume: true,
      session: completedCheckpointSession(persistedPlan, [
        "alpha-telegram-bridge",
        "alpha-slack-bridge",
        "alpha-slack-app",
      ]),
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
    expect([...result.selectedChannels].sort()).toEqual(["slack", "telegram"]);
    expect(result.plan?.credentialBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: "telegram",
          credentialHash: hashCredential(changedTelegramToken),
        }),
        expect.objectContaining({
          channelId: "slack",
          providerEnvKey: "SLACK_BOT_TOKEN",
          credentialHash: hashCredential("xoxb-existing-slack-bot-token"),
        }),
      ]),
    );
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

  it("stops forced validation when the real compiler skips an active Slack channel (#3631)", async () => {
    const persistedPlan = slackPlan(
      hashCredential("xoxb-previous-slack-bot-token") ?? "",
      hashCredential("xapp-previous-slack-app-token") ?? "",
    );
    const deps = reconcileDeps([persistedPlan]);
    vi.stubEnv(MESSAGING_SETUP_APPLIER_ENV_KEY, "");
    vi.stubEnv("SLACK_BOT_TOKEN", "invalid-replacement-bot-token");
    vi.stubEnv("SLACK_APP_TOKEN", "invalid-replacement-app-token");
    vi.spyOn(console, "log").mockImplementation(() => {});
    MessagingSetupApplier.writePlanToEnv(persistedPlan);
    deps.readMessagingPlanFromEnv.mockImplementation(() => MessagingSetupApplier.readPlanFromEnv());
    deps.writePlanToEnv.mockImplementation((plan) => MessagingSetupApplier.writePlanToEnv(plan));
    deps.clearPlanEnv.mockImplementation(() => MessagingSetupApplier.clearPlanEnv());
    deps.setupMessagingChannels.mockImplementation(
      async (agent, existingChannels, sandboxName, setupOptions) =>
        setupMessagingChannels(agent as AgentDefinition, existingChannels, {
          sandboxName,
          selectionCompleted: setupOptions?.selectionCompleted,
          isNonInteractive: () => true,
          note: () => {},
        }),
    );

    await expect(
      reconcileSandboxMessaging({
        resume: true,
        session: completedCheckpointSession(persistedPlan),
        sandboxName: "alpha",
        agent: { name: "openclaw" },
        credentialValidationPlan: persistedPlan,
        forceCredentialValidation: true,
        deps,
      }),
    ).rejects.toThrow(
      "Credential validation did not complete for active messaging channels: slack. The existing sandbox was not changed.",
    );

    expect(MessagingSetupApplier.requirePlanFromEnv()).toEqual(persistedPlan);
  });

  it("keeps checkpoint-disabled channels disabled while validating registry hashes (#3631)", async () => {
    const oldSlackBotHash = hashCredential("xoxb-previous-slack-bot-token") ?? "";
    const oldSlackAppHash = hashCredential("xapp-previous-slack-app-token") ?? "";
    const replacementSlackBotHash = hashCredential("xoxb-replacement-slack-bot-token") ?? "";
    const replacementSlackAppHash = hashCredential("xapp-replacement-slack-app-token") ?? "";
    const replacementHashesByProviderEnvKey: Readonly<Record<string, string>> = {
      SLACK_BOT_TOKEN: replacementSlackBotHash,
      SLACK_APP_TOKEN: replacementSlackAppHash,
    };
    const telegram = telegramPlan(hashCredential("123456:telegram-token") ?? "");
    const slack = slackPlan(oldSlackBotHash, oldSlackAppHash);
    const registryPlan: SandboxMessagingPlan = {
      ...slack,
      channels: [
        ...telegram.channels.map((channel) => ({
          ...channel,
          active: false,
          disabled: true,
        })),
        ...slack.channels,
      ],
      disabledChannels: ["telegram"],
      credentialBindings: [...telegram.credentialBindings, ...slack.credentialBindings],
    };
    const sessionPlan: SandboxMessagingPlan = {
      ...registryPlan,
      credentialBindings: registryPlan.credentialBindings.map((binding) => ({
        ...binding,
        credentialHash:
          replacementHashesByProviderEnvKey[binding.providerEnvKey] ?? binding.credentialHash,
      })),
    };
    const validatedSlackPlan = slackPlan(replacementSlackBotHash, replacementSlackAppHash);
    const deps = reconcileDeps([validatedSlackPlan]);
    deps.getRegistrySandboxMessagingAuthority.mockReturnValue({
      authoritative: true,
      plan: registryPlan,
    });
    deps.setupMessagingChannels.mockResolvedValueOnce(["slack"]);
    const session = withMessagingCheckpoint(
      completedCheckpointSession(sessionPlan),
      ["telegram", "slack"],
      ["telegram"],
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-replacement-slack-bot-token");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-replacement-slack-app-token");

    const result = await reconcileSandboxMessaging({
      resume: true,
      session,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      credentialValidationPlan: registryPlan,
      forceCredentialValidation: true,
      deps,
    });

    expect(deps.setupMessagingChannels).toHaveBeenCalledWith(
      { name: "openclaw" },
      ["slack"],
      "alpha",
      { selectionCompleted: true },
    );
    expect(result.selectedChannels).toEqual(["slack"]);
    expect(result.plan?.disabledChannels).toContain("telegram");
    expect(result.plan?.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channelId: "telegram", active: false, disabled: true }),
        expect.objectContaining({ channelId: "slack", active: true, disabled: false }),
      ]),
    );
    expect(
      result.plan?.credentialBindings.find(
        (binding) => binding.providerEnvKey === "SLACK_BOT_TOKEN",
      )?.credentialHash,
    ).toBe(replacementSlackBotHash);
  });

  it("does not reuse a refreshed Hermes process plan before forced validation (#3631)", async () => {
    const registryPlan = slackPlan(
      hashCredential("xoxb-previous-slack-bot-token") ?? "",
      hashCredential("xapp-previous-slack-app-token") ?? "",
      "hermes",
    );
    const refreshedPlan = slackPlan(
      hashCredential("xoxb-replacement-slack-bot-token") ?? "",
      hashCredential("xapp-replacement-slack-app-token") ?? "",
      "hermes",
    );
    const deps = reconcileDeps([refreshedPlan, null]);
    deps.setupMessagingChannels.mockResolvedValueOnce([]);

    await expect(
      reconcileSandboxMessaging({
        resume: true,
        session: completedCheckpointSession(refreshedPlan),
        sandboxName: "alpha",
        agent: { name: "hermes" },
        credentialValidationPlan: registryPlan,
        forceCredentialValidation: true,
        deps,
      }),
    ).rejects.toThrow(
      "Credential validation did not complete for active messaging channels: slack. The existing sandbox was not changed.",
    );

    expect(deps.setupMessagingChannels).toHaveBeenCalledWith(
      { name: "hermes" },
      ["slack"],
      "alpha",
      { selectionCompleted: true },
    );
    expect(deps.writePlanToEnv).toHaveBeenLastCalledWith(registryPlan);
  });

  it("adopts a live provider when its durable effect receipt is missing", async () => {
    const persistedPlan = telegramPlan(hashCredential("123456:previous-token") ?? "");
    const deps = reconcileDeps([persistedPlan]);
    deps.providerMatchesGatewayCredential.mockReturnValueOnce(true);

    const result = await reconcileSandboxMessaging({
      resume: true,
      session: completedCheckpointSession(persistedPlan),
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

  it("reuses a missing Hermes Discord credential with the exact static provider binding", async () => {
    const persistedPlan = discordPlan(hashCredential("previous-discord-token") ?? "", "hermes");
    const deps = reconcileDeps([null, persistedPlan]);
    deps.providerMatchesGatewayCredential.mockReturnValue(true);
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    const result = await reconcileSandboxMessaging({
      resume: true,
      session: completedCheckpointSession(persistedPlan, ["alpha-discord-bridge"]),
      sandboxName: "alpha",
      agent: {},
      deps,
    });

    expect(deps.providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "alpha-discord-bridge",
      "discord-hermes-static-v1",
      "DISCORD_BOT_TOKEN",
    );
    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(result).toEqual({ plan: persistedPlan, selectedChannels: ["discord"] });
  });

  it("revalidates a missing Hermes Discord credential without the exact static binding", async () => {
    const persistedPlan = discordPlan(hashCredential("previous-discord-token") ?? "", "hermes");
    const deps = reconcileDeps([null, persistedPlan]);
    deps.providerMatchesGatewayCredential.mockReturnValue(false);
    deps.setupMessagingChannels.mockResolvedValue(["discord"]);
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    await reconcileSandboxMessaging({
      resume: true,
      session: completedCheckpointSession(persistedPlan, ["alpha-discord-bridge"]),
      sandboxName: "alpha",
      agent: {},
      deps,
    });

    expect(deps.providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "alpha-discord-bridge",
      "discord-hermes-static-v1",
      "DISCORD_BOT_TOKEN",
    );
    expect(deps.setupMessagingChannels).toHaveBeenCalledWith({}, ["discord"], "alpha", {
      selectionCompleted: true,
    });
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
