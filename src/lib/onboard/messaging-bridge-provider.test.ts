// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { OPENSHELL_OPERATION_TIMEOUT_MS } from "../adapters/openshell/provider-command";
import { createBuiltInChannelManifestRegistry } from "../messaging/channels";
import {
  bridgeProviderNamesForChannel,
  bridgeSecretEnvsForChannel,
  collectMessagingBridgeTokenDefs,
  configureMessagingBridgeRefreshes,
  ensureMessagingBridgeProfiles,
  listMessagingBridgeProfiles,
  matchesRegisteredStaticMessagingProfile,
  MESSAGING_BRIDGE_PENDING_VALUE,
  type MessagingBridgeProfile,
  refreshStatusForCredential,
} from "./messaging-bridge-provider";

const SA_JSON = JSON.stringify({
  client_email: "bot@p.iam.gserviceaccount.com",
  private_key: "fake-test-private-key-material",
});
const normalizeCredentialValue = (v: unknown) => String(v ?? "").trim();
const redact = (s: string) => s;
const noLog = vi.fn();

// `openshell provider refresh status` output as the CLI prints it, so the parser
// meets real ANSI-decorated column runs.
const STATUS_HEADER =
  "\u001B[1mPROVIDER                \u001B[0m  \u001B[1mCREDENTIAL_KEY              \u001B[0m  " +
  "\u001B[1mSTRATEGY                    \u001B[0m  \u001B[1mSTATUS            \u001B[0m  \u001B[1mEXPIRES_AT\u001B[0m";
const statusTable = (status: string) =>
  `${STATUS_HEADER}\nsbx-googlechat-bridge  GOOGLE_CHAT_ACCESS_TOKEN      ` +
  `google_service_account_jwt    ${status}           2026-08-25 12:18:05`;
const MINTED_STATUS_TABLE = statusTable("refreshed");
const PENDING_STATUS_TABLE = statusTable("configured");

