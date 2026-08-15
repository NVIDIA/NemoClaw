// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { MessagingSetupApplier } from "../messaging";
import type { Session } from "../state/onboard-session";
import { resolveDisabledChannels } from "./channel-state";

function sessionWithPlan(
  sandboxName: string,
  disabledChannels: readonly string[],
): Pick<Session, "sandboxName" | "messagingPlan"> {
  return {
    sandboxName,
    messagingPlan: {
      schemaVersion: 1,
      sandboxName,
      agent: "openclaw",
      workflow: "onboard",
      channels: disabledChannels.map((channelId) => ({
        channelId,
        displayName: channelId,
        authMode: "none",
        active: false,
        selected: false,
        configured: false,
        disabled: true,
        inputs: [],
        hooks: [],
      })),
      disabledChannels,
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    },
  };
}

describe("onboard channel state helpers", () => {
  it("prefers the staged env messaging plan for default callers", () => {
    MessagingSetupApplier.writePlanToEnv(sessionWithPlan("alpha", ["slack"]).messagingPlan!);
    try {
      expect(resolveDisabledChannels("alpha")).toEqual(["slack"]);
    } finally {
      MessagingSetupApplier.clearPlanEnv();
    }
  });

  it("prefers the registry plan for an existing sandbox", () => {
    const registryPlan = sessionWithPlan("alpha", ["discord"]).messagingPlan;

    expect(
      resolveDisabledChannels("alpha", {
        loadSession: () => sessionWithPlan("alpha", ["telegram"]),
        getRegistryMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
      }),
    ).toEqual(["discord"]);
  });

  it("uses registry disabled channels without loading the saved session or environment plan", () => {
    const registryPlan = sessionWithPlan("alpha", ["discord"]).messagingPlan;
    const loadSession = vi.fn(() => {
      throw new Error("invalid saved session");
    });
    const readMessagingPlanFromEnv = vi.fn(() => {
      throw new Error("invalid environment plan");
    });

    expect(
      resolveDisabledChannels("alpha", {
        loadSession,
        readMessagingPlanFromEnv,
        getRegistryMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
      }),
    ).toEqual(["discord"]);
    expect(loadSession).not.toHaveBeenCalled();
    expect(readMessagingPlanFromEnv).not.toHaveBeenCalled();
  });

  it("uses the staged plan for a new sandbox", () => {
    expect(
      resolveDisabledChannels("alpha", {
        loadSession: () => null,
        readMessagingPlanFromEnv: () => sessionWithPlan("alpha", ["slack"]).messagingPlan,
        getRegistryMessagingAuthority: () => ({ authoritative: false, plan: null }),
      }),
    ).toEqual(["slack"]);
  });

  it("uses a matching session plan when no registry or staged plan exists", () => {
    expect(
      resolveDisabledChannels("alpha", {
        loadSession: () => sessionWithPlan("alpha", ["telegram"]),
        readMessagingPlanFromEnv: () => null,
        getRegistryMessagingAuthority: () => ({ authoritative: false, plan: null }),
      }),
    ).toEqual(["telegram"]);
  });
});
