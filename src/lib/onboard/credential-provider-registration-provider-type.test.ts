// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { REPOSITORY_ROOT } from "../core/repository-root";
import { buildCredentialFamilyProfile } from "../messaging/applier/credential-family-profile";

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
  it.each([false, true])(
    "inspects the stored extended Discord profile without requiring a separate base import (drift=%s)",
    async (drift) => {
      const providerName = "alpha-discord-bridge";
      const baseType = "discord-hermes-static-v1";
      const key = "DISCORD_BOT_TOKEN";
      const keys = [key, `${key}_TEAM`];
      const generated = buildCredentialFamilyProfile(
        fs.readFileSync(
          `${REPOSITORY_ROOT}/src/lib/messaging/channels/discord/provider-profile/hermes.yaml`,
          "utf8",
        ),
        key,
        keys,
      );
      const exported = JSON.parse(generated.source);
      exported.endpoints.push(...(drift ? [{ host: "unowned.example", port: 443 }] : []));
      const runOpenshell = vi
        .fn()
        .mockReturnValueOnce(providerMetadata(providerName, generated.profileType, keys.join(", ")))
        .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(exported), stderr: "" })
        .mockReturnValue({ status: 1, stdout: "", stderr: "profile not found" });
      const deps = registrationDeps(runOpenshell, {
        stagedCredentialProviders: [],
      } as unknown as Session);
      deps.root = REPOSITORY_ROOT;
      const registration = createCredentialProviderRegistration(deps);

      await expect(
        registration.inspectGatewayCredential(providerName, baseType, key),
      ).resolves.toEqual({
        kind: drift ? "indeterminate" : "exact",
      });
      expect(runOpenshell.mock.calls.map(([args]) => args)).toEqual([
        ["provider", "get", "-g", "test-gateway", providerName],
        [
          "provider",
          "profile",
          "-g",
          "test-gateway",
          "export",
          generated.profileType,
          "--output",
          "json",
        ],
      ]);
    },
  );

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
