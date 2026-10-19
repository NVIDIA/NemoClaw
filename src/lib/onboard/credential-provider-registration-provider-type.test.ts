// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../messaging/provider-profile";
import type { Session } from "../state/onboard-session";
import {
  providerMetadata,
  registrationDeps,
  sandboxInput,
} from "./__test-helpers__/credential-provider-registration.test-fixtures";
import { createCredentialProviderRegistration } from "./credential-provider-registration";
import type { MessagingTokenDef } from "./messaging-prep";

describe("credential provider type contract", () => {
  it("rejects an omitted provider type before inspecting or changing the gateway (#13344)", async () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const runOpenshell = vi.fn();
    const deps = registrationDeps(runOpenshell, session);
    const registration = createCredentialProviderRegistration(deps);
    const secret = "discord-secret-do-not-disclose";
    const tokenDef: MessagingTokenDef = {
      name: "alpha-discord-bridge",
      envKey: "DISCORD_BOT_TOKEN",
      token: secret,
    };

    const failure = await registration
      .stageSandboxCredentialProviders(
        sandboxInput([
          {
            name: tokenDef.name,
            type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
            credentialEnv: tokenDef.envKey,
          },
        ]),
        async () => ({ messagingTokenDefs: [tokenDef] }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Re-run channel setup with a supported profile.");
    expect((failure as Error).message).not.toContain(secret);
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(deps.updateSession).not.toHaveBeenCalled();
  });

  it("preserves a staged receipt when a matching generic provider is planned (#13344)", async () => {
    const providerName = "alpha-discord-bridge";
    const session = { stagedCredentialProviders: [providerName] } as unknown as Session;
    const runOpenshell = vi.fn(() =>
      providerMetadata(providerName, "generic", "DISCORD_BOT_TOKEN"),
    );
    const deps = registrationDeps(runOpenshell, session);
    const registration = createCredentialProviderRegistration(deps);
    const tokenDef: MessagingTokenDef = {
      name: providerName,
      envKey: "DISCORD_BOT_TOKEN",
      token: "discord-secret-do-not-disclose",
      providerType: "generic",
    };

    await expect(
      registration.stageSandboxCredentialProviders(
        sandboxInput([{ name: providerName, type: "generic", credentialEnv: tokenDef.envKey }]),
        async () => ({ messagingTokenDefs: [tokenDef] }),
      ),
    ).rejects.toThrow("has no NemoClaw-owned profile for type 'generic'");

    expect(runOpenshell).not.toHaveBeenCalled();
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(session.stagedCredentialProviders).toEqual([providerName]);
  });
});
