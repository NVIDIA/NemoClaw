// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression: stageMessagingManifestPlanForRebuild() must clear any stale
// NEMOCLAW_MESSAGING_PLAN_B64 and skip planning for agents unsupported by
// channel manifests, so a non-messaging sandbox rebuild cannot
// carry messaging-plan state into the Dockerfile patch step.
//
import { afterEach, describe, expect, it, vi } from "vitest";

import * as defs from "../../agent/defs";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import type { SandboxEntry } from "../../state/registry";
import { stageMessagingManifestPlanForRebuild } from "./rebuild-messaging-stage";

const emptyStoredMessagingPlan = {
  schemaVersion: 1,
  sandboxName: "openclaw-sandbox",
  agent: "openclaw",
  workflow: "remove-channel",
  channels: [],
  disabledChannels: [],
  credentialBindings: [],
  networkPolicy: { presets: [], entries: [] },
  agentRender: [],
  buildSteps: [],
  stateUpdates: [],
  healthChecks: [],
} satisfies SandboxMessagingPlan;

describe("stageMessagingManifestPlanForRebuild non-messaging agent guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits the skip message for any agent whose name is not supported by channel manifests", async () => {
    const loadAgentSpy = vi
      .spyOn(defs, "loadAgent")
      .mockReturnValue({ name: "future-non-messaging-agent" } as never);
    const clearPlanEnvSpy = vi.spyOn(MessagingSetupApplier, "clearPlanEnv");

    const messages: string[] = [];
    const result = await stageMessagingManifestPlanForRebuild(
      "future-sandbox",
      { name: "future-sandbox" },
      "future-non-messaging-agent",
      (msg) => messages.push(msg),
    );

    expect(loadAgentSpy).toHaveBeenCalledWith("future-non-messaging-agent");
    expect(clearPlanEnvSpy).toHaveBeenCalledTimes(1);
    expect(messages).toContain(
      "Messaging manifest rebuild plan skipped: agent 'future-non-messaging-agent' is not supported by any channel manifest",
    );
    expect(messages.some((msg) => msg.includes("has no supported messaging channels"))).toBe(false);
    expect(result).toBeNull();
  });

  it("stages an explicit empty rebuild plan so token-backed channels are not rediscovered", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "openclaw" } as never);
    const clearPlanEnvSpy = vi.spyOn(MessagingSetupApplier, "clearPlanEnv");
    const writePlanEnvSpy = vi
      .spyOn(MessagingSetupApplier, "writePlanToEnv")
      .mockImplementation(() => undefined);

    const messages: string[] = [];
    const result = await stageMessagingManifestPlanForRebuild(
      "openclaw-sandbox",
      {
        name: "openclaw-sandbox",
        messaging: { schemaVersion: 1, plan: emptyStoredMessagingPlan },
      },
      "openclaw",
      (msg) => messages.push(msg),
    );

    expect(clearPlanEnvSpy).not.toHaveBeenCalled();
    expect(writePlanEnvSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: "rebuild",
        channels: [],
      }),
    );
    expect(messages).toContain("Messaging manifest rebuild plan staged: no configured channels");
    expect(result).toMatchObject({ workflow: "rebuild", channels: [] });
  });

  it("stages a plan for a known agent using channel-manifest supported channels", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({ name: "openclaw" } as never);
    const clearPlanEnvSpy = vi.spyOn(MessagingSetupApplier, "clearPlanEnv");
    const writePlanEnvSpy = vi.spyOn(MessagingSetupApplier, "writePlanToEnv");

    const sandboxEntryWithStoredPlan = {
      name: "openclaw-sandbox",
      messaging: {
        schemaVersion: 1,
        plan: {
          schemaVersion: 1,
          sandboxName: "openclaw-sandbox",
          agent: "openclaw",
          workflow: "rebuild",
          channels: [
            {
              channelId: "telegram",
              displayName: "telegram",
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
          credentialBindings: [],
          networkPolicy: { presets: [], entries: [] },
          agentRender: [],
          buildSteps: [],
          stateUpdates: [],
          healthChecks: [],
        },
      },
    } satisfies SandboxEntry;

    const messages: string[] = [];
    const result = await stageMessagingManifestPlanForRebuild(
      "openclaw-sandbox",
      sandboxEntryWithStoredPlan,
      "openclaw",
      (msg) => messages.push(msg),
    );

    expect(clearPlanEnvSpy).not.toHaveBeenCalled();
    expect(writePlanEnvSpy).toHaveBeenCalledTimes(1);
    expect(messages).toContain("Messaging manifest rebuild plan staged: telegram");
    expect(result).not.toBeNull();
  });
});
