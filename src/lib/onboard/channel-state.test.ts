// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import { resolveDisabledChannels } from "./channel-state";

function plan(sandboxName: string, disabledChannels: readonly string[]): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "rebuild",
    channels: [],
    disabledChannels,
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("onboard channel state helpers", () => {
  it("prefers disabledChannels from a matching env plan", () => {
    const getRegistryDisabledChannels = vi.fn(() => ["discord"]);

    expect(
      resolveDisabledChannels("alpha", {
        readMessagingPlanFromEnv: () => plan("alpha", ["telegram"]),
        loadSession: () => null,
        getRegistryDisabledChannels,
      }),
    ).toEqual(["telegram"]);
    expect(getRegistryDisabledChannels).not.toHaveBeenCalled();
  });

  it("falls back to a matching session plan when env has no matching plan", () => {
    const getRegistryDisabledChannels = vi.fn(() => ["discord"]);

    expect(
      resolveDisabledChannels("alpha", {
        readMessagingPlanFromEnv: () => plan("other", ["slack"]),
        loadSession: () => ({ sandboxName: "alpha", messagingPlan: plan("alpha", ["telegram"]) }),
        getRegistryDisabledChannels,
      }),
    ).toEqual(["telegram"]);
    expect(getRegistryDisabledChannels).not.toHaveBeenCalled();
  });

  it("falls back to the registry when no matching plan exists", () => {
    expect(
      resolveDisabledChannels("alpha", {
        readMessagingPlanFromEnv: () => null,
        loadSession: () => ({ sandboxName: "other", messagingPlan: plan("other", []) }),
        getRegistryDisabledChannels: (sandboxName) => (sandboxName === "alpha" ? ["discord"] : []),
      }),
    ).toEqual(["discord"]);
  });
});
