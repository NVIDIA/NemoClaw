// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { MessagingSetupApplier } from "../messaging/applier/setup-applier";
import type { SandboxMessagingPlan } from "../messaging/manifest";
import type { Session } from "../state/onboard-session";
import {
  type CredentialProviderRegistrationDeps,
  createCredentialProviderRegistration,
} from "./credential-provider-registration";
import { MESSAGING_BRIDGE_PENDING_VALUE } from "./messaging-bridge-provider";

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

describe("onboarding provider refresh forwarding", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards Google Chat refresh material to the messaging applier (#9806)", async () => {
    const privateKey = "test-google-chat-private-key";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const serviceAccount = JSON.stringify({
      client_email: "bot@example.test",
      private_key: privateKey,
    });
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const runOpenshell = vi.fn();
    const deps: CredentialProviderRegistrationDeps = {
      root: process.cwd(),
      runOpenshell: runOpenshell as unknown as CredentialProviderRegistrationDeps["runOpenshell"],
      getGatewayName: () => "test-gateway",
      getCredential: (key) => (key === "GOOGLECHAT_SERVICE_ACCOUNT" ? serviceAccount : null),
      updateSession: vi.fn(
        (mutator: (current: Session) => Session | void): Session => mutator(session) ?? session,
      ),
      stagedLegacyValues: new Map(),
      migratedLegacyKeys: new Set(),
      persistMigratedLegacyKeys: vi.fn(),
    };
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
    const registration = createCredentialProviderRegistration(deps);
    const plan = googleChatPlan();

    const providerNames = await registration.applyMessagingProviders(
      [
        {
          name: providerName,
          envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
          token: MESSAGING_BRIDGE_PENDING_VALUE,
          providerType: "google-chat-bridge",
        },
      ],
      {},
      deps.runOpenshell,
      plan,
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
            strategy: "google_service_account_jwt",
            material: [
              { key: "client_email", value: "bot@example.test" },
              { key: "scope", value: "https://www.googleapis.com/auth/chat.bot" },
            ],
            secretMaterial: [{ key: "private_key", value: privateKey }],
          },
        ],
      }),
    );
    const applyOptions = apply.mock.calls[0]?.[1];
    expect(applyOptions?.refreshes?.flatMap(({ secretMaterial }) => secretMaterial)).toEqual([
      { key: "private_key", value: privateKey },
    ]);
    expect(JSON.stringify(applyOptions).split(privateKey)).toHaveLength(2);
    expect(JSON.stringify(applyOptions?.definitions)).not.toContain(privateKey);
    expect(
      JSON.stringify(applyOptions?.refreshes?.flatMap(({ material }) => material)),
    ).not.toContain(privateKey);
    expect(JSON.stringify({ providerNames, diagnostics: consoleError.mock.calls })).not.toContain(
      privateKey,
    );
    expect(JSON.stringify({ plan, session })).not.toContain(privateKey);
    expect(deps.persistMigratedLegacyKeys).not.toHaveBeenCalled();
  });
});