// Injected in-memory profile mirroring the co-located google-chat-bridge profile,
// so the unit tests do not touch the filesystem or the manifest registry.
const GC_PROFILE: MessagingBridgeProfile = {
  channelId: "googlechat",
  agent: "openclaw",
  profilePath: "/repo/src/lib/messaging/channels/googlechat/provider-profile/openclaw.yaml",
  profileId: "google-chat-bridge",
  credentialKey: "GOOGLE_CHAT_ACCESS_TOKEN",
  strategy: "google-service-account-jwt",
  scopes: ["https://www.googleapis.com/auth/chat.bot"],
  secretMaterialKeys: ["private_key"],
  sourceSecretEnv: "GOOGLECHAT_SERVICE_ACCOUNT",
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

// Synthetic exported-profile JSON matching GC_PROFILE's checked-in boundary —
// unlike DISCORD_PROFILE_DOC, a refreshing profile legitimately grants
// endpoint/binary authority, so this is not the empty-endpoints/binaries
// static-profile shape.
const GC_PROFILE_DOC = {
  id: GC_PROFILE.profileId,
  credentials: [
    {
      name: "access_token",
      env_vars: [GC_PROFILE.credentialKey],
      required: true,
      auth_style: "header",
      header_name: "Authorization",
      query_param: "",
    },
  ],
  endpoints: [{ host: "chat.googleapis.com", port: 443, protocol: "rest", access: "read-write" }],
  binaries: ["/usr/bin/node"],
  inference_capable: false,
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

const DISCORD_MANIFEST = createBuiltInChannelManifestRegistry()
  .list()
  .find((manifest) => manifest.id === DISCORD_PROFILE.channelId)!;
const SYNTHETIC_DISCORD_MANIFEST = {
  ...DISCORD_MANIFEST,
  supportedAgents: [DISCORD_PROFILE.agent],
};

function discoverSyntheticDiscordProfile(doc: Record<string, unknown>) {
  return listMessagingBridgeProfiles({
    root: "/repo",
    manifests: [SYNTHETIC_DISCORD_MANIFEST],
    existsSync: () => true,
    readFileSync: () => YAML.stringify(doc),
  });
}

const STATIC_DEF = {
  name: "sbx-discord-bridge",
  providerType: DISCORD_PROFILE.profileId,
  token: "fixture-discord-token",
};

const GC_PUBSUB_SCOPES = [
  "https://www.googleapis.com/auth/chat.bot",
  "https://www.googleapis.com/auth/pubsub",
];

const BRIDGE_DEF = {
  name: "sbx-googlechat-bridge",
  providerType: GC_PROFILE.profileId,
  token: MESSAGING_BRIDGE_PENDING_VALUE,
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

describe("configureMessagingBridgeRefreshes", () => {
  it("is a no-op success when there is no bridge token def", () => {
    const runOpenshell = vi.fn();
    const result = configureMessagingBridgeRefreshes([], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result).toEqual({ ok: true });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("fails closed when the secret is unavailable", () => {
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell: vi.fn(),
      redact,
      getCredential: () => null,
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed when the service account JSON cannot be parsed", () => {
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell: vi.fn(),
      redact,
      getCredential: () => "not json",
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed when client_email or private_key is missing", () => {
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell: vi.fn(),
      redact,
      getCredential: () => JSON.stringify({ client_email: "x@y" }),
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed when client_email or private_key is blank", () => {
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell: vi.fn(),
      redact,
      getCredential: () => JSON.stringify({ client_email: " ", private_key: "\n" }),
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result.ok).toBe(false);
  });

  it("keeps private keys off argv while configuring refresh", () => {
    const secretEnvName = "MESSAGING_BRIDGE_SECRET_0";
    const parentSecret = process.env[secretEnvName];
    const runOpenshell = vi.fn((_args: string[], _opts: { env?: NodeJS.ProcessEnv }) => ({
      status: 0,
      stdout: MINTED_STATUS_TABLE,
    }));
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result).toEqual({ ok: true });
    expect(runOpenshell).toHaveBeenCalledTimes(2);
    const args = runOpenshell.mock.calls[0][0];
    expect(args.slice(0, 3)).toEqual(["provider", "refresh", "configure"]);
    expect(args).toContain(GC_PROFILE.credentialKey);
    expect(args).toContain("google-service-account-jwt");
    expect(args).toContain("client_email=bot@p.iam.gserviceaccount.com");
    expect(args).toContain("scope=https://www.googleapis.com/auth/chat.bot");
    expect(args).toContain("--secret-material-env");
    expect(args).toContain(`private_key=${secretEnvName}`);
    expect(args.join(" ")).not.toContain("fake-test-private-key-material");
    expect(args).toContain("sbx-googlechat-bridge");
    const options = runOpenshell.mock.calls[0][1];
    expect(options.env).toEqual({ [secretEnvName]: "fake-test-private-key-material" });
    expect(process.env[secretEnvName]).toBe(parentSecret);
  });

  it("mints one token carrying every scope the profile declares", () => {
    // Hermes reads Pub/Sub and writes Chat with the same minted token, so sending
    // only the first scope leaves `:pull` rejected with 403 at runtime.
    const runOpenshell = vi.fn((_args: string[], _opts: { env?: NodeJS.ProcessEnv }) => ({
      status: 0,
      stdout: MINTED_STATUS_TABLE,
    }));

    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [{ ...GC_PROFILE, scopes: GC_PUBSUB_SCOPES }],
    });

    expect(result).toEqual({ ok: true });
    const args = runOpenshell.mock.calls[0][0];
    expect(args).toContain(`scope=${GC_PUBSUB_SCOPES.join(" ")}`);
    expect(args).not.toContain(`scope=${GC_PUBSUB_SCOPES[0]}`);
  });

  it("forces private_key off argv even when the profile omits it from secretMaterialKeys", () => {
    // A misconfigured / edited / reused profile that marks other material secret
    // but not private_key must still never leak the raw key into argv.
    const misconfigured: MessagingBridgeProfile = {
      ...GC_PROFILE,
      secretMaterialKeys: ["client_email"],
    };
    const runOpenshell = vi.fn((_args: string[], _opts: { env?: NodeJS.ProcessEnv }) => ({
      status: 0,
      stdout: MINTED_STATUS_TABLE,
    }));
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [misconfigured],
    });
    expect(result).toEqual({ ok: true });
    const args = runOpenshell.mock.calls[0][0];
    expect(args).toContain("--secret-material-env");
    // The raw private key travels by env reference, never as a --material argv value.
    expect(args.join(" ")).not.toContain("fake-test-private-key-material");
    const options = runOpenshell.mock.calls[0][1];
    expect(Object.values(options.env ?? {})).toContain("fake-test-private-key-material");
  });

  it("fails closed when runOpenshell exits nonzero", () => {
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "gateway rejected the material" }));
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("resolves the secret from the injected env too (parity)", () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: MINTED_STATUS_TABLE }));
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => null,
      env: { [GC_PROFILE.sourceSecretEnv]: SA_JSON },
      normalizeCredentialValue,
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result).toEqual({ ok: true });
    expect(runOpenshell).toHaveBeenCalledTimes(2);
  });

  it("waits for the first mint before reporting the bridge configured", () => {
    const runOpenshell = vi.fn((_args: string[], _opts: unknown) => ({
      status: 0,
      stdout: MINTED_STATUS_TABLE,
    }));
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
      sleep: () => undefined,
    });
    expect(result).toEqual({ ok: true });
    const statusArgs = runOpenshell.mock.calls[1][0];
    expect(statusArgs.slice(0, 3)).toEqual(["provider", "refresh", "status"]);
    expect(statusArgs).toContain("sbx-googlechat-bridge");
    expect(statusArgs).toContain(GC_PROFILE.credentialKey);
  });

  it("fails closed when the gateway never mints the first token", () => {
    // Reporting success here would let onboarding create the sandbox while the
    // provider still holds the create-time sentinel:
    // - The sandbox captures that environment once, at boot.
    // - The agent would authenticate with the sentinel for the life of the
    //   container, and the channel API would reject every outbound reply.
    const runOpenshell = vi.fn((_args: string[], _opts: unknown) => ({
      status: 0,
      stdout: PENDING_STATUS_TABLE,
    }));
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
      sleep: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("configured");
  });

  it("rejects a refreshed row printed by a failed status command", () => {
    // A nonzero probe can still print a stale table; trusting it would create
    // the sandbox against an unminted credential.
    const runOpenshell = vi.fn((args: string[], _opts: unknown) => ({
      status: args[1] === "refresh" && args[2] === "status" ? 1 : 0,
      stdout: MINTED_STATUS_TABLE,
    }));
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
      sleep: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unknown");
  });

  it("stops at the overall deadline when each probe burns command time", () => {
    // Attempts alone do not bound the wait: a hanging probe spends its own time.
    let clock = 0;
    const runOpenshell = vi.fn((_args: string[], _opts: unknown) => {
      clock += 60_000;
      return { status: 0, stdout: PENDING_STATUS_TABLE };
    });
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
      sleep: () => undefined,
      now: () => clock,
    });
    expect(result.ok).toBe(false);
    // Six probes at a minute each cross the five-minute deadline well before
    // the fifty-attempt cap.
    expect(runOpenshell.mock.calls.filter((call) => call[0][2] === "status").length).toBeLessThan(
      10,
    );
  });

  it("bounds each status probe with a command timeout", () => {
    const runOpenshell = vi.fn((_args: string[], _opts: unknown) => ({
      status: 0,
      stdout: MINTED_STATUS_TABLE,
    }));
    configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
      sleep: () => undefined,
    });
    const statusCall = runOpenshell.mock.calls.find((call) => call[0][2] === "status");
    expect(statusCall?.[1]).toMatchObject({ timeout: 15_000 });
  });
});

