// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../manifest";
import { compactSandboxMessagingPlanForPersistence } from "../persistence";
import { MessagingHostStateApplier } from "./host-state-applier";
import { MessagingSetupApplier } from "./setup-applier";
import * as registry from "../../state/registry";

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
  });

  it("hydrates compact existing plans before merging host state", () => {
    registryMock.__setSandbox("demo", {
      name: "demo",
      messaging: {
        schemaVersion: 1,
        plan: compactSandboxMessagingPlanForPersistence(makePlan(["telegram"])),
      },
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
    expect(
      plan.channels
        .find((channel) => channel.channelId === "telegram")
        ?.hooks.some((hook) => hook.channelId === "telegram"),
    ).toBe(true);
    expect(plan.agentRender.some((entry) => entry.channelId === "telegram")).toBe(true);
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
      authMode: "token-paste",
      active: true,
      selected: true,
      configured: true,
      disabled: false,
      inputs: [],
      hooks: [],
    })),
    disabledChannels: [],
    credentialBindings: channelIds.map((channelId) => makeCredentialBinding(channelId, "bot")),
    networkPolicy: {
      presets: [...channelIds],
      entries: channelIds.map((channelId) => ({
        channelId,
        presetName: channelId,
        policyKeys: [channelId],
        source: "manifest",
      })),
    },
    agentRender: channelIds.map((channelId) => ({
      channelId,
      agent: "openclaw",
      target: "openclaw.json",
      kind: "json-fragment",
      path: `channels.${channelId}`,
      value: { enabled: true },
      templateRefs: [],
    })),
    buildSteps: [],
    stateUpdates: channelIds.map((channelId) => ({
      channelId,
      kind: "persist-inputs",
      stateKey: channelId,
      inputIds: [],
    })),
    healthChecks: [],
    ...overrides,
  };
}

function makeCredentialBinding(
  channelId: string,
  credentialId: string,
): SandboxMessagingPlan["credentialBindings"][number] {
  const envKey =
    channelId === "slack" && credentialId === "app"
      ? "SLACK_APP_TOKEN"
      : `${channelId.toUpperCase()}_BOT_TOKEN`;
  return {
    channelId,
    credentialId,
    sourceInput: credentialId,
    providerName: `demo-${channelId}-${credentialId}`,
    providerEnvKey: envKey,
    placeholder: `\${${envKey}}`,
    credentialAvailable: true,
  };
}
