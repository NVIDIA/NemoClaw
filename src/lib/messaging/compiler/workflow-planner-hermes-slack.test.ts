// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { applyMessagingAgentRenderToObject } from "../applier/build/messaging-build-applier.mts";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../channels";
import { createBuiltInMessagingHookRegistry } from "../hooks";
import type { SandboxMessagingPlan } from "../manifest";
import { MessagingWorkflowPlanner } from "./workflow-planner";

const TEST_CREDENTIALS: Readonly<Record<string, string>> = {
  SLACK_BOT_TOKEN: "xoxb-test-slack-token",
  SLACK_APP_TOKEN: "xapp-test-slack-token",
};

function planner(): MessagingWorkflowPlanner {
  return new MessagingWorkflowPlanner(
    createBuiltInChannelManifestRegistry(),
    createBuiltInMessagingHookRegistry({
      common: {
        env: {},
        getCredential: (key) => TEST_CREDENTIALS[key] ?? null,
        saveCredential: () => {},
        prompt: async () => "unused",
        log: () => {},
      },
      slack: {
        validateCredentials: {
          log: () => {},
          validateCredentials: () => ({ ok: true }),
        },
      },
    }),
    createBuiltInRenderTemplateResolver(),
  );
}

function renderHermesPlatforms(plan: SandboxMessagingPlan): Record<string, unknown> {
  const config: { platforms: Record<string, unknown> } = { platforms: {} };
  applyMessagingAgentRenderToObject(config, plan, "~/.hermes/config.yaml");
  return config.platforms;
}

function sandboxEntry(plan: SandboxMessagingPlan) {
  return {
    name: "demo",
    messaging: { schemaVersion: 1 as const, plan },
  };
}

describe("Hermes Slack lifecycle rendering", () => {
  it("renders rich blocks only while Slack is active and removes every Slack entry (#6443)", async () => {
    const lifecyclePlanner = planner();
    const existingPlan = await lifecyclePlanner.buildPlan({
      sandboxName: "demo",
      agent: "hermes",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["slack"],
      credentialAvailability: {
        SLACK_BOT_TOKEN: true,
        SLACK_APP_TOKEN: true,
      },
    });

    expect(renderHermesPlatforms(existingPlan).slack).toEqual({
      enabled: true,
      extra: { rich_blocks: true },
    });

    const stopped = await lifecyclePlanner.buildChannelStopPlanFromSandboxEntry({
      sandboxName: "demo",
      agent: "hermes",
      sandboxEntry: sandboxEntry(existingPlan),
      channelId: "slack",
    });

    expect(stopped?.channels.find((channel) => channel.channelId === "slack")).toMatchObject({
      active: false,
      disabled: true,
    });
    expect(renderHermesPlatforms(stopped!).slack).toBeUndefined();

    const started = await lifecyclePlanner.buildChannelStartPlanFromSandboxEntry({
      sandboxName: "demo",
      agent: "hermes",
      sandboxEntry: sandboxEntry(stopped!),
      channelId: "slack",
    });

    expect(started?.channels.find((channel) => channel.channelId === "slack")).toMatchObject({
      active: true,
      disabled: false,
    });
    expect(renderHermesPlatforms(started!).slack).toEqual({
      enabled: true,
      extra: { rich_blocks: true },
    });

    const removed = await lifecyclePlanner.buildChannelRemovePlanFromSandboxEntry({
      sandboxName: "demo",
      agent: "hermes",
      sandboxEntry: sandboxEntry(started!),
      channelId: "slack",
    });

    expect(removed?.workflow).toBe("remove-channel");
    expect(removed?.channels).toEqual([]);
    expect(renderHermesPlatforms(removed!).slack).toBeUndefined();
    expect(removed?.credentialBindings.some((entry) => entry.channelId === "slack")).toBe(false);
    expect(removed?.networkPolicy.entries.some((entry) => entry.channelId === "slack")).toBe(false);
    expect(removed?.agentRender.some((entry) => entry.channelId === "slack")).toBe(false);
  });
});