describe("refreshStatusForCredential", () => {
  it("reads the STATUS cell out of the CLI table", () => {
    expect(refreshStatusForCredential(MINTED_STATUS_TABLE, "GOOGLE_CHAT_ACCESS_TOKEN")).toBe(
      "refreshed",
    );
    expect(refreshStatusForCredential(PENDING_STATUS_TABLE, "GOOGLE_CHAT_ACCESS_TOKEN")).toBe(
      "configured",
    );
  });

  it("returns an empty status when the credential has no row", () => {
    expect(refreshStatusForCredential(STATUS_HEADER, "GOOGLE_CHAT_ACCESS_TOKEN")).toBe("");
    expect(refreshStatusForCredential("", "GOOGLE_CHAT_ACCESS_TOKEN")).toBe("");
  });
});

describe("ensureMessagingBridgeProfiles", () => {
  const baseDeps = () => ({
    root: "/repo",
    redact,
    log: noLog,
    exit: vi.fn(() => undefined as never),
    profiles: [GC_PROFILE],
  });

  it("does nothing when there is no bridge token def", () => {
    const runOpenshell = vi.fn();
    ensureMessagingBridgeProfiles([], { ...baseDeps(), runOpenshell });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("imports the profile from its co-located path when not yet registered", () => {
    let imported = false;
    const runOpenshell = vi.fn((args: string[], _opts: unknown) => {
      const importsProfile = args.includes("import");
      imported = imported || importsProfile;
      return importsProfile
        ? { status: 0 }
        : imported
          ? { status: 0, stdout: JSON.stringify(GC_PROFILE_DOC) }
          : { status: 1, stderr: "custom provider profile not found" };
    });
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
    });
    const importCall = runOpenshell.mock.calls.find((call) => call[0].includes("import"));
    expect(importCall?.[0].slice(0, 4)).toEqual(["provider", "profile", "import", "--file"]);
    expect(importCall?.[0]).toContain(GC_PROFILE.profilePath);
    expect(exit).not.toHaveBeenCalled();
  });

  it("skips the import when the profile is already registered", () => {
    // A fresh onboard registers bridge providers twice; the second pass must not
    // re-import and trigger OpenShell's "already exists / import failed" output.
    const runOpenshell = vi.fn((_args: string[], _opts: unknown) => ({
      status: 0,
      stdout: JSON.stringify(GC_PROFILE_DOC),
    }));
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
    });
    expect(runOpenshell.mock.calls.some((call) => call[0].includes("import"))).toBe(false);
    const exportCall = runOpenshell.mock.calls.find((call) => call[0].includes("export"));
    expect(exportCall?.[0]).toEqual([
      "provider",
      "profile",
      "export",
      GC_PROFILE.profileId,
      "--output",
      "json",
    ]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("accepts an existing static profile only when its credential boundary matches", () => {
    const runOpenshell = vi.fn((_args: string[], _opts: unknown) => ({
      status: 0,
      stdout: JSON.stringify(DISCORD_PROFILE_DOC),
    }));
    const exit = vi.fn(() => undefined as never);

    ensureMessagingBridgeProfiles([STATIC_DEF], {
      ...baseDeps(),
      profiles: [DISCORD_PROFILE],
      readFileSync: () => YAML.stringify(DISCORD_PROFILE_DOC),
      runOpenshell,
      exit,
    });

    expect(runOpenshell).toHaveBeenCalledTimes(1);
    expect(runOpenshell.mock.calls[0]?.[0]).toEqual([
      "provider",
      "profile",
      "export",
      DISCORD_PROFILE.profileId,
      "--output",
      "json",
    ]);
    expect(exit).not.toHaveBeenCalled();
  });

  it.each([
    ["endpoint authority", { endpoints: [{ host: "gateway.discord.gg", port: 443 }] }],
    ["binary authority", { binaries: ["/usr/bin/curl"] }],
    [
      "credential configuration",
      {
        credentials: [
          {
            ...DISCORD_PROFILE_DOC.credentials[0],
            header_name: "X-Discord-Token",
          },
        ],
      },
    ],
  ])("rejects an existing static profile with different %s", (_label, override) => {
    const exported = { ...DISCORD_PROFILE_DOC, ...override };
    const runOpenshell = vi.fn((_args: string[], _opts: unknown) => ({
      status: 0,
      stdout: JSON.stringify(exported),
    }));
    const exit = vi.fn(() => undefined as never);

    ensureMessagingBridgeProfiles([STATIC_DEF], {
      ...baseDeps(),
      profiles: [DISCORD_PROFILE],
      readFileSync: () => YAML.stringify(DISCORD_PROFILE_DOC),
      runOpenshell,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(runOpenshell.mock.calls.some((call) => call[0].includes("import"))).toBe(false);
  });

  it("rejects a mismatched static profile that wins an import race", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "custom provider profile not found" })
      .mockReturnValueOnce({ status: 1, stderr: "profile already exists" })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ ...DISCORD_PROFILE_DOC, binaries: ["/usr/bin/curl"] }),
      });
    const exit = vi.fn(() => undefined as never);

    ensureMessagingBridgeProfiles([STATIC_DEF], {
      ...baseDeps(),
      profiles: [DISCORD_PROFILE],
      readFileSync: () => YAML.stringify(DISCORD_PROFILE_DOC),
      runOpenshell,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(runOpenshell).toHaveBeenCalledTimes(3);
  });

  it("tolerates an already-registered profile without exiting", () => {
    // First export: not yet registered. Import: lost the race. Post-race
    // export: the winning profile matches the checked-in boundary.
    let exportCalls = 0;
    const runOpenshell = vi.fn((args: string[]) =>
      !args.includes("export")
        ? { status: 1, stderr: "profile already exists" }
        : (exportCalls += 1) === 1
          ? { status: 1, stderr: "custom provider profile not found" }
          : { status: 0, stdout: JSON.stringify(GC_PROFILE_DOC) },
    );
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits when profile import fails for another reason", () => {
    const runOpenshell = vi.fn((args: string[]) =>
      args.includes("export")
        ? { status: 1, stderr: "custom provider profile not found" }
        : { status: 1, stderr: "connection refused" },
    );
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], { ...baseDeps(), runOpenshell, exit });
    expect(exit).toHaveBeenCalled();
  });

  it("exits without importing when the profile probe fails for a reason other than missing", () => {
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 1, stderr: "gateway unreachable" }));
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], { ...baseDeps(), runOpenshell, exit });
    expect(exit).toHaveBeenCalledWith(1);
    expect(runOpenshell.mock.calls.some((call) => call[0].includes("import"))).toBe(false);
  });

  it("reports and redacts a timeout without importing the profile", () => {
    const runOpenshell = vi.fn((_args: string[]) => ({
      status: null,
      stderr: "",
      stdout: "",
      error: new Error("spawnSync openshell ETIMEDOUT secret-value"),
    }));
    const exit = vi.fn(() => undefined as never);
    const log = vi.fn();
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      redact: (text) => text.replaceAll("secret-value", "[REDACTED]"),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
      log,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(runOpenshell.mock.calls.some((call) => call[0].includes("import"))).toBe(false);
    const logged = log.mock.calls.flat().join("\n");
    expect(logged).toContain("ETIMEDOUT");
    expect(logged).toContain("[REDACTED]");
    expect(logged).not.toContain("secret-value");
  });

  it("tolerates the existing-profile diagnostic across a wrapped, box-drawn terminal line (#10371)", () => {
    // Same failure shape as the web-search race check (#10159/#10371): a
    // plain, unnormalized substring test would miss "already exists" split
    // across a box-drawing continuation and fall through to a hard failure
    // instead of tolerating the race.
    let exportCalls = 0;
    const runOpenshell = vi.fn((args: string[]) =>
      !args.includes("export")
        ? { status: 1, stderr: "custom provider profile 'google-chat-bridge' already\n │ exists" }
        : (exportCalls += 1) === 1
          ? { status: 1, stderr: "custom provider profile not found" }
          : { status: 0, stdout: JSON.stringify(GC_PROFILE_DOC) },
    );
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
    });
    expect(exit).not.toHaveBeenCalled();
  });

  it("passes the bounded OpenShell operation timeout to the probe and the import", () => {
    const runOpenshell = vi.fn((args: string[]) =>
      args.includes("export")
        ? { status: 1, stderr: "custom provider profile not found" }
        : { status: 0 },
    );
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], { ...baseDeps(), runOpenshell, exit });
    const calls = runOpenshell.mock.calls as unknown as Array<[string[], { timeout?: number }]>;
    const timeouts = calls.map(([, options]) => options.timeout);
    expect(timeouts).toEqual(calls.map(() => OPENSHELL_OPERATION_TIMEOUT_MS));
  });

  it("suppresses import output when a concurrent importer creates the profile", () => {
    // If a concurrent onboard imports the profile after this probe reports it
    // missing, OpenShell's "already exists" import diagnostic must stay
    // suppressed — the code re-exports and recovers, so that diagnostic
    // would misleadingly read as a failure even though onboarding succeeds.
    let exportCalls = 0;
    const runOpenshell = vi.fn((args: string[], _options: { suppressOutput?: boolean }) =>
      !args.includes("export")
        ? { status: 1, stderr: "profile already exists" }
        : (exportCalls += 1) === 1
          ? { status: 1, stderr: "custom provider profile not found" }
          : { status: 0, stdout: JSON.stringify(GC_PROFILE_DOC) },
    );
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
    });
    expect(exit).not.toHaveBeenCalled();
    const importCall = runOpenshell.mock.calls.find((call) => call[0].includes("import"));
    expect(importCall?.[1]?.suppressOutput).toBe(true);
  });

  it("rejects an existing refreshing profile whose credential boundary drifted from the checked-in YAML", () => {
    const drifted = { ...GC_PROFILE_DOC, endpoints: [{ host: "evil.example", port: 443 }] };
    const runOpenshell = vi.fn((_args: string[]) => ({
      status: 0,
      stdout: JSON.stringify(drifted),
    }));
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(runOpenshell.mock.calls.some((call) => call[0].includes("import"))).toBe(false);
  });

  it("rejects a race-winning refreshing profile whose credential boundary drifted from the checked-in YAML", () => {
    const drifted = { ...GC_PROFILE_DOC, binaries: ["/usr/bin/curl"] };
    let exportCalls = 0;
    const runOpenshell = vi.fn((args: string[]) =>
      !args.includes("export")
        ? { status: 1, stderr: "profile already exists" }
        : (exportCalls += 1) === 1
          ? { status: 1, stderr: "custom provider profile not found" }
          : { status: 0, stdout: JSON.stringify(drifted) },
    );
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("reports the real cause, not a fabricated conflict, when the post-race re-export itself fails", () => {
    // A failed post-race export means the profile content was never read —
    // it is not proof of a conflict, and must not tell the operator to
    // delete a profile that may be fine.
    let exportCalls = 0;
    const runOpenshell = vi.fn((args: string[]) =>
      !args.includes("export")
        ? { status: 1, stderr: "profile already exists" }
        : (exportCalls += 1) === 1
          ? { status: 1, stderr: "custom provider profile not found" }
          : { status: 1, stderr: "gateway unreachable" },
    );
    const exit = vi.fn(() => undefined as never);
    const log = vi.fn();
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      log,
      runOpenshell,
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    const logged = log.mock.calls.flat().join("\n");
    expect(logged).toContain("gateway unreachable");
    expect(logged).not.toContain("delete");
  });

  it("accepts OpenShell's pinned export representation of a refreshing profile (#10371)", () => {
    const checkedInYaml = YAML.stringify({
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
            strategy: "google-service-account-jwt",
            scopes: ["https://www.googleapis.com/auth/chat.bot"],
            material: [
              { name: "client_email", required: true },
              { name: "private_key", required: true, secret: true },
              { name: "scope" },
            ],
          },
        },
      ],
      endpoints: [
        {
          host: "chat.googleapis.com",
          port: 443,
          protocol: "rest",
          access: "read-write",
        },
      ],
      binaries: ["/usr/bin/node"],
      inference_capable: false,
    });
    const pinnedExport = {
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
            strategy: "google_service_account_jwt",
            scopes: ["https://www.googleapis.com/auth/chat.bot"],
            material: [
              { name: "client_email", required: true, secret: false },
              { name: "private_key", required: true, secret: true },
              { name: "scope", required: false, secret: false },
            ],
          },
        },
      ],
      endpoints: [
        {
          host: "chat.googleapis.com",
          port: 443,
          protocol: "rest",
          access: "read-write",
        },
      ],
      binaries: ["/usr/bin/node"],
      inference_capable: false,
    };

    const runOpenshell = vi.fn((_args: string[]) => ({
      status: 0,
      stdout: JSON.stringify(pinnedExport),
    }));
    const exit = vi.fn(() => undefined as never);
    const log = vi.fn();
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      profiles: [GC_PROFILE],
      readFileSync: () => checkedInYaml,
      runOpenshell,
      exit,
      log,
    });

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(runOpenshell.mock.calls.some((call) => call[0].includes("import"))).toBe(false);
  });

  it("does not report an unreadable checked-in profile as drift (#10371)", () => {
    // Reading our own YAML can fail for reasons that say nothing about the
    // registered profile. Reporting that as a conflict sends the operator to
    // delete a profile whose contents were never compared.
    const runOpenshell = vi.fn((_args: string[]) => ({
      status: 0,
      stdout: JSON.stringify(GC_PROFILE_DOC),
    }));
    const exit = vi.fn(() => undefined as never);
    const log = vi.fn();
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      runOpenshell,
      exit,
      log,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.flat().join("\n")).not.toContain("delete");
    expect(runOpenshell.mock.calls.some((call) => call[0].includes("import"))).toBe(false);
  });

  it("does not report an export that is not JSON as drift (#10371)", () => {
    const runOpenshell = vi.fn((_args: string[]) => ({
      status: 0,
      stdout: "profile export interrupted",
    }));
    const exit = vi.fn(() => undefined as never);
    const log = vi.fn();
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
      log,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.flat().join("\n")).not.toContain("delete");
  });

  it("does not report valid JSON with no provider boundary as drift (#10371)", () => {
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 0, stdout: "{}" }));
    const exit = vi.fn(() => undefined as never);
    const log = vi.fn();
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
      log,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.flat().join("\n")).not.toContain("delete");
    expect(runOpenshell.mock.calls.some((call) => call[0].includes("import"))).toBe(false);
  });
});

