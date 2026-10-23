// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMessagingPlan } from "../../../../../test/helpers/messaging-plan-fixtures";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../../../messaging/provider-profile";
import { hashCredential } from "../../../security/credential-hash";
import type { SandboxMessagingDeps } from "./sandbox-messaging";
import { reconcileSandboxMessaging } from "./sandbox-messaging";

describe("legacy messaging provider recovery", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("preserves the registry plan when a legacy generic provider holds the missing host credential", async () => {
    const registryPlan = makeMessagingPlan({
      sandboxName: "alpha",
      agent: "openclaw",
      channels: ["discord"],
      credentialBindings: [
        {
          channelId: "discord",
          credentialId: "discordBotToken",
          sourceInput: "botToken",
          providerName: "alpha-discord-bridge",
          providerEnvKey: "DISCORD_BOT_TOKEN",
          placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
          credentialAvailable: true,
          credentialHash: hashCredential("previous-discord-token") ?? "",
        },
      ],
    });
    const originalPlan = structuredClone(registryPlan);
    const deps: SandboxMessagingDeps<{ name: string }> = {
      note: vi.fn(),
      getRecordedMessagingChannelsForResume: vi.fn(() => null),
      setupMessagingChannels: vi.fn(async () => []),
      readMessagingPlanFromEnv: vi.fn(() => null),
      writePlanToEnv: vi.fn(),
      clearPlanEnv: vi.fn(),
      getRegistrySandboxMessagingAuthority: vi.fn(() => ({
        authoritative: true as const,
        plan: registryPlan,
      })),
      inspectGatewayCredential: vi.fn(() => ({ kind: "collision" as const })),
      providerMatchesGatewayCredential: vi.fn(() => false),
    };
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    await expect(
      reconcileSandboxMessaging({
        resume: false,
        session: null,
        sandboxName: "alpha",
        agent: { name: "openclaw" },
        deps,
      }),
    ).rejects.toThrow(/Provide DISCORD_BOT_TOKEN again.*supported profile/u);

    expect(deps.inspectGatewayCredential).toHaveBeenCalledWith(
      "alpha-discord-bridge",
      MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      "DISCORD_BOT_TOKEN",
    );
    expect(deps.setupMessagingChannels).not.toHaveBeenCalled();
    expect(deps.writePlanToEnv).not.toHaveBeenCalled();
    expect(deps.clearPlanEnv).not.toHaveBeenCalled();
    expect(registryPlan).toEqual(originalPlan);
  });
});
