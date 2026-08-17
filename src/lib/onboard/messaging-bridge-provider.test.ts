// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  bridgeProviderNamesForChannel,
  bridgeSecretEnvsForChannel,
  collectMessagingBridgeTokenDefs,
  configureMessagingBridgeRefreshes,
  ensureMessagingBridgeProfiles,
  listMessagingBridgeProfiles,
  MESSAGING_BRIDGE_PENDING_VALUE,
  type MessagingBridgeProfile,
} from "./messaging-bridge-provider";

const SA_JSON = JSON.stringify({
  client_email: "bot@p.iam.gserviceaccount.com",
  private_key: "fake-test-private-key-material",
});
const normalizeCredentialValue = (v: unknown) => String(v ?? "").trim();
const redact = (s: string) => s;
const noLog = vi.fn();

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
    }));
    const result = configureMessagingBridgeRefreshes([BRIDGE_DEF], {
      runOpenshell,
      redact,
      getCredential: () => SA_JSON,
      log: noLog,
      profiles: [GC_PROFILE],
    });
    expect(result).toEqual({ ok: true });
    expect(runOpenshell).toHaveBeenCalledTimes(1);
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

  it("forces private_key off argv even when the profile omits it from secretMaterialKeys", () => {
    // A misconfigured / edited / reused profile that marks other material secret
    // but not private_key must still never leak the raw key into argv.
    const misconfigured: MessagingBridgeProfile = {
      ...GC_PROFILE,
      secretMaterialKeys: ["client_email"],
    };
    const runOpenshell = vi.fn((_args: string[], _opts: { env?: NodeJS.ProcessEnv }) => ({
      status: 0,
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
    const runOpenshell = vi.fn(() => ({ status: 0 }));
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
    expect(runOpenshell).toHaveBeenCalledTimes(1);
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
    const runOpenshell = vi.fn((args: string[], _opts: unknown) =>
      args.includes("export") ? { status: 1 } : { status: 0 },
    );
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], { ...baseDeps(), runOpenshell, exit });
    const importCall = runOpenshell.mock.calls.find((call) => call[0].includes("import"));
    expect(importCall?.[0].slice(0, 4)).toEqual(["provider", "profile", "import", "--file"]);
    expect(importCall?.[0]).toContain(GC_PROFILE.profilePath);
    expect(exit).not.toHaveBeenCalled();
  });

  it("skips the import when the profile is already registered", () => {
    // A fresh onboard registers bridge providers twice; the second pass must not
    // re-import and trigger OpenShell's "already exists / import failed" output.
    const runOpenshell = vi.fn((_args: string[], _opts: unknown) => ({ status: 0 }));
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], { ...baseDeps(), runOpenshell, exit });
    expect(runOpenshell.mock.calls.some((call) => call[0].includes("import"))).toBe(false);
    const exportCall = runOpenshell.mock.calls.find((call) => call[0].includes("export"));
    expect(exportCall?.[0]).toEqual(["provider", "profile", "export", GC_PROFILE.profileId]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("tolerates an already-registered profile without exiting", () => {
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "profile already exists" }));
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], { ...baseDeps(), runOpenshell, exit });
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits when profile import fails for another reason", () => {
    const runOpenshell = vi.fn(() => ({ status: 1, stderr: "connection refused" }));
    const exit = vi.fn(() => undefined as never);
    ensureMessagingBridgeProfiles([BRIDGE_DEF], { ...baseDeps(), runOpenshell, exit });
    expect(exit).toHaveBeenCalled();
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
