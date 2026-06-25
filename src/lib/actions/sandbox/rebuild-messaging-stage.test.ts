// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Regression: stageMessagingManifestPlanForRebuild() must clear any stale
// NEMOCLAW_MESSAGING_PLAN_B64 and skip planning for agents whose manifest
// declares no messaging support, so a non-messaging sandbox rebuild cannot
// carry messaging-plan state into the Dockerfile patch step.
//
// Loaded from dist/ to match the rest of the rebuild test suite (runner.ts
// loads './platform' via runtime CommonJS `require()` that vitest cannot
// resolve from a TS source file). Run `npm run build:cli` first.

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const requireDist = createRequire(import.meta.url);
const D = (p: string) => requireDist(`../../../../dist/lib/${p}`);

const defs = D("agent/defs.js");
const messaging = D("messaging/index.js") as {
  MessagingSetupApplier: { clearPlanEnv: () => void; writePlanToEnv: (plan: unknown) => void };
};
const { stageMessagingManifestPlanForRebuild } = D("actions/sandbox/rebuild.js") as {
  stageMessagingManifestPlanForRebuild: (
    sandboxName: string,
    sandboxEntry: unknown,
    rebuildAgent: string | null,
    log: (msg: string) => void,
  ) => Promise<unknown>;
};

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
};

describe("stageMessagingManifestPlanForRebuild non-messaging agent guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits the unknown-runtime skip message for any agent whose name is not in the runtime allowlist", async () => {
    const loadAgentSpy = vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "future-non-messaging-agent",
      messagingPlatforms: [],
    });
    const clearPlanEnvSpy = vi.spyOn(messaging.MessagingSetupApplier, "clearPlanEnv");

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
      "Messaging manifest rebuild plan skipped: agent 'future-non-messaging-agent' is not a messaging-capable runtime",
    );
    expect(messages.some((msg) => msg.includes("declares no supported messaging channels"))).toBe(
      false,
    );
    expect(result).toBeNull();
  });

  it("stages an explicit empty rebuild plan so token-backed channels are not rediscovered", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "openclaw",
      messagingPlatforms: ["telegram"],
    });
    const clearPlanEnvSpy = vi.spyOn(messaging.MessagingSetupApplier, "clearPlanEnv");
    const writePlanEnvSpy = vi
      .spyOn(messaging.MessagingSetupApplier, "writePlanToEnv")
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

  it("emits the empty-allowlist skip message for a known agent whose messagingPlatforms is an explicit empty allowlist", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue({
      name: "openclaw",
      messagingPlatforms: [],
    });
    const clearPlanEnvSpy = vi.spyOn(messaging.MessagingSetupApplier, "clearPlanEnv");
    const writePlanEnvSpy = vi.spyOn(messaging.MessagingSetupApplier, "writePlanToEnv");

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
    };

    const messages: string[] = [];
    const result = await stageMessagingManifestPlanForRebuild(
      "openclaw-sandbox",
      sandboxEntryWithStoredPlan,
      "openclaw",
      (msg) => messages.push(msg),
    );

    expect(clearPlanEnvSpy).toHaveBeenCalledTimes(1);
    expect(writePlanEnvSpy).not.toHaveBeenCalled();
    expect(messages).toContain(
      "Messaging manifest rebuild plan skipped: agent 'openclaw' declares no supported messaging channels",
    );
    expect(messages.some((msg) => msg.includes("is not a messaging-capable runtime"))).toBe(false);
    expect(result).toBeNull();
  });
});
