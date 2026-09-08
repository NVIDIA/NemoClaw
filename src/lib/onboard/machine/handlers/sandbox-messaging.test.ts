// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../../../agent/defs";
import { MessagingSetupApplier } from "../../../messaging/applier/setup-applier";
import { MESSAGING_SETUP_APPLIER_ENV_KEY } from "../../../messaging/applier/types";
import { wechatManifest } from "../../../messaging/channels/built-ins";
import type {
  MessagingAgentId,
  MessagingChannelId,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingPlan,
} from "../../../messaging/manifest";
import type { RegistryMessagingAuthority } from "../../../messaging/plan-authority";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../../../messaging/provider-profile";
import { hashCredential } from "../../../security/credential-hash";
import { decisionSelected } from "../../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../../state/onboard-checkpoint-migrate";
import { createSession, type Session } from "../../../state/onboard-session";
import { makeMessagingPlan } from "../../../../../test/helpers/messaging-plan-fixtures";
import { setupMessagingChannels } from "../../messaging-channel-setup";
import type { GatewayCredentialOnlyProviderInspection } from "../../gateway-provider-metadata";
import { getActiveChannelsFromPlan } from "../../messaging-plan-session";
import {
  hasMessagingCredentialDrift,
  reconcileReusedSandboxMessaging,
  reconcileSandboxMessaging,
} from "./sandbox-messaging";

const mixedChannelIds: MessagingChannelId[] = ["telegram", "unsupported"];

function channelIdsFrom<T extends { readonly channelId: string }>(entries: readonly T[]): string[] {
  return entries.map(({ channelId }) => channelId);
}

const credentialSpecs = {
  telegram: ["telegram", "botToken", "botToken", "alpha-telegram-bridge", "TELEGRAM_BOT_TOKEN"],
  discord: ["discord", "discordBotToken", "botToken", "alpha-discord-bridge", "DISCORD_BOT_TOKEN"],
  slackBot: ["slack", "slackBotToken", "botToken", "alpha-slack-bridge", "SLACK_BOT_TOKEN"],
  slackApp: ["slack", "slackAppToken", "appToken", "alpha-slack-app", "SLACK_APP_TOKEN"],
} as const;

function credentialBinding(
  kind: keyof typeof credentialSpecs,
  credentialHash: string,
): SandboxMessagingCredentialBindingPlan {
  const [channelId, credentialId, sourceInput, providerName, providerEnvKey] =
    credentialSpecs[kind];
  const placeholderPrefix = kind === "slackBot" ? "xoxb-" : kind === "slackApp" ? "xapp-" : "";
  return {
    channelId,
    credentialId,
    sourceInput,
    providerName,
    providerEnvKey,
    placeholder: placeholderPrefix
      ? `${placeholderPrefix}OPENSHELL-RESOLVE-ENV-${providerEnvKey}`
      : `openshell:resolve:env:${providerEnvKey}`,
    credentialAvailable: true,
    credentialHash,
  };
}

function messagingPlan(
  channelId: MessagingChannelId,
  credentialBindings: readonly SandboxMessagingCredentialBindingPlan[] = [],
  agent: MessagingAgentId = "openclaw",
): SandboxMessagingPlan {
  return makeMessagingPlan({
    sandboxName: "alpha",
    agent,
    channels: [channelId],
    credentialBindings,
  });
}

function telegramPlan(credentialHash: string): SandboxMessagingPlan {
  return messagingPlan("telegram", [credentialBinding("telegram", credentialHash)]);
}

function discordPlan(credentialHash: string, agent: MessagingAgentId = "openclaw") {
  return messagingPlan("discord", [credentialBinding("discord", credentialHash)], agent);
}

function slackPlan(
  botCredentialHash: string,
  appCredentialHash?: string,
  agent: MessagingAgentId = "openclaw",
) {
  const bindings = [
    credentialBinding("slackBot", botCredentialHash),
    ...(appCredentialHash ? [credentialBinding("slackApp", appCredentialHash)] : []),
  ];
  return messagingPlan("slack", bindings, agent);
}

