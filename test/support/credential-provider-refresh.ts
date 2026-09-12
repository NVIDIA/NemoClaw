// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";

import * as providerAdapters from "../../src/lib/adapters/openshell/provider-adapter-cli";
import { applyCredentialsAtOpenShell } from "../../src/lib/messaging/applier/openshell-provider";
import { MessagingSetupApplier } from "../../src/lib/messaging/applier/setup-applier";
import type { SandboxMessagingPlan } from "../../src/lib/messaging/manifest";
import type { Session } from "../../src/lib/state/onboard-session";
import { createCredentialProviderRegistration } from "../../src/lib/onboard/credential-provider-registration";
import { MESSAGING_BRIDGE_PENDING_VALUE } from "../../src/lib/onboard/messaging-bridge-provider";

export const providerName = "alpha-googlechat-bridge";
export const credentialKey = "GOOGLE_CHAT_ACCESS_TOKEN";
export const privateKey = "test-google-chat-private-key";
export const plan: SandboxMessagingPlan = {
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

export function refreshLifecycle(publishToken = true) {
  vi.stubEnv("GOOGLECHAT_SERVICE_ACCOUNT", undefined);
  const tokenDef = {
    name: providerName,
    envKey: credentialKey,
    token: MESSAGING_BRIDGE_PENDING_VALUE,
    providerType: "google-chat-bridge",
  };
  let revision = 0;
  let tokenExpiresAt = 0;
  let status: string | null = null;
  let writePending = false;
  const adapter: providerAdapters.CliOpenShellProviderAdapter = {
    ...providerAdapters.createCliOpenShellProviderAdapter({
      run: () => {
        throw new Error("Unexpected OpenShell command");
      },
    }),
    getProvider: vi.fn(async () => {
      if (!revision)
        return {
          ok: false as const,
          error: {
            kind: "command" as const,
            reason: "not_found" as const,
            message: "provider not found",
          },
        };
      const value = {
        name: providerName,
        type: tokenDef.providerType,
        credentialKeys: [credentialKey],
        configKeys: [],
        revision: { id: "provider-1", resourceVersion: revision },
      };
      if (writePending && publishToken) {
        revision += 1;
        writePending = false;
      }
      return { ok: true as const, value };
    }),
    createProvider: vi.fn(async () => {
      revision = 1;
      return { ok: true as const };
    }),
    updateProvider: vi.fn(async () => {
      revision += 1;
      return { ok: true as const };
    }),
    deleteProvider: vi.fn(async () => {
      revision = 0;
      return { ok: true as const };
    }),
    importProviderProfile: vi.fn(() => ({ ok: true as const })),
    configureProviderRefresh: vi.fn(async () => {
      status = "configured";
      return { ok: true as const };
    }),
    getProviderRefreshStatus: vi.fn(async () => {
      if (status === "configured" && tokenExpiresAt === 0) {
        tokenExpiresAt = 3_600_000;
        status = "refreshed";
        writePending = true;
      }
      return { ok: true as const, value: { status } };
    }),
  };
  vi.spyOn(providerAdapters, "createCliOpenShellProviderAdapter").mockReturnValue(adapter);
  const apply = vi
    .spyOn(MessagingSetupApplier, "applyCredentialsAtOpenShell")
    .mockImplementation((input, options) =>
      applyCredentialsAtOpenShell(input, { ...options, now: () => 0, sleep: async () => {} }),
    );
  vi.spyOn(MessagingSetupApplier, "readPlanFromEnv").mockReturnValue(plan);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const session = { stagedCredentialProviders: [] } as unknown as Session;
  const registration = createCredentialProviderRegistration({
    root: process.cwd(),
    runOpenshell: vi.fn(),
    getGatewayName: () => "test-gateway",
    getCredential: () =>
      JSON.stringify({ client_email: "bot@example.test", private_key: privateKey }),
    updateSession: (mutator) => mutator(session) ?? session,
    stagedLegacyValues: new Map(),
    migratedLegacyKeys: new Set(),
    persistMigratedLegacyKeys: vi.fn(),
  });
  const stage = () =>
    registration.stageSandboxCredentialProviders(
      {
        sandboxName: "alpha",
        enabledChannels: ["googlechat"],
        webSearchConfig: null,
        agent: { name: "openclaw" },
        requiredBindings: [
          { name: providerName, type: tokenDef.providerType, credentialEnv: credentialKey },
        ],
      },
      async () => ({ messagingTokenDefs: [tokenDef] }),
    );
  const materialize = () =>
    registration.applyMessagingProviders([tokenDef], {
      replaceExisting: true,
      allowedSandboxes: ["alpha"],
    });
  const options = () => apply.mock.calls[0]![1];
  return { adapter, stage, materialize, options, session, log };
}