describe("matchesRegisteredStaticMessagingProfile", () => {
  it("accepts only the checked-in static credential boundary", () => {
    const runOpenshell = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify(DISCORD_PROFILE_DOC),
    }));

    expect(
      matchesRegisteredStaticMessagingProfile(DISCORD_PROFILE.profileId, {
        root: "/repo",
        profiles: [DISCORD_PROFILE],
        readFileSync: () => YAML.stringify(DISCORD_PROFILE_DOC),
        runOpenshell,
      }),
    ).toBe("match");
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "export", DISCORD_PROFILE.profileId, "--output", "json"],
      expect.objectContaining({
        suppressOutput: true,
        timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
      }),
    );
  });

  it.each([
    ["endpoint authority", { endpoints: [{ host: "gateway.discord.gg", port: 443 }] }],
    ["binary authority", { binaries: ["/usr/bin/curl"] }],
    ["inference capability", { inference_capable: true }],
  ])("rejects a registered static profile with changed %s", (_description, override) => {
    const runOpenshell = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify({
        ...DISCORD_PROFILE_DOC,
        ...override,
      }),
    }));

    expect(
      matchesRegisteredStaticMessagingProfile(DISCORD_PROFILE.profileId, {
        root: "/repo",
        profiles: [DISCORD_PROFILE],
        readFileSync: () => YAML.stringify(DISCORD_PROFILE_DOC),
        runOpenshell,
      }),
    ).toBe("mismatch");
  });

  it.each([
    ["a failed export", { status: 1, stderr: "gateway unavailable", stdout: "" }],
    [
      "a non-completing export with a missing diagnostic",
      {
        status: null,
        stderr: `custom provider profile '${DISCORD_PROFILE.profileId}' not found`,
        stdout: "",
      },
    ],
    ["malformed export output", { status: 0, stderr: "", stdout: "not-json" }],
  ])("reports %s as indeterminate", (_condition, result) => {
    const runOpenshell = vi.fn(() => result);

    expect(
      matchesRegisteredStaticMessagingProfile(DISCORD_PROFILE.profileId, {
        root: "/repo",
        profiles: [DISCORD_PROFILE],
        readFileSync: () => YAML.stringify(DISCORD_PROFILE_DOC),
        runOpenshell,
      }),
    ).toBe("indeterminate");
  });

  it("reports a recognized missing static profile as absent", () => {
    const runOpenshell = vi.fn(() => ({
      status: 1,
      stderr: `custom provider profile '${DISCORD_PROFILE.profileId}' not found`,
      stdout: "",
    }));

    expect(
      matchesRegisteredStaticMessagingProfile(DISCORD_PROFILE.profileId, {
        root: "/repo",
        profiles: [DISCORD_PROFILE],
        readFileSync: () => YAML.stringify(DISCORD_PROFILE_DOC),
        runOpenshell,
      }),
    ).toBe("absent");
  });

  it.each([
    [
      "invalid checked-in boundary",
      () => YAML.stringify({ ...DISCORD_PROFILE_DOC, endpoints: [{ host: "unsafe.example" }] }),
    ],
    [
      "unreadable checked-in profile",
      () => {
        throw new Error("EACCES");
      },
    ],
  ])("fails closed when discovery finds an %s", (_condition, readFileSync) => {
    const runOpenshell = vi.fn();

    expect(
      matchesRegisteredStaticMessagingProfile(DISCORD_PROFILE.profileId, {
        root: "/repo",
        manifests: [SYNTHETIC_DISCORD_MANIFEST],
        existsSync: () => true,
        readFileSync,
        runOpenshell,
      }),
    ).toBe("indeterminate");
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("does not apply the static-profile check to other provider types", () => {
    const runOpenshell = vi.fn();

    expect(
      matchesRegisteredStaticMessagingProfile("generic", {
        root: "/repo",
        profiles: [DISCORD_PROFILE],
        runOpenshell,
      }),
    ).toBeNull();
    expect(runOpenshell).not.toHaveBeenCalled();
  });
});

