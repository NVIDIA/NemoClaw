// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { ChannelManifest } from "../messaging/manifest";
import { redactFull } from "../security/redact";
import {
  bridgeProviderNamesForChannel,
  bridgeSecretEnvsForChannel,
  collectMessagingBridgeTokenDefs,
  configureMessagingBridgeRefreshes,
  ensureMessagingBridgeProfiles,
  listMessagingBridgeProfiles,
  matchesRegisteredMessagingBridgeProfile,
  MESSAGING_BRIDGE_PENDING_VALUE,
  type MessagingBridgeProfile,
  refreshStatusForCredential,
} from "./messaging-bridge-provider";

const SA_JSON = JSON.stringify({
  client_email: "bot@p.iam.gserviceaccount.com",
  private_key: "fake-test-private-key-material",
});
const normalizeCredentialValue = (v: unknown) => String(v ?? "").trim();
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
          { name: "client_email", required: true },
          { name: "private_key", required: true, secret: true },
          { name: "scope" },
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
      redactFull,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result).toEqual({ ok: true });
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("fails closed when the secret is unavailable", () => {
    const runOpenshell = vi.fn();
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redactFull,
      getCredential: () => null,
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result.ok).toBe(false);
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("fails closed when the service account JSON cannot be parsed", () => {
    const runOpenshell = vi.fn();
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redactFull,
      getCredential: () => "not json",
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result.ok).toBe(false);
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("fails closed when client_email or private_key is missing", () => {
    const runOpenshell = vi.fn();
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redactFull,
      getCredential: () => JSON.stringify({ client_email: "x@y" }),
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result.ok).toBe(false);
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("fails closed when client_email or private_key is blank", () => {
    const runOpenshell = vi.fn();
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redactFull,
      getCredential: () => JSON.stringify({ client_email: " ", private_key: "\n" }),
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result.ok).toBe(false);
    expect(runOpenshell).not.toHaveBeenCalled();
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
      redactFull,
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
      redactFull,
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
      redactFull,
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
      redactFull,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("fully redacts reflected source and generated refresh material", () => {
    const clientEmail = "reflected-bot@example.invalid";
    const privateKey = "unique-private-key-material-for-redaction";
    const sourceSecret = JSON.stringify({ client_email: clientEmail, private_key: privateKey });
    const scope = GC_PROFILE.scopes.join(" ");
    const log = vi.fn();
    const runOpenshell = vi.fn(() => ({
      status: 1,
      stderr: `source=${sourceSecret} private_key=${privateKey}`,
      stdout: `client_email=${clientEmail} scope=${scope}`,
    }));

    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redactFull,
      getCredential: () => sourceSecret,
      log,
      profiles: [GC_PROFILE],
    });

    const diagnostic = `${log.mock.calls.flat().join("\n")} ${result.reason ?? ""}`;
    expect(result.ok).toBe(false);
    expect(diagnostic).not.toContain(sourceSecret);
    expect(diagnostic).not.toContain(clientEmail);
    expect(diagnostic).not.toContain(privateKey);
    expect(diagnostic).not.toContain(scope);
    expect(diagnostic).not.toContain(privateKey.slice(0, 4));
    expect(diagnostic).toContain("<REDACTED>");
  });

  it("resolves the secret from the injected env too (parity)", () => {
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: MINTED_STATUS_TABLE }));
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redactFull,
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
      redactFull,
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

  it("waits through a configured status before accepting the refreshed token", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0, stdout: PENDING_STATUS_TABLE })
      .mockReturnValueOnce({ status: 0, stdout: MINTED_STATUS_TABLE });
    const sleep = vi.fn();

    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redactFull,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
      sleep,
    });

    expect(result).toEqual({ ok: true });
    expect(runOpenshell.mock.calls.slice(1).map(([args]) => args.slice(0, 3))).toEqual([
      ["provider", "refresh", "status"],
      ["provider", "refresh", "status"],
    ]);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(3_000);
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
    const sleep = vi.fn();
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redactFull,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
      sleep,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("configured");
    expect(runOpenshell.mock.calls.filter((call) => call[0][2] === "status")).toHaveLength(50);
    expect(sleep).toHaveBeenCalledTimes(49);
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
      redactFull,
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
      redactFull,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
      sleep: () => undefined,
      now: () => clock,
    });
    expect(result.ok).toBe(false);
    // The configure command advances the clock once. Exactly five one-minute
    // status probes then consume the five-minute polling deadline.
    expect(runOpenshell.mock.calls.filter((call) => call[0][2] === "status")).toHaveLength(5);
  });

  it("bounds each status probe with a command timeout", () => {
    const runOpenshell = vi.fn((_args: string[], _opts: unknown) => ({
      status: 0,
      stdout: MINTED_STATUS_TABLE,
    }));
    configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redactFull,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
      sleep: () => undefined,
    });
    const statusCall = runOpenshell.mock.calls.find((call) => call[0][2] === "status");
    expect(statusCall?.[1]).toMatchObject({ timeout: 15_000 });
  });

  it("bounds refresh configuration and fails closed when the command times out", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: null, stderr: "operation timed out" });

    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redactFull,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
    });

    expect(result).toEqual({ ok: false, reason: "operation timed out" });
    expect(runOpenshell).toHaveBeenCalledOnce();
    expect(runOpenshell.mock.calls[0]?.[1]).toMatchObject({ timeout: 30_000 });
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
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(GC_PROFILE_DOC) });
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
    expect(runOpenshell.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "profile", "export", GC_PROFILE.profileId, "--output", "json"],
      ["provider", "profile", "import", "--file", GC_PROFILE.profilePath],
      ["provider", "profile", "export", GC_PROFILE.profileId, "--output", "json"],
    ]);
    expect(runOpenshell.mock.calls.map(([, options]) => options.timeout)).toEqual([
      30_000, 30_000, 30_000,
    ]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("validates without importing when the profile is already registered", () => {
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
    expect(exportCall?.[1]).toMatchObject({ suppressOutput: true, timeout: 30_000 });
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
    expect(runOpenshell.mock.calls[0]?.[1]).toMatchObject({ timeout: 30_000 });
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
    expect(runOpenshell).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched static profile that wins an import race", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
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

  it.each([
    {
      condition: "is already registered",
      results: [
        {
          status: 0,
          stdout: JSON.stringify({
            ...GC_PROFILE_DOC,
            endpoints: [...GC_PROFILE_DOC.endpoints, { host: "untrusted.invalid", port: 443 }],
          }),
        },
      ],
    },
    {
      condition: "wins an import race",
      results: [
        { status: 1, stderr: "provider profile not found" },
        { status: 1, stderr: "profile already exists" },
        {
          status: 0,
          stdout: JSON.stringify({
            ...GC_PROFILE_DOC,
            binaries: [...GC_PROFILE_DOC.binaries, "/usr/bin/curl"],
          }),
        },
      ],
    },
  ])("rejects a mismatched refreshing profile that $condition", ({ results }) => {
    const queuedResults = [...results];
    const runOpenshell = vi.fn(() => queuedResults.shift() ?? { status: 1 });
    const exit = vi.fn(() => undefined as never);

    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(runOpenshell).toHaveBeenCalledTimes(results.length);
  });

  it("accepts a matching refreshing profile that wins an import race", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 1, stderr: "profile already exists" })
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(GC_PROFILE_DOC) });
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
    });
    expect(exit).not.toHaveBeenCalled();
    expect(runOpenshell).toHaveBeenCalledTimes(3);
  });

  it.each(["connection refused", "authentication failed"])(
    "does not import when the profile probe fails with %s",
    (diagnostic) => {
      const runOpenshell = vi.fn((_args: string[], _options: unknown) => ({
        status: 1,
        stderr: diagnostic,
      }));
      const exit = vi.fn(() => undefined as never);
      ensureMessagingBridgeProfiles([BRIDGE_DEF], {
        ...baseDeps(),
        readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
        runOpenshell,
        exit,
      });
      expect(exit).toHaveBeenCalledWith(1);
      expect(runOpenshell).toHaveBeenCalledTimes(1);
      expect(runOpenshell.mock.calls.some((call) => call[0].includes("import"))).toBe(false);
      expect(runOpenshell.mock.calls[0]?.[1]).toMatchObject({ timeout: 30_000 });
    },
  );

  it("exits when a confirmed-missing profile cannot be imported", () => {
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stderr: "provider profile not found" })
      .mockReturnValueOnce({ status: 1, stderr: "connection refused" });
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], {
      ...baseDeps(),
      readFileSync: () => YAML.stringify(GC_PROFILE_DOC),
      runOpenshell,
      exit,
    });
    expect(exit).toHaveBeenCalledWith(1);
    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(runOpenshell.mock.calls.map(([, options]) => options.timeout)).toEqual([30_000, 30_000]);
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
