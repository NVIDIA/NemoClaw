// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Cleanup-path regression: with the new strict `toMessagingAgentId` semantics,
// stale messaging state on a non-messaging agent must still be cleanable
// without raising MessagingAgentNotSupportedError. `channels remove` should
// strip the stored messaging plan from the registry, `channels pause/resume`
// should fail closed (no throw, no plan mutation).

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import * as defs from "../../agent/defs";
import * as registry from "../../state/registry";
import {
  persistManifestChannelDisabledPlan,
  persistManifestChannelRemovePlan,
} from "./policy-channel";

function agentFixture(name: string): defs.AgentDefinition {
  return { name } as defs.AgentDefinition;
}

let getSandboxMock: MockInstance;
let updateSandboxMock: MockInstance;

function entryWithStalePlan(sandboxName: string, channelId: string) {
  return {
    name: sandboxName,
    agent: "custom-agent",
    messaging: {
      schemaVersion: 1,
      plan: {
        schemaVersion: 1,
        sandboxName,
        agent: "openclaw",
        workflow: "rebuild",
        channels: [
          {
            channelId,
            displayName: channelId,
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
}

beforeEach(() => {
  getSandboxMock = vi.spyOn(registry, "getSandbox");
  updateSandboxMock = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("persistManifestChannelRemovePlan with non-messaging agent (#5729)", () => {
  it("strips stale messaging state from the registry without throwing", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue(agentFixture("custom-agent"));
    getSandboxMock.mockReturnValue(entryWithStalePlan("da-test", "discord"));

    const result = await persistManifestChannelRemovePlan("da-test", "discord");

    expect(result).toBe(true);
    expect(updateSandboxMock).toHaveBeenCalledWith("da-test", { messaging: undefined });
  });

  it("returns true and skips registry update when no stale plan exists", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue(agentFixture("custom-agent"));
    getSandboxMock.mockReturnValue({ name: "da-test", agent: "custom-agent" });

    const result = await persistManifestChannelRemovePlan("da-test", "discord");

    expect(result).toBe(true);
    expect(updateSandboxMock).not.toHaveBeenCalled();
  });
});

describe("persistManifestChannelDisabledPlan with non-messaging agent (#5729)", () => {
  it("returns null without throwing or mutating the registry when the agent does not support messaging", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue(agentFixture("custom-agent"));
    getSandboxMock.mockReturnValue(entryWithStalePlan("da-test", "discord"));

    const result = await persistManifestChannelDisabledPlan("da-test", "discord", true);

    expect(result).toBeNull();
    expect(updateSandboxMock).not.toHaveBeenCalled();
  });

  it("returns null without throwing when there is no stored messaging plan", async () => {
    vi.spyOn(defs, "loadAgent").mockReturnValue(agentFixture("custom-agent"));
    getSandboxMock.mockReturnValue({ name: "da-test", agent: "custom-agent" });

    const result = await persistManifestChannelDisabledPlan("da-test", "discord", true);

    expect(result).toBeNull();
    expect(updateSandboxMock).not.toHaveBeenCalled();
  });
});
