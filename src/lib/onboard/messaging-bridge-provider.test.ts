// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { ChannelManifest } from "../messaging/manifest";
import {
  bridgeProviderNamesForChannel,
  bridgeSecretEnvsForChannel,
  buildMessagingBridgeRefreshMaterial,
  collectMessagingBridgeTokenDefs,
  listMessagingBridgeProfiles,
  matchesRegisteredMessagingBridgeProfile,
  MESSAGING_BRIDGE_PENDING_VALUE,
  type MessagingBridgeProfile,
  type RefreshingMessagingBridgeProfile,
} from "./messaging-bridge-provider";

const SA_JSON = JSON.stringify({
  client_email: "bot@p.iam.gserviceaccount.com",
  private_key: "fake-test-private-key-material",
});
const normalizeCredentialValue = (v: unknown) => String(v ?? "").trim();

// Injected in-memory profile mirroring the co-located google-chat-bridge profile,
// so the unit tests do not touch the filesystem or the manifest registry.
const GC_PROFILE: RefreshingMessagingBridgeProfile = {
  channelId: "googlechat",
  agent: "openclaw",
  profilePath: "/repo/src/lib/messaging/channels/googlechat/provider-profile/openclaw.yaml",
  profileId: "google-chat-bridge",
  credentialKey: "GOOGLE_CHAT_ACCESS_TOKEN",
  strategy: "google_service_account_jwt",
  scopes: ["https://www.googleapis.com/auth/chat.bot"],
  secretMaterialKeys: ["private_key"],
  sourceSecretEnv: "GOOGLECHAT_SERVICE_ACCOUNT",
};

const GC_PROFILE_DOC = {
  id: GC_PROFILE.profileId,
  credentials: [
    {
      name: "access_token",
      env_vars: [GC_PROFILE.credentialKey],
      required: true,
      auth_style: "bearer",
      header_name: "Authorization",
      query_param: "",
      refresh: {
        strategy: GC_PROFILE.strategy,
        scopes: GC_PROFILE.scopes,
        material: [
          { name: "client_email", required: true, secret: false },
          { name: "private_key", required: true, secret: true },
          { name: "scope", required: false, secret: false },
        ],
      },
    },
  ],
  endpoints: [{ host: "chat.googleapis.com", port: 443 }],
  binaries: ["/usr/local/bin/node", "/usr/bin/node"],
  inference_capable: false,
};

// Google Chat is the one channel shipping a profile per agent, so a sandbox must
// pick exactly one. Hermes also needs pubsub on top of chat.bot: one token, both
// scopes, because `:pull` 403s without it.
const GC_HERMES_PROFILE: MessagingBridgeProfile = {
  ...GC_PROFILE,
  agent: "hermes",
  profilePath: "/repo/src/lib/messaging/channels/googlechat/provider-profile/hermes.yaml",
  profileId: "google-chat-bridge-hermes",
};

const DISCORD_PROFILE: MessagingBridgeProfile = {
  channelId: "discord",
  agent: "hermes",
  profilePath: "/repo/src/lib/messaging/channels/discord/provider-profile/hermes.yaml",
  profileId: "discord-hermes-static-v1",
  credentialKey: "DISCORD_BOT_TOKEN",
  strategy: null,
  scopes: [],
  secretMaterialKeys: [],
  sourceSecretEnv: "DISCORD_BOT_TOKEN",
};

const DISCORD_PROFILE_DOC = {
  id: DISCORD_PROFILE.profileId,
  display_name: "Discord Bot (Hermes)",
  description: "Endpointless Discord bot credential for sandbox policy binding",
  category: "agent",
  credentials: [
    {
      name: "bot_token",
      description: "Discord bot token",
      env_vars: [DISCORD_PROFILE.credentialKey],
      required: true,
      auth_style: "header",
      header_name: "Authorization",
      query_param: "",
    },
  ],
  endpoints: [],
  binaries: [],
  inference_capable: false,
};

function collectInput(
  overrides: Partial<Parameters<typeof collectMessagingBridgeTokenDefs>[0]> = {},
) {
  return {
    sandboxName: "sbx",
    agent: GC_PROFILE.agent,
    getCredential: () => null,
    enabledChannels: ["googlechat"],
    disabledChannelNames: new Set<string>(),
    profiles: [GC_PROFILE],
    ...overrides,
  };
}

