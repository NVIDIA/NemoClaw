// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import * as store from "../../credentials/store";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import { policyChannelDependencies } from "./policy-channel-dependencies";

const providerName = "alpha-googlechat-bridge";

function googleChatPlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "onboard",
    channels: [],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("policy channel provider refresh", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards Google Chat refresh material to the messaging applier (#9806)", async () => {
    const privateKey = "test-google-chat-private-key";
    const serviceAccount = JSON.stringify({
      client_email: "bot@example.test",
      private_key: privateKey,
    });
    vi.spyOn(store, "getCredential").mockImplementation((key) =>
      key === "GOOGLECHAT_SERVICE_ACCOUNT" ? serviceAccount : null,
    );
    const apply = vi.spyOn(MessagingSetupApplier, "applyCredentialsAtOpenShell").mockResolvedValue({
      upserted: [],
      reused: [
        {
          channelId: "googlechat",
          credentialId: "GOOGLE_CHAT_ACCESS_TOKEN",
          providerName,
          envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
        },
      ],
      missing: [],
      replacedProviderNames: [],
      providerNames: [providerName],
      sandboxCreateProviderArgs: ["--provider", providerName],
    });
    const plan = googleChatPlan();

    const providerNames = await policyChannelDependencies.upsertMessagingProviders(
      [
        {
          name: providerName,
          envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
          token: "openshell-managed-pending-mint",
          providerType: "google-chat-bridge",
        },
      ],
      "nemoclaw",
      { replaceExisting: true },
      {
        plan,
        channelName: "googlechat",
        sandboxAgent: "openclaw",
        sandboxName: "alpha",
        revalidateSandboxIdentity: vi.fn(),
      },
    );

    expect(providerNames).toEqual([providerName]);
    expect(apply).toHaveBeenCalledExactlyOnceWith(
      plan,
      expect.objectContaining({
        refreshes: [
          {
            channelId: "googlechat",
            providerName,
            credentialKey: "GOOGLE_CHAT_ACCESS_TOKEN",
            strategy: "google-service-account-jwt",
            material: [
              { key: "client_email", value: "bot@example.test" },
              { key: "scope", value: "https://www.googleapis.com/auth/chat.bot" },
            ],
            secretMaterial: [{ key: "private_key", value: privateKey }],
          },
        ],
      }),
    );
    expect(JSON.stringify(providerNames)).not.toContain(privateKey);
  });
});