function googlechatPlan() {
  return messagingPlan("googlechat");
}

function whatsappPlan() {
  return makeMessagingPlan({
    sandboxName: "alpha",
    channels: ["whatsapp"],
    authMode: "in-sandbox-qr",
  });
}

function withChannelDisabled(plan: SandboxMessagingPlan, channelId: string) {
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

function mixedChannelPlan(): SandboxMessagingPlan {
  const plan = makeMessagingPlan({
    sandboxName: "alpha",
    channels: mixedChannelIds,
    disabledChannels: ["unsupported"],
  });
  return {
    ...plan,
    credentialBindings: mixedChannelIds.map((channelId) => ({
      channelId,
      credentialId: "token",
      sourceInput: "token",
      providerName: `alpha-${channelId}`,
      providerEnvKey: `${channelId.toUpperCase()}_TOKEN`,
      placeholder: `openshell:resolve:env:${channelId.toUpperCase()}_TOKEN`,
      credentialAvailable: true,
      credentialHash: "",
    })),
    networkPolicy: {
      presets: [...mixedChannelIds],
      entries: mixedChannelIds.map((channelId) => ({
        channelId,
        presetName: channelId,
        policyKeys: [`${channelId}_api`],
        source: "manifest",
      })),
    },
    agentRender: mixedChannelIds.map((channelId) => ({
      channelId,
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      path: `channels.${channelId}`,
      value: { enabled: true },
      templateRefs: [],
    })),
    buildSteps: mixedChannelIds.map((channelId) => ({
      channelId,
      kind: "build-arg",
      outputId: `${channelId}-arg`,
      required: true,
      value: "enabled",
    })),
    runtimeSetup: {
      nodePreloads: mixedChannelIds.map((channelId) => ({
        channelId,
        module: `${channelId}-preload`,
        source: "manifest",
        target: "agent",
      })),
      envAliases: mixedChannelIds.map((channelId) => ({
        channelId,
        envKey: `${channelId.toUpperCase()}_TOKEN`,
        match: "source",
        value: "target",
      })),
      secretScans: mixedChannelIds.map((channelId) => ({
        channelId,
        path: `/sandbox/${channelId}`,
        pattern: "secret",
        message: "secret found",
      })),
    },
    stateUpdates: mixedChannelIds.map((channelId) => ({
      channelId,
      kind: "persist-inputs",
      stateKey: `${channelId}Config`,
      inputIds: ["token"],
    })),
    healthChecks: mixedChannelIds.map((channelId) => ({
      channelId,
      phase: "health-check",
      requiredBefore: "lifecycle-success",
      hookIds: [`${channelId}-health`],
    })),
  };
}

function completedCheckpointSession(
  plan: SandboxMessagingPlan,
  stagedCredentialProviders: string[] = [],
) {
  const session = createSession({ sandboxName: plan.sandboxName, messagingPlan: plan });
  session.stagedCredentialProviders = stagedCredentialProviders;
  session.sandboxPromptProgress.sandboxName = true;
  session.sandboxPromptProgress.messaging = true;
  return session;
}

function withMessagingCheckpoint(
  session: Session,
  selectedChannels: string[],
  disabledChannels: string[] = [],
) {
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    messaging: decisionSelected({ selectedChannels, disabledChannels }),
  };
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
    getRegistrySandboxMessagingAuthority: vi.fn<() => RegistryMessagingAuthority>(() => ({
      authoritative: false,
      plan: null,
    })),
    inspectGatewayCredential: vi.fn<
      (name: string, type: string, credentialEnv: string) => GatewayCredentialOnlyProviderInspection
    >(() => ({ kind: "missing" })),
    providerMatchesGatewayCredential: vi.fn(() => false),
  };
}

function registryDeps(plan: SandboxMessagingPlan) {
  const deps = reconcileDeps([]);
  deps.getRegistrySandboxMessagingAuthority.mockReturnValue({ authoritative: true, plan });
  return deps;
}