describe("collectMessagingBridgeTokenDefs", () => {
  it("returns nothing when the bridge channel is disabled", () => {
    expect(
      collectMessagingBridgeTokenDefs(
        collectInput({
          getCredential: () => SA_JSON,
          disabledChannelNames: new Set(["googlechat"]),
        }),
      ),
    ).toEqual([]);
  });

  it("returns nothing when the bridge channel is not enabled", () => {
    expect(
      collectMessagingBridgeTokenDefs(
        collectInput({ getCredential: () => SA_JSON, enabledChannels: ["slack"] }),
      ),
    ).toEqual([]);
  });

  it("returns nothing when the source secret is unavailable", () => {
    expect(collectMessagingBridgeTokenDefs(collectInput())).toEqual([]);
  });

  it("emits the bridge token def when the secret is in the store", () => {
    expect(collectMessagingBridgeTokenDefs(collectInput({ getCredential: () => SA_JSON }))).toEqual(
      [
        {
          name: "sbx-googlechat-bridge",
          envKey: GC_PROFILE.credentialKey,
          token: MESSAGING_BRIDGE_PENDING_VALUE,
          providerType: GC_PROFILE.profileId,
        },
      ],
    );
  });

  it("emits only the profile whose agent matches the sandbox", () => {
    // Both profiles carry the same channelId, so filtering on the channel alone
    // would configure the OpenClaw bridge on a Hermes sandbox and the reverse.
    const defs = collectMessagingBridgeTokenDefs(
      collectInput({
        agent: "hermes",
        getCredential: () => SA_JSON,
        profiles: [GC_PROFILE, GC_HERMES_PROFILE],
      }),
    );

    expect(defs.map((def) => def.providerType)).toEqual([GC_HERMES_PROFILE.profileId]);
  });

  it("emits the bridge token def from an env-only secret (resolution parity)", () => {
    const defs = collectMessagingBridgeTokenDefs(
      collectInput({
        getCredential: () => null,
        env: { [GC_PROFILE.sourceSecretEnv]: SA_JSON },
        normalizeCredentialValue,
      }),
    );
    expect(defs[0]?.providerType).toBe(GC_PROFILE.profileId);
    expect(defs[0]?.envKey).toBe(GC_PROFILE.credentialKey);
  });
});

describe("matchesRegisteredMessagingBridgeProfile", () => {
  it("accepts only the checked-in static credential boundary", () => {
    const runOpenshell = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify(DISCORD_PROFILE_DOC),
    }));

    expect(
      matchesRegisteredMessagingBridgeProfile(DISCORD_PROFILE.profileId, {
        root: "/repo",
        profiles: [DISCORD_PROFILE],
        readFileSync: () => YAML.stringify(DISCORD_PROFILE_DOC),
        runOpenshell,
      }),
    ).toBe(true);
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "export", DISCORD_PROFILE.profileId, "--output", "json"],
      expect.objectContaining({ suppressOutput: true, timeout: 30_000 }),
    );
  });

  it("rejects a registered static profile with endpoint authority", () => {
    const runOpenshell = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        ...DISCORD_PROFILE_DOC,
        endpoints: [{ host: "gateway.discord.gg", port: 443 }],
      }),
    }));

    expect(
      matchesRegisteredMessagingBridgeProfile(DISCORD_PROFILE.profileId, {
        root: "/repo",
        profiles: [DISCORD_PROFILE],
        readFileSync: () => YAML.stringify(DISCORD_PROFILE_DOC),
        runOpenshell,
      }),
    ).toBe(false);
  });

  it("rejects a registered refreshing profile with altered refresh authority", () => {
    const runOpenshell = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        ...GC_PROFILE_DOC,
        credentials: [
          {
            ...GC_PROFILE_DOC.credentials[0],
            refresh: {
              ...GC_PROFILE_DOC.credentials[0].refresh,
              scopes: [...GC_PROFILE.scopes, "https://www.googleapis.com/auth/cloud-platform"],
            },
          },
        ],
      }),
    }));

    expect(
      matchesRegisteredMessagingBridgeProfile(GC_PROFILE.profileId, {
        root: "/repo",
        profiles: [GC_PROFILE],
        readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
        runOpenshell,
      }),
    ).toBe(false);
  });

  it("does not apply the static-profile check to other provider types", () => {
    const runOpenshell = vi.fn();

    expect(
      matchesRegisteredMessagingBridgeProfile("generic", {
        root: "/repo",
        profiles: [DISCORD_PROFILE],
        runOpenshell,
      }),
    ).toBeNull();
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});

