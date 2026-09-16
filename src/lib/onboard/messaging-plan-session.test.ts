// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeMessagingPlan } from "../../../test/helpers/messaging-plan-fixtures";
import { messagingChannelsWithReusableGatewayCredentials } from "./messaging-plan-session";

describe("messagingChannelsWithReusableGatewayCredentials", () => {
  it.each([
    ["openclaw", "google-chat-bridge"],
    ["hermes", "google-chat-hermes-bridge"],
  ] as const)(
    "reuses active Google Chat for %s only while its gateway-minted bridge provider matches",
    async (agent, providerType) => {
      const plan = makeMessagingPlan({ channels: ["googlechat"], agent });
      const matches = vi.fn(async (name: string, type: string, credentialEnv: string) =>
        name === "my-assistant-googlechat-bridge" &&
        type === providerType &&
        credentialEnv === "GOOGLE_CHAT_ACCESS_TOKEN"
          ? { kind: "exact" as const }
          : { kind: "missing" as const },
      );

      await expect(messagingChannelsWithReusableGatewayCredentials(plan, matches)).resolves.toEqual(
        ["googlechat"],
      );
      expect(matches).toHaveBeenCalledExactlyOnceWith(
        "my-assistant-googlechat-bridge",
        providerType,
        "GOOGLE_CHAT_ACCESS_TOKEN",
      );
      await expect(
        messagingChannelsWithReusableGatewayCredentials(plan, async () => ({ kind: "missing" })),
      ).resolves.toEqual([]);
    },
  );
});
