// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { resolveDisabledChannels } from "./channel-state";
import { MessagingSetupApplier } from "../messaging";
import type { Session } from "../state/onboard-session";

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
      channels: [],
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

  it("prefers disabledChannels from the onboard session mirror", () => {
    const getRegistryDisabledChannels = vi.fn(() => ["discord"]);

    expect(
      resolveDisabledChannels("alpha", {
        loadSession: () => sessionWithPlan("alpha", ["telegram"]),
        getRegistryDisabledChannels,
      }),
    ).toEqual(["telegram"]);
    expect(getRegistryDisabledChannels).not.toHaveBeenCalled();
  });

  it("falls back to the registry when the session has no mirror", () => {
    expect(
      resolveDisabledChannels("alpha", {
        loadSession: () => sessionWithPlan("beta", ["telegram"]),
        getRegistryDisabledChannels: (sandboxName) => (sandboxName === "alpha" ? ["discord"] : []),
      }),
    ).toEqual(["discord"]);
  });

  it("treats an empty session mirror as authoritative", () => {
    const getRegistryDisabledChannels = vi.fn(() => ["telegram"]);

    expect(
      resolveDisabledChannels("alpha", {
        loadSession: () => sessionWithPlan("alpha", []),
        getRegistryDisabledChannels,
      }),
    ).toEqual([]);
    expect(getRegistryDisabledChannels).not.toHaveBeenCalled();
  });
});