function recordedResumeDeps(plan: SandboxMessagingPlan) {
  const deps = reconcileDeps([plan]);
  deps.getRecordedMessagingChannelsForResume.mockReturnValue(["discord", "googlechat"]);
  return deps;
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
      {
        clearPlanEnv,
        inspectGatewayCredential: () => ({ kind: "exact" }),
        note: vi.fn(),
        writePlanToEnv: vi.fn(),
      },
      plan,
    );

    expect(result).toEqual({ plan, selectedChannels: ["telegram"], changed: false });
    expect(clearPlanEnv).not.toHaveBeenCalled();
  });

  it("rejects a retired channel without changing a Ready sandbox plan (#9283)", () => {
    const plan = discordPlan(hashCredential("previous-discord-token") ?? "");
    const deps = {
      clearPlanEnv: vi.fn(),
      inspectGatewayCredential: () => ({ kind: "missing" as const }),
      note: vi.fn(),
      writePlanToEnv: vi.fn(),
    };
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    expect(() =>
      reconcileReusedSandboxMessaging(structuredClone(plan), { name: "openclaw" }, deps, plan),
    ).toThrow(
      /Ready sandbox 'alpha'.*running sandbox and durable messaging plan were not changed/u,
    );
    expect(deps.writePlanToEnv).not.toHaveBeenCalled();
    expect(deps.clearPlanEnv).not.toHaveBeenCalled();
  });

  it("keeps a still-configured channel in a reused sandbox selection (#9283)", () => {
    const plan = discordPlan(hashCredential("previous-discord-token") ?? "");
    vi.stubEnv("DISCORD_BOT_TOKEN", "123456:live-discord-token");

    const result = reconcileReusedSandboxMessaging(
      structuredClone(plan),
      { name: "openclaw" },
      {
        clearPlanEnv: vi.fn(),
        inspectGatewayCredential: () => ({ kind: "exact" }),
        note: vi.fn(),
        writePlanToEnv: vi.fn(),
      },
      plan,
    );

    expect(result.selectedChannels).toEqual(["discord"]);
  });

  it("keeps a bridge channel whose gateway credential outlived the onboarding process (#10660)", () => {
    const plan = googlechatPlan();
    vi.stubEnv("GOOGLECHAT_SERVICE_ACCOUNT", "");
    const inspectGatewayCredential = vi.fn(() => ({ kind: "exact" as const }));
    const note = vi.fn();

    const result = reconcileReusedSandboxMessaging(
      structuredClone(plan),
      { name: "openclaw" },
      { clearPlanEnv: vi.fn(), inspectGatewayCredential, note, writePlanToEnv: vi.fn() },
      plan,
    );

    expect(result).toEqual({ plan, selectedChannels: ["googlechat"], changed: false });
    expect(note).not.toHaveBeenCalledWith(expect.stringContaining("No host inputs configure"));
    expect(inspectGatewayCredential).toHaveBeenCalledWith(
      "alpha-googlechat-bridge",
      "google-chat-bridge",
      "GOOGLE_CHAT_ACCESS_TOKEN",
    );
  });

  it("rejects Ready sandbox reuse when a bridge credential is missing (#10660)", () => {
    const plan = googlechatPlan();
    vi.stubEnv("GOOGLECHAT_SERVICE_ACCOUNT", "");
    const note = vi.fn();
    const writePlanToEnv = vi.fn();

    expect(() =>
      reconcileReusedSandboxMessaging(
        structuredClone(plan),
        { name: "openclaw" },
        {
          clearPlanEnv: vi.fn(),
          inspectGatewayCredential: () => ({ kind: "missing" }),
          note,
          writePlanToEnv,
        },
        plan,
      ),
    ).toThrow(
      /Ready sandbox 'alpha'.*running sandbox and durable messaging plan were not changed/u,
    );
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalledWith(expect.stringContaining("disabling the channel"));
  });

  it("keeps a token channel whose provider still matches at the gateway (#10660)", () => {
    const plan = discordPlan(hashCredential("previous-discord-token") ?? "");
    vi.stubEnv("DISCORD_BOT_TOKEN", "");
    const inspectGatewayCredential = vi.fn(() => ({ kind: "exact" as const }));

    const result = reconcileReusedSandboxMessaging(
      structuredClone(plan),
      { name: "openclaw" },
      {
        clearPlanEnv: vi.fn(),
        inspectGatewayCredential,
        note: vi.fn(),
        writePlanToEnv: vi.fn(),
      },
      plan,
    );

    expect(result).toEqual({ plan, selectedChannels: ["discord"], changed: false });
    expect(inspectGatewayCredential).toHaveBeenCalledWith(
      "alpha-discord-bridge",
      expect.any(String),
      "DISCORD_BOT_TOKEN",
    );
  });

  it.each([
    ["app-token", "SLACK_APP_TOKEN"],
    ["bot-token", "SLACK_BOT_TOKEN"],
  ] as const)("rejects Ready sandbox reuse when its Slack %s is missing (#10660)", (_, missing) => {
    const plan = slackPlan(
      hashCredential("previous-slack-bot-token") ?? "",
      hashCredential("previous-slack-app-token") ?? "",
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    const writePlanToEnv = vi.fn();
    const inspectGatewayCredential = vi.fn((_name: string, _type: string, credentialEnv: string) =>
      credentialEnv === missing ? ({ kind: "missing" } as const) : ({ kind: "exact" } as const),
    );

    expect(() =>
      reconcileReusedSandboxMessaging(
        structuredClone(plan),
        { name: "openclaw" },
        { clearPlanEnv: vi.fn(), inspectGatewayCredential, note: vi.fn(), writePlanToEnv },
        plan,
      ),
    ).toThrow(
      /Ready sandbox 'alpha'.*running sandbox and durable messaging plan were not changed/u,
    );
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(inspectGatewayCredential).toHaveBeenCalledTimes(2);
  });

  it.each(["collision", "indeterminate"] as const)(
    "preserves the channel plan when gateway credential inspection is %s (#10660)",
    (kind) => {
      const plan = googlechatPlan();
      vi.stubEnv("GOOGLECHAT_SERVICE_ACCOUNT", "");
      const clearPlanEnv = vi.fn();
      const writePlanToEnv = vi.fn();

      expect(() =>
        reconcileReusedSandboxMessaging(
          structuredClone(plan),
          { name: "openclaw" },
          {
            clearPlanEnv,
            inspectGatewayCredential: () => ({ kind }),
            note: vi.fn(),
            writePlanToEnv,
          },
          plan,
        ),
      ).toThrow(
        /provider 'alpha-googlechat-bridge'.*sandbox 'alpha'.*No messaging state was changed/u,
      );
      expect(clearPlanEnv).not.toHaveBeenCalled();
      expect(writePlanToEnv).not.toHaveBeenCalled();
    },
  );

  it("preserves Slack when a missing binding accompanies an indeterminate inspection (#10660)", () => {
    const plan = slackPlan(
      hashCredential("previous-slack-bot-token") ?? "",
      hashCredential("previous-slack-app-token") ?? "",
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    const clearPlanEnv = vi.fn();
    const writePlanToEnv = vi.fn();
    const inspectGatewayCredential = vi.fn((_name: string, _type: string, credentialEnv: string) =>
      credentialEnv === "SLACK_BOT_TOKEN"
        ? ({ kind: "missing" } as const)
        : ({ kind: "indeterminate" } as const),
    );

    expect(() =>
      reconcileReusedSandboxMessaging(
        structuredClone(plan),
        { name: "openclaw" },
        { clearPlanEnv, inspectGatewayCredential, note: vi.fn(), writePlanToEnv },
        plan,
      ),
    ).toThrow(/Could not inspect messaging provider/u);
    expect(inspectGatewayCredential).toHaveBeenCalledTimes(2);
    expect(clearPlanEnv).not.toHaveBeenCalled();
    expect(writePlanToEnv).not.toHaveBeenCalled();
  });

  it("keeps an in-sandbox QR channel in a reused sandbox selection (#9283)", () => {
    const plan = whatsappPlan();
    vi.stubEnv("WHATSAPP_MODE", "");
    vi.stubEnv("WHATSAPP_ALLOWED_IDS", "");

    const result = reconcileReusedSandboxMessaging(
      structuredClone(plan),
      { name: "openclaw" },
      {
        clearPlanEnv: vi.fn(),
        inspectGatewayCredential: () => ({ kind: "missing" }),
        note: vi.fn(),
        writePlanToEnv: vi.fn(),
      },
      plan,
    );

    // QR pairing state lives in the sandbox, not the host environment.
    expect(result.selectedChannels).toEqual(["whatsapp"]);
  });

  it("removes every unsupported channel artifact from a reused plan", () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123456:registry-token");
    const result = reconcileReusedSandboxMessaging(
      mixedChannelPlan(),
      { name: "openclaw" },
      {
        clearPlanEnv() {},
        inspectGatewayCredential: () => ({ kind: "exact" }),
        note() {},
        writePlanToEnv() {},
      },
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

describe("reconcileSandboxMessaging plan authority", () => {
  it("validates a changed lifecycle credential before persisting its hash", async () => {
    const previousToken = "previous-telegram-token";
    const plan = {
      ...telegramPlan(hashCredential(previousToken) ?? ""),
      workflow: "start-channel" as const,
    };
    const deps = registryDeps(plan);
    deps.setupMessagingChannels.mockRejectedValue(new Error("invalid Telegram token"));
    vi.stubEnv("TELEGRAM_BOT_TOKEN", previousToken);

    await expect(
      reconcileSandboxMessaging({
        resume: false,
        session: null,
        sandboxName: "alpha",
        agent: { name: "openclaw" },
        env: { TELEGRAM_BOT_TOKEN: "invalid-replacement-token" },
        deps,
      }),
    ).rejects.toThrow("invalid Telegram token");

    expect(deps.setupMessagingChannels).toHaveBeenCalledOnce();
    expect(deps.writePlanToEnv).toHaveBeenCalledWith(plan);
    expect(plan.credentialBindings[0]?.credentialHash).toBe(hashCredential(previousToken));
  });

  it("keeps WeChat selected for start/rebuild when the gateway retains its QR token (#10765)", async () => {
    const credential = wechatManifest.credentials[0];
    const baseline = telegramPlan(hashCredential("previous-wechat-token") ?? "");
    const plan: SandboxMessagingPlan = {
      ...baseline,
      workflow: "start-channel",
      channels: [
        {
          ...baseline.channels[0],
          channelId: wechatManifest.id,
          displayName: wechatManifest.displayName,
          authMode: wechatManifest.auth.mode,
        },
      ],
      credentialBindings: [
        {
          channelId: wechatManifest.id,
          credentialId: credential.id,
          sourceInput: credential.sourceInput,
          providerName: credential.providerName.replaceAll("{sandboxName}", "alpha"),
          providerEnvKey: credential.providerEnvKey,
          placeholder: credential.placeholder,
          credentialAvailable: true,
          credentialHash: hashCredential("previous-wechat-token") ?? "",
        },
      ],
      runtimeSetup: {
        nodePreloads: (wechatManifest.runtime.openclaw.nodePreloads ?? []).map((preload) => ({
          ...preload,
          channelId: wechatManifest.id,
          source: "manifest",
          target: "agent",
        })),
        envAliases: [],
        secretScans: [],
      },
    };
    const deps = registryDeps(plan);
    deps.inspectGatewayCredential.mockReturnValue({ kind: "exact" });
    vi.stubEnv("WECHAT_BOT_TOKEN", "");
    vi.stubEnv("WECHAT_ACCOUNT_ID", "");

    const result = await reconcileSandboxMessaging({
      resume: false,
      session: null,
      sandboxName: "alpha",
      agent: { name: "openclaw" },
      deps,
    });

    expect(result.selectedChannels).toEqual(["wechat"]);
    expect(result.plan?.runtimeSetup?.nodePreloads.map(({ module }) => module)).toContain(
      "wechat-account-placeholder",
    );
    expect(deps.inspectGatewayCredential).toHaveBeenCalledWith(
      "alpha-wechat-bridge",
      MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      "WECHAT_BOT_TOKEN",
    );
    expect(deps.note).not.toHaveBeenCalledWith(expect.stringContaining("disabling the channel"));
  });

  it.each([false, true])(
    "normalizes legacy Slack bindings before gateway probes (resume: %s)",
    async (resume) => {
      const currentPlan = {
        ...slackPlan("previous-slack-bot-hash", "previous-slack-app-hash"),
        workflow: "start-channel" as const,
      };
      const legacyPlan = {
        ...currentPlan,
        credentialBindings: currentPlan.credentialBindings.map((binding) =>
          binding.providerEnvKey === "SLACK_APP_TOKEN"
            ? { ...binding, providerName: "alpha-slack-bridge" }
            : binding,
        ),
      };
      const deps = resume ? reconcileDeps([null]) : registryDeps(legacyPlan);
      deps.inspectGatewayCredential.mockReturnValue({ kind: "exact" });
      deps.providerMatchesGatewayCredential.mockReturnValue(true);
      const probe = resume ? deps.providerMatchesGatewayCredential : deps.inspectGatewayCredential;
      vi.stubEnv("SLACK_BOT_TOKEN", "");
      vi.stubEnv("SLACK_APP_TOKEN", "");

      const result = await reconcileSandboxMessaging({
        resume,
        session: resume
          ? withMessagingCheckpoint(
              completedCheckpointSession(legacyPlan, ["alpha-slack-bridge", "alpha-slack-app"]),
              ["slack"],
            )
          : null,
        sandboxName: "alpha",
        agent: { name: "openclaw" },
        deps,
      });

      expect(result).toEqual({ plan: currentPlan, selectedChannels: ["slack"] });
      expect(probe).toHaveBeenCalledWith(
        "alpha-slack-bridge",
        MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        "SLACK_BOT_TOKEN",
      );
      expect(probe).toHaveBeenCalledWith(
        "alpha-slack-app",
        MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        "SLACK_APP_TOKEN",
      );
      expect(probe).not.toHaveBeenCalledWith(
        "alpha-slack-bridge",
        MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        "SLACK_APP_TOKEN",
      );
      expect(deps.writePlanToEnv).toHaveBeenLastCalledWith(currentPlan);
      expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    },
  );

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

  it.each([
    ["lifecycle selection", false, "add-channel", registryDeps, () => null],
    ["checkpoint resume", true, "onboard", registryDeps, completedCheckpointSession],
    ["recorded resume selection", true, "onboard", recordedResumeDeps, () => null],
  ] as const)(
    "does not stage a reused %s before every gateway probe resolves (#10660)",
    async (_, resume, workflow, depsFor, sessionFor) => {
      const discord = discordPlan(hashCredential("previous-discord-token") ?? "");
      const registryPlan: SandboxMessagingPlan = {
        ...discord,
        workflow,
        channels: [...discord.channels, ...googlechatPlan().channels],
      };
      const deps = depsFor(registryPlan);
      deps.inspectGatewayCredential.mockReturnValue({ kind: "indeterminate" });
      vi.stubEnv("DISCORD_BOT_TOKEN", "");
      vi.stubEnv("GOOGLECHAT_SERVICE_ACCOUNT", "");
      await expect(
        reconcileSandboxMessaging({
          resume,
          session: sessionFor(registryPlan),
          sandboxName: "alpha",
          agent: { name: "openclaw" },
          deps,
        }),
      ).rejects.toThrow(/No messaging state was changed/u);
      expect(deps.writePlanToEnv).not.toHaveBeenCalled();
      expect(deps.clearPlanEnv).not.toHaveBeenCalled();
    },
  );

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

    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(deps.note).toHaveBeenCalledWith(
      expect.stringContaining("No host inputs configure discord"),
    );
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
      "nemoclaw-mcp-v1",
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
      "nemoclaw-mcp-v1",
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
      "nemoclaw-mcp-v1",
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
