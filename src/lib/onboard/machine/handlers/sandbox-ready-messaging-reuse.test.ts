// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashCredential } from "../../../security/credential-hash";
import { createSession } from "../../../state/onboard-session";
import { detectUnconfiguredMessagingChannels } from "../../messaging-channel-setup";
import { handleSandboxState } from "./sandbox";
import {
  baseOptions,
  createDeps,
  makeMinimalPlan,
  withTelegramCredentialHash,
} from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

const detectUnconfiguredMessagingChannelsMock = vi.mocked(detectUnconfiguredMessagingChannels);

describe("Ready sandbox messaging reuse", () => {
  beforeEach(() => detectUnconfiguredMessagingChannelsMock.mockReturnValue([]));

  it("keeps the durable plan unchanged when a gateway credential is missing", async () => {
    const registryPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential("previous-telegram-token"),
    );
    const session = createSession({ sandboxName: "saved", messagingPlan: registryPlan });
    session.steps.sandbox.status = "complete";
    const recordStateSkipped = vi.fn(async () => session);
    const writePlanToEnv = vi.fn();
    detectUnconfiguredMessagingChannelsMock.mockReturnValue(["telegram"]);
    const { deps, calls, getSession } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getSandboxRegistryEntry: () => ({
          name: "saved",
          pendingRouteReservation: true,
          reservationSessionId: session.sessionId,
          provider: "provider",
          model: "model",
          endpointUrl: null,
          preferredInferenceApi: "openai-completions",
          toolDisclosure: "progressive",
          fromDockerfile: null,
          hermesAuthMethod: null,
        }),
        getRegistrySandboxMessagingAuthority: () => ({
          authoritative: true,
          plan: registryPlan,
        }),
        inspectGatewayCredential: () => ({ kind: "missing" }),
        writePlanToEnv,
        recordStateSkipped,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
      }),
    ).rejects.toThrow(
      /Ready sandbox 'saved'.*running sandbox and durable messaging plan were not changed/u,
    );

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(recordStateSkipped).not.toHaveBeenCalled();
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(getSession().messagingPlan).toEqual(registryPlan);
  });
});
