// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as registry from "../../state/registry";
import type { SandboxMessagingPlan } from "../manifest";
import { MessagingHostStateApplier } from "./host-state-applier";
import { MessagingSetupApplier } from "./setup-applier";

vi.mock("../../state/registry", () => {
  const sandboxes = new Map<string, Record<string, unknown>>();
  return {
    __clear: () => sandboxes.clear(),
    __getSandbox: (name: string) => sandboxes.get(name) ?? null,
    __setSandbox: (name: string, entry: Record<string, unknown>) =>
      sandboxes.set(name, { ...entry }),
    getSandbox: vi.fn((name: string) => sandboxes.get(name) ?? null),
    updateSandbox: vi.fn((name: string, updates: Record<string, unknown>) => {
      const entry = sandboxes.get(name);
      if (!entry) return false;
      Object.assign(entry, updates);
      return true;
    }),
  };
});

const registryMock = registry as typeof registry & {
  __clear(): void;
  __getSandbox(name: string): Record<string, unknown> | null;
  __setSandbox(name: string, entry: Record<string, unknown>): void;
};

describe("MessagingHostStateApplier", () => {
  beforeEach(() => {
    registryMock.__clear();
    vi.clearAllMocks();
  });

  it("builds durable messaging state from the manifest plan env", () => {
    const env: NodeJS.ProcessEnv = {};
    const plan = makePlan(["telegram"]);

    MessagingSetupApplier.writePlanToEnv(plan, { env });
    const state = MessagingHostStateApplier.readPlanStateFromEnv({ env });

    expect(state).toEqual({
      schemaVersion: 1,
      plan,
    });
  });

  it("stores only the new messaging state on an existing sandbox entry", () => {
    registryMock.__setSandbox("demo", {
      name: "demo",
    });
    const plan = makePlan(["telegram"]);

    const updated = MessagingHostStateApplier.applyPlanToRegistry("demo", plan);

    expect(updated).toBe(true);
    expect(registry.updateSandbox).toHaveBeenCalledWith("demo", {
      messaging: {
        schemaVersion: 1,
        plan,
      },
    });
    expect(registryMock.__getSandbox("demo")).toMatchObject({
      messaging: {
        schemaVersion: 1,
        plan,
      },
    });
    expect(registryMock.__getSandbox("demo")).not.toHaveProperty("messagingChannels");
    expect(registryMock.__getSandbox("demo")).not.toHaveProperty("disabledChannels");
  });

  it("can merge a single-channel add plan into existing messaging state", () => {
    registryMock.__setSandbox("demo", {
      name: "demo",
      messaging: MessagingHostStateApplier.buildStateFromPlan(makePlan(["telegram"])),
    });

    const updated = MessagingHostStateApplier.applyPlanToRegistry(
      "demo",
      makePlan(["slack"], {
        credentialBindings: [
          makeCredentialBinding("slack", "bot"),
          makeCredentialBinding("slack", "app"),
        ],
      }),
      { mode: "merge" },
    );

    expect(updated).toBe(true);
    const entry = registryMock.__getSandbox("demo");
    const plan = (entry?.messaging as { plan: SandboxMessagingPlan }).plan;
    expect(plan.channels.map((channel) => channel.channelId)).toEqual(["telegram", "slack"]);
    expect(plan.credentialBindings.map((binding) => binding.providerEnvKey)).toEqual([
      "TELEGRAM_BOT_TOKEN",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ]);
    expect(plan.networkPolicy.presets).toEqual(["slack", "telegram"]);
  });
});

function makePlan(
  channelIds: readonly string[],
  overrides: Partial<SandboxMessagingPlan> = {},
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "demo",
    agent: "openclaw",
    workflow: "add-channel",
    channels: channelIds.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode:
        channelId === "wechat"
          ? "host-qr"
          : channelId === "whatsapp"
            ? "in-sandbox-qr"
            : "token-paste",
      active: true,
      selected: true,
      configured: true,
      disabled: false,
      inputs: [],
      hooks: [],
    })),
    disabledChannels: [],
    credentialBindings: channelIds.flatMap((channelId) => makeCredentialBindings(channelId)),
    networkPolicy: {
      presets: [...channelIds],
      entries: channelIds.map((channelId) => makePolicyEntry(channelId)),
    },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
    ...overrides,
  };
}

function makeCredentialBindings(
  channelId: string,
): SandboxMessagingPlan["credentialBindings"][number][] {
  if (channelId === "slack") {
    return [makeCredentialBinding("slack", "bot"), makeCredentialBinding("slack", "app")];
  }
  if (channelId === "whatsapp") return [];
  return [makeCredentialBinding(channelId, "bot")];
}

function makeCredentialBinding(
  channelId: string,
  credentialId: string,
): SandboxMessagingPlan["credentialBindings"][number] {
  if (channelId === "slack" && credentialId === "app") {
    return {
      channelId,
      credentialId: "slackAppToken",
      sourceInput: "appToken",
      providerName: "demo-slack-app",
      providerEnvKey: "SLACK_APP_TOKEN",
      placeholder: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
      credentialAvailable: true,
    };
  }
  const envKey = `${channelId.toUpperCase()}_BOT_TOKEN`;
  return {
    channelId,
    credentialId: `${channelId}BotToken`,
    sourceInput: "botToken",
    providerName: `demo-${channelId}-bridge`,
    providerEnvKey: envKey,
    placeholder:
      channelId === "slack"
        ? "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN"
        : `openshell:resolve:env:${envKey}`,
    credentialAvailable: true,
  };
}

function makePolicyEntry(
  channelId: string,
): SandboxMessagingPlan["networkPolicy"]["entries"][number] {
  return {
    channelId,
    presetName: channelId,
    policyKeys:
      channelId === "telegram"
        ? ["telegram_bot"]
        : channelId === "wechat"
          ? ["wechat_bridge"]
          : [channelId],
    source: "manifest",
  };
}
