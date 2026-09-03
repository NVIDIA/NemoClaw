// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
    const runOpenshell = vi.fn(
      (_args: string[], _opts: { env?: NodeJS.ProcessEnv; timeout?: number }) => ({
        status: 0,
        stdout: MINTED_STATUS_TABLE,
      }),
    );
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
    expect(options.timeout).toBe(OPENSHELL_OPERATION_TIMEOUT_MS);
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
    // Five probes at a minute each reach the five-minute deadline before
    // the fifty-attempt cap.
    expect(runOpenshell.mock.calls.filter((call) => call[0][2] === "status")).toHaveLength(5);
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
    readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
  });

  it("does nothing without an active bridge provider", () => {
    const runOpenshell = vi.fn();
    ensureMessagingBridgeProfiles([], { ...baseDeps(), runOpenshell });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("reconciles an active bridge through its co-located profile path", () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: JSON.stringify(GC_PROFILE_DOC) }));
    ensureMessagingBridgeProfiles([BRIDGE_DEF], { ...baseDeps(), runOpenshell });
    expect(runOpenshell).toHaveBeenCalledWith(
      ["provider", "profile", "export", GC_PROFILE.profileId, "--output", "json"],
      expect.objectContaining({ suppressOutput: true }),
    );
  });

  it("stops with redacted guidance when reconciliation cannot inspect the gateway", () => {
    const runOpenshell = vi.fn(() => ({
      status: null,
      stderr: "secret-value",
      error: new Error("ETIMEDOUT"),
    }));
    const log = vi.fn();
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      redact: (text) => text.replaceAll("secret-value", "[REDACTED]"),
      runOpenshell,
      log,
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("secret-value");
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