describe("listMessagingBridgeProfiles", () => {
  it("uses OpenShell's canonical refresh contract in both checked-in Google Chat profiles (#10971)", () => {
    const googleChatProfiles = listMessagingBridgeProfiles()
      .filter((profile) => profile.channelId === "googlechat")
      .map(({ agent, profileId, strategy }) => ({ agent, profileId, strategy }))
      .sort((left, right) => left.agent.localeCompare(right.agent));

    expect(googleChatProfiles).toEqual([
      {
        agent: "hermes",
        profileId: "google-chat-hermes-bridge",
        strategy: "google_service_account_jwt",
      },
      {
        agent: "openclaw",
        profileId: "google-chat-bridge",
        strategy: "google_service_account_jwt",
      },
    ]);
  });

  it.each(["openclaw", "hermes"] as const)(
    "accepts OpenShell's canonical Google Chat export for %s (#10971)",
    (agent) => {
      const profile = listMessagingBridgeProfiles().find(
        (candidate) => candidate.channelId === "googlechat" && candidate.agent === agent,
      );
      expect(profile).toBeDefined();

      const checkedIn = fs.readFileSync(profile!.profilePath, "utf8");
      const canonicalExport = YAML.parse(checkedIn) as {
        credentials: Array<Record<string, unknown> & {
          refresh?: {
            material?: Array<Record<string, unknown> & { required?: boolean; secret?: boolean }>;
          };
        }>;
      };
      canonicalExport.credentials = canonicalExport.credentials.map((credential) => ({
        ...credential,
        ...(credential.refresh
          ? {
              refresh: {
                ...credential.refresh,
                material: (credential.refresh.material ?? []).map((material) => ({
                  ...material,
                  required: material.required ?? false,
                  secret: material.secret ?? false,
                })),
              },
            }
          : {}),
      }));

      expect(
        matchesRegisteredMessagingBridgeProfile(profile!.profileId, {
          root: "/repo",
          profiles: [profile!],
          readFileSync: () => checkedIn,
          runOpenshell: () => ({ status: 0, stdout: JSON.stringify(canonicalExport) }),
        }),
      ).toBe(true);
    },
  );

  it("discovers a co-located bridge profile from injected manifests and YAML", () => {
    const manifest: ChannelManifest = {
      schemaVersion: 1,
      id: GC_PROFILE.channelId,
      displayName: "Fixture chat",
      supportedAgents: [GC_PROFILE.agent],
      auth: { mode: "token-paste" },
      inputs: [
        {
          id: "serviceAccount",
          kind: "secret",
          required: true,
          envKey: GC_PROFILE.sourceSecretEnv,
        },
      ],
      credentials: [],
      render: [],
      hooks: [],
    };

    expect(
      listMessagingBridgeProfiles({
        root: "/repo",
        manifests: [manifest],
        existsSync: () => true,
        readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      }),
    ).toEqual([GC_PROFILE]);
  });
});

describe("bridgeProviderNamesForChannel (PRA-8: channels remove teardown)", () => {
  it("returns the gateway-minted bridge provider for a credentials:[] channel", () => {
    // The dangling-provider case: a bridge channel has no channelTokenKeys, so
    // `channels remove` must still find its provider to detach + delete.
    expect(bridgeProviderNamesForChannel("sbx", "googlechat", [GC_PROFILE])).toEqual([
      "sbx-googlechat-bridge",
    ]);
  });

  it("returns nothing for a channel that has no bridge profile", () => {
    expect(bridgeProviderNamesForChannel("sbx", "telegram", [GC_PROFILE])).toEqual([]);
  });

  it("dedupes when a channel declares the same bridge for multiple agents", () => {
    expect(
      bridgeProviderNamesForChannel("sbx", "googlechat", [
        GC_PROFILE,
        { ...GC_PROFILE, agent: "hermes" },
      ]),
    ).toEqual(["sbx-googlechat-bridge"]);
  });
});

describe("bridgeSecretEnvsForChannel", () => {
  it("names the source-secret env var so enable-time callers can fail loudly", () => {
    expect(bridgeSecretEnvsForChannel("googlechat", [GC_PROFILE])).toEqual([
      "GOOGLECHAT_SERVICE_ACCOUNT",
    ]);
  });

  it("returns nothing for a channel without a bridge profile", () => {
    expect(bridgeSecretEnvsForChannel("telegram", [GC_PROFILE])).toEqual([]);
  });

  it("dedupes across per-agent profiles sharing one secret env", () => {
    expect(
      bridgeSecretEnvsForChannel("googlechat", [GC_PROFILE, { ...GC_PROFILE, agent: "hermes" }]),
    ).toEqual(["GOOGLECHAT_SERVICE_ACCOUNT"]);
  });
});

describe("buildMessagingBridgeRefreshMaterial", () => {
  it.each([
    ["malformed JSON", "{", "service account JSON could not be parsed"],
    [
      "missing required fields",
      JSON.stringify({}),
      "service account JSON missing client_email/private_key",
    ],
  ])("rejects %s without producing refresh material", (_case, secret, reason) => {
    const result = buildMessagingBridgeRefreshMaterial(GC_PROFILE, secret);

    expect(result).toEqual({ ok: false, reason });
    expect(result).not.toHaveProperty("material");
  });
});
