// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import type { SandboxMessagingPlan } from "../../src/lib/messaging/manifest";
import type { RegistryMessagingAuthority } from "../../src/lib/messaging/plan-authority";
import { decisionSelected, decisionUnset } from "../../src/lib/state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type OnboardCheckpoint,
} from "../../src/lib/state/onboard-checkpoint-types";
import { createSession, type Session } from "../../src/lib/state/onboard-session";
import type { GatewayCredentialOnlyProviderInspection } from "../../src/lib/onboard/gateway-provider-metadata";

const channelIds = ["telegram", "unsupported"];

export function mixedChannelPlan(): SandboxMessagingPlan {
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

export function channelIdsFrom<T extends { readonly channelId: string }>(
  entries: readonly T[],
): string[] {
  return entries.map((entry) => entry.channelId);
}

export function telegramPlan(credentialHash: string): SandboxMessagingPlan {
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

export function discordPlan(
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

export function withChannelDisabled(
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

export function whatsappPlan(): SandboxMessagingPlan {
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

export function googlechatPlan(): SandboxMessagingPlan {
  return {
    ...telegramPlan(""),
    channels: [
      {
        channelId: "googlechat",
        displayName: "Google Chat",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    // A bridge channel mints its provider from a profile, so it renders no binding.
    credentialBindings: [],
  };
}

export function slackPlan(
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

export function completedCheckpointSession(
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

export function withMessagingCheckpoint(
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

export function reconcileDeps(plans: readonly (SandboxMessagingPlan | null)[]) {
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
    inspectGatewayCredential: vi.fn<
      (name: string, type: string, credentialEnv: string) => GatewayCredentialOnlyProviderInspection
    >(() => ({ kind: "missing" })),
    providerMatchesGatewayCredential: vi.fn(() => false),
  };
}

export function registryDeps(plan: SandboxMessagingPlan) {
  const deps = reconcileDeps([]);
  deps.getRegistrySandboxMessagingAuthority.mockReturnValue({ authoritative: true, plan });
  return deps;
}

export function recordedResumeDeps(plan: SandboxMessagingPlan) {
  const deps = reconcileDeps([plan]);
  deps.getRecordedMessagingChannelsForResume.mockReturnValue(["discord", "googlechat"]);
  return deps;
}