describe("listMessagingBridgeProfiles (synthetic static profile)", () => {
  it("discovers an endpointless, binaryless, non-inference static profile", () => {
    expect(discoverSyntheticDiscordProfile(DISCORD_PROFILE_DOC)).toEqual([DISCORD_PROFILE]);
  });

  it.each([
    ["missing endpoints", { endpoints: undefined }],
    ["endpoint authority", { endpoints: [{ host: "gateway.discord.gg", port: 443 }] }],
    ["missing binaries", { binaries: undefined }],
    ["binary authority", { binaries: ["/usr/bin/curl"] }],
    ["missing inference capability", { inference_capable: undefined }],
    ["inference capability", { inference_capable: true }],
  ])("rejects %s", (_description, override) => {
    expect(discoverSyntheticDiscordProfile({ ...DISCORD_PROFILE_DOC, ...override })).toEqual([]);
  });
});

describe("listMessagingBridgeProfiles (real registry + co-located YAML)", () => {
  it("discovers the Google Chat bridge and keeps the credential key in lockstep", () => {
    const profiles = listMessagingBridgeProfiles();
    const gc = profiles.find((p) => p.channelId === "googlechat");
    expect(gc).toBeDefined();
    expect(gc?.agent).toBe("openclaw");
    expect(gc?.profileId).toBe("google-chat-bridge");
    // Invariant: must equal the env var the googlechat-outbound-auth runtime
    // preload reads, or outbound replies never authenticate.
    expect(gc?.credentialKey).toBe("GOOGLE_CHAT_ACCESS_TOKEN");
    expect(gc?.strategy).toBe("google-service-account-jwt");
    expect(gc?.secretMaterialKeys).toContain("private_key");
    expect(gc?.sourceSecretEnv).toBe("GOOGLECHAT_SERVICE_ACCOUNT");
    expect(gc?.profilePath.endsWith("googlechat/provider-profile/openclaw.yaml")).toBe(true);
  });

  // G2: the profile's `binaries` list is what the L7 proxy injects the minted
  // bearer for. It must stay in lockstep with the channel egress policy (Node
  // only) so the credential is never reachable by a binary the channel runtime
  // does not use — no curl, no shell. Re-add an entry only with a named consumer.
  it("authorizes only the Node executable for the injected bearer credential", () => {
    const gc = listMessagingBridgeProfiles().find((p) => p.channelId === "googlechat");
    expect(gc).toBeDefined();
    const binaries = YAML.parse(fs.readFileSync(gc!.profilePath, "utf-8"))?.binaries;
    expect(Array.isArray(binaries)).toBe(true);
    expect(binaries.length).toBeGreaterThan(0);
    expect((binaries as string[]).every((bin) => /\/node$/.test(bin))).toBe(true);
    expect((binaries as string[]).some((bin) => bin.includes("curl"))).toBe(false);
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
