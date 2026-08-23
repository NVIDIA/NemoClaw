// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { detectUnconfiguredMessagingChannels } from "../../messaging-channel-setup";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps, makeMinimalPlan } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

const detectUnconfiguredMessagingChannelsMock = vi.mocked(detectUnconfiguredMessagingChannels);

describe("handleSandboxState Ready sandbox messaging", () => {
  beforeEach(() => {
    detectUnconfiguredMessagingChannelsMock.mockReturnValue([]);
  });

  it("omits an unconfigured host-backed channel when reusing a Ready sandbox (#9283)", async () => {
    const registryPlan = makeMinimalPlan("saved", "openclaw", ["discord"]);
    const disabledPlan = {
      ...registryPlan,
      channels: registryPlan.channels.map((channel) => ({
        ...channel,
        active: false,
        selected: false,
        disabled: true,
      })),
      disabledChannels: ["discord"],
    };
    const session = createSession({ sandboxName: "saved", messagingPlan: registryPlan });
    session.steps.sandbox.status = "complete";
    const writePlanToEnv = vi.fn();
    detectUnconfiguredMessagingChannelsMock.mockReturnValue(["discord"]);
    const { deps, calls, getSession } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: () => ({
        name: "saved",
        pendingRouteReservation: true,
        provider: "provider",
        model: "model",
        endpointUrl: null,
        preferredInferenceApi: "openai-completions",
        toolDisclosure: "progressive",
        fromDockerfile: null,
        hermesAuthMethod: null,
      }),
      getRegistrySandboxMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
      writePlanToEnv,
    });

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(result.selectedMessagingChannels).toEqual([]);
    expect(writePlanToEnv).toHaveBeenLastCalledWith(disabledPlan);
    expect(getSession().messagingPlan).toEqual(disabledPlan);
  });
});
