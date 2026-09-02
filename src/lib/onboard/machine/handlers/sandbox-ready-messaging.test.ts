// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("handleSandboxState Ready sandbox messaging", () => {
  beforeEach(() => {
    detectUnconfiguredMessagingChannelsMock.mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps a Ready channel when its credential remains at the gateway", async () => {
    const minimalPlan = makeMinimalPlan("saved", "openclaw", ["discord"]);
    const registryPlan = {
      ...minimalPlan,
      credentialBindings: [
        {
          channelId: "discord",
          credentialId: "discordBotToken",
          sourceInput: "botToken",
          providerName: "saved-discord-bridge",
          providerEnvKey: "DISCORD_BOT_TOKEN",
          placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
          credentialAvailable: true,
          credentialHash: hashCredential("previous-discord-token") ?? "",
        },
      ],
    };
    const session = createSession({ sandboxName: "saved", messagingPlan: registryPlan });
    session.steps.sandbox.status = "complete";
    const writePlanToEnv = vi.fn();
    detectUnconfiguredMessagingChannelsMock.mockReturnValue(["discord"]);
    const { deps, calls, getSession } = createDeps(
      {
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
        inspectGatewayCredential: () => ({ kind: "exact" }),
        writePlanToEnv,
      },
      session,
    );

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(result.selectedMessagingChannels).toEqual(["discord"]);
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(getSession().messagingPlan).toEqual(registryPlan);
  });

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
        getRegistrySandboxMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
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

  it("rejects Ready reuse when a matching host credential has no gateway provider", async () => {
    const token = "123456:unchanged-telegram-token";
    const registryPlan = withTelegramCredentialHash(
      makeMinimalPlan("saved", "openclaw", ["telegram"]),
      hashCredential(token),
    );
    const session = createSession({ sandboxName: "saved", messagingPlan: registryPlan });
    session.steps.sandbox.status = "complete";
    const recordStateSkipped = vi.fn(async () => session);
    const writePlanToEnv = vi.fn();
    const inspectGatewayCredential = vi.fn(() => ({ kind: "missing" as const }));
    vi.stubEnv("TELEGRAM_BOT_TOKEN", token);
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
        getRegistrySandboxMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
        inspectGatewayCredential,
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
    ).rejects.toThrow(/Ready sandbox 'saved'.*durable messaging plan were not changed/u);

    expect(inspectGatewayCredential).toHaveBeenCalledWith(
      "saved-telegram-bridge",
      "nemoclaw-mcp-v1",
      "TELEGRAM_BOT_TOKEN",
    );
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(recordStateSkipped).not.toHaveBeenCalled();
    expect(writePlanToEnv).not.toHaveBeenCalled();
    expect(getSession().messagingPlan).toEqual(registryPlan);
  });
});
