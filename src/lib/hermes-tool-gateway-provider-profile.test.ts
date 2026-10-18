// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { REPOSITORY_ROOT } from "./core/repository-root";
import {
  importHermesToolGatewayProfile,
  matchHermesToolGatewayProviderType,
} from "./hermes-tool-gateway-provider-profile";

const PROFILE_ID = "nemoclaw-hermes-tool-gateway-v1";
const PROFILE_PATH = path.join(REPOSITORY_ROOT, "agents", "hermes", "host", `${PROFILE_ID}.yaml`);
const CREDENTIAL_ENV = "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN";

type Broker = {
  HERMES_TOOL_GATEWAY_STATE_DIR: string;
  getHermesToolGatewayBrokerToken: (sandbox: string) => string | null;
  isHermesToolGatewayRefreshProviderRegistered: (
    sandbox: string,
    runOpenshell: ReturnType<typeof vi.fn>,
  ) => Promise<boolean>;
  registerHermesToolGatewayRefreshProvider: (
    sandbox: string,
    refreshToken: string,
    runOpenshell: ReturnType<typeof vi.fn>,
  ) => Promise<{ providerName: string; brokerToken: string }>;
};

async function withBroker(run: (broker: Broker) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-profile-"));
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    vi.resetModules();
    await run((await import("./hermes-tool-gateway-broker")) as unknown as Broker);
  } finally {
    vi.resetModules();
    oldHome === undefined ? delete process.env.HOME : (process.env.HOME = oldHome);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function gateway(
  options: {
    profile?: "absent" | "present" | "conflict";
    providerType?: string;
    providerName?: string;
    credentialKeys?: string;
    configKeys?: string;
    disappearOnSecondGet?: boolean;
    importFails?: boolean;
    createFails?: boolean;
    postExport?: "mismatch" | "failure";
    beforeCommand?: (args: string[]) => void;
  } = {},
) {
  const profile = YAML.parse(fs.readFileSync(PROFILE_PATH, "utf8")) as Record<string, unknown>;
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  let profilePresent = options.profile !== "absent";
  let providerType = options.providerType ?? null;
  let created = false;
  let providerGets = 0;
  const runOpenshell = vi.fn((args: string[], opts: { env?: NodeJS.ProcessEnv } = {}) => {
    calls.push({ args, env: opts.env });
    options.beforeCommand?.(args);
    switch (`${args[0]} ${args[1]} ${args[2]}`) {
      case "provider profile export":
        return !profilePresent
          ? { status: 1, stderr: "provider profile not found" }
          : created && options.postExport === "failure"
            ? { status: null, stderr: "profile export timed out" }
            : {
                status: 0,
                stdout: JSON.stringify(
                  options.profile === "conflict" || (created && options.postExport === "mismatch")
                    ? { ...profile, binaries: ["/unrelated/binary"] }
                    : profile,
                ),
              };
      case "provider profile import":
        profilePresent = !options.importFails;
        return options.importFails
          ? { status: 1, stderr: "import failed: secret-marker" }
          : { status: 0 };
      case `provider get ${args[2]}`:
        providerGets += 1;
        return providerType && !(options.disappearOnSecondGet && providerGets === 2)
          ? {
              status: 0,
              stdout: `Name: ${options.providerName ?? args[2]}\nType: ${providerType}\nCredential keys: ${options.credentialKeys ?? CREDENTIAL_ENV}\nConfig keys: ${options.configKeys ?? "<none>"}\n`,
            }
          : { status: 1, stderr: `provider '${args[2]}' not found` };
      case `provider create ${args[2]}`:
        providerType = String(args[args.indexOf("--type") + 1]);
        created = true;
        return options.createFails
          ? { status: null, error: new Error("OpenShell create timed out") }
          : { status: 0 };
      case `provider update ${args[2]}`:
        return { status: 0 };
      default:
        throw new Error(`Unexpected OpenShell command: ${args.join(" ")}`);
    }
  });
  return { calls, profile, runOpenshell };
}

describe("Hermes tool gateway provider profile", () => {
  it("verifies the profile and exact provider binding on the reuse path", async () => {
    await withBroker(async (broker) => {
      const g = gateway({ profile: "present", providerType: PROFILE_ID });
      await expect(
        broker.isHermesToolGatewayRefreshProviderRegistered("alpha", g.runOpenshell),
      ).resolves.toBe(true);
      expect(g.calls.map(({ args }) => args.slice(0, 2).join(" "))).toEqual([
        "provider profile",
        "provider get",
      ]);
      expect(fs.existsSync(path.join(broker.HERMES_TOOL_GATEWAY_STATE_DIR, "alpha.json"))).toBe(
        false,
      );
    });
  });

  it("imports an endpointless owned profile before state and provider creation", async () => {
    await withBroker(async (broker) => {
      const stateFile = path.join(broker.HERMES_TOOL_GATEWAY_STATE_DIR, "alpha.json");
      const g = gateway({
        profile: "absent",
        beforeCommand: (args) => {
          args[2] === "import" && expect(fs.existsSync(stateFile)).toBe(false);
        },
      });
      const result = await broker.registerHermesToolGatewayRefreshProvider(
        "alpha",
        "refresh-secret-marker",
        g.runOpenshell,
      );
      expect(result.providerName).toBe("alpha-hermes-tool-gateway");
      expect(g.profile.credentials).toMatchObject([{ env_vars: [CREDENTIAL_ENV] }]);
      expect(g.profile.endpoints).toEqual([]);
      expect(g.profile.binaries).toEqual([]);
      expect(g.calls.map(({ args }) => args.slice(0, 3).join(" "))).toEqual([
        "provider profile export",
        "provider profile import",
        "provider profile export",
        "provider get alpha-hermes-tool-gateway",
        "provider get alpha-hermes-tool-gateway",
        "provider create --name",
        "provider profile export",
      ]);
      const create = g.calls.find(({ args }) => args[1] === "create");
      expect(create?.args).toContain(PROFILE_ID);
      expect(create?.env?.[CREDENTIAL_ENV]).toBe(result.brokerToken);
      expect(JSON.stringify(g.calls.map(({ args }) => args))).not.toContain(result.brokerToken);
      expect(JSON.stringify(g.calls)).not.toContain("refresh-secret-marker");
      expect(broker.getHermesToolGatewayBrokerToken("alpha")).toBe(result.brokerToken);
    });
  });

  it("verifies an existing profile and updates only an exact provider binding", async () => {
    await withBroker(async (broker) => {
      const g = gateway({ profile: "present", providerType: PROFILE_ID });
      const first = await broker.registerHermesToolGatewayRefreshProvider(
        "alpha",
        "refresh-token",
        g.runOpenshell,
      );
      const second = await broker.registerHermesToolGatewayRefreshProvider(
        "alpha",
        "refresh-token",
        g.runOpenshell,
      );
      expect(second.brokerToken).toBe(first.brokerToken);
      expect(g.calls.map(({ args }) => args.slice(0, 2).join(" "))).toEqual([
        "provider profile",
        "provider get",
        "provider get",
        "provider update",
        "provider profile",
        "provider get",
        "provider get",
        "provider update",
      ]);
      expect(g.calls.every(({ args }) => args[1] !== "create" && args[2] !== "import")).toBe(true);
    });
  });

  it("reopens and refreshes an exact legacy generic provider without replacing it", async () => {
    await withBroker(async (broker) => {
      const g = gateway({ profile: "present", providerType: "generic" });
      await expect(
        broker.isHermesToolGatewayRefreshProviderRegistered("alpha", g.runOpenshell),
      ).resolves.toBe(true);
      const result = await broker.registerHermesToolGatewayRefreshProvider(
        "alpha",
        "refresh-secret-marker",
        g.runOpenshell,
      );
      const update = g.calls.find(({ args }) => args[1] === "update");
      expect(update?.env?.[CREDENTIAL_ENV]).toBe(result.brokerToken);
      expect(g.calls.filter(({ args }) => args[1] === "create" || args[1] === "delete")).toEqual(
        [],
      );
      expect(JSON.stringify(g.calls)).not.toContain("refresh-secret-marker");
      expect(broker.getHermesToolGatewayBrokerToken("alpha")).toBe(result.brokerToken);
    });
  });

  it.each([
    ["conflicting profile", { profile: "conflict" as const }, /conflicts with NemoClaw/u],
    ["failed import", { profile: "absent" as const, importFails: true }, /Could not import/u],
    ["unrelated provider type", { providerType: "unrelated" }, /does not match/u],
    [
      "legacy provider name",
      { providerType: "generic", providerName: "other" },
      /Could not inspect/u,
    ],
    [
      "legacy credential keys",
      { providerType: "generic", credentialKeys: `${CREDENTIAL_ENV}, OTHER_KEY` },
      /does not match/u,
    ],
    ["legacy config keys", { providerType: "generic", configKeys: "OTHER_KEY" }, /does not match/u],
  ])("stops on %s before broker state or provider mutation", async (_case, options, error) => {
    await withBroker(async (broker) => {
      const g = gateway(options);
      await expect(
        broker.registerHermesToolGatewayRefreshProvider("alpha", "refresh-token", g.runOpenshell),
      ).rejects.toThrow(error);
      expect(fs.existsSync(path.join(broker.HERMES_TOOL_GATEWAY_STATE_DIR, "alpha.json"))).toBe(
        false,
      );
      expect(g.calls.every(({ args }) => args[1] !== "create" && args[1] !== "update")).toBe(true);
    });
  });

  it("does not create a generic provider if it disappears before credential update", async () => {
    await withBroker(async (broker) => {
      const g = gateway({ providerType: "generic", disappearOnSecondGet: true });
      await expect(
        broker.registerHermesToolGatewayRefreshProvider("alpha", "refresh-secret", g.runOpenshell),
      ).rejects.toThrow(/does not match/u);
      expect(g.calls.filter(({ args }) => args[1] === "create" || args[1] === "update")).toEqual(
        [],
      );
    });
  });

  it.each([
    ["mismatch", /changed after verification/u],
    ["failure", /did not complete/u],
  ] as const)(
    "warns after %s on post-create export without changing success",
    async (postExport, warning) => {
      await withBroker(async (broker) => {
        const g = gateway({ profile: "present", postExport });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          await expect(
            broker.registerHermesToolGatewayRefreshProvider(
              "alpha",
              "refresh-secret",
              g.runOpenshell,
            ),
          ).resolves.toMatchObject({ providerName: "alpha-hermes-tool-gateway" });
          expect(warn).toHaveBeenCalledWith(expect.stringMatching(warning));
          expect(JSON.stringify(warn.mock.calls)).not.toContain("refresh-secret");
        } finally {
          warn.mockRestore();
        }
      });
    },
  );

  it("retains broker recovery state after an ambiguous provider create", async () => {
    await withBroker(async (broker) => {
      const g = gateway({ profile: "present", createFails: true });
      await expect(
        broker.registerHermesToolGatewayRefreshProvider("alpha", "refresh-secret", g.runOpenshell),
      ).rejects.toThrow();
      expect(fs.existsSync(path.join(broker.HERMES_TOOL_GATEWAY_STATE_DIR, "alpha.json"))).toBe(
        true,
      );
      expect(g.calls.filter(({ args }) => args[1] === "create")).toHaveLength(1);
      expect(JSON.stringify(g.calls.map(({ args }) => args))).not.toContain("refresh-secret");
    });
  });
});

describe("Hermes tool gateway provider contract", () => {
  const exact = {
    name: "alpha-hermes-tool-gateway",
    type: PROFILE_ID,
    credentialKeys: [CREDENTIAL_ENV],
    configKeys: [],
  };

  it.each([
    ["the owned profile", exact, PROFILE_ID],
    ["an exact legacy generic provider", { ...exact, type: "generic" }, "generic"],
    ["an unrelated type", { ...exact, type: "unrelated" }, null],
    ["another provider name", { ...exact, name: "other" }, null],
    ["an extra credential key", { ...exact, credentialKeys: [CREDENTIAL_ENV, "OTHER_KEY"] }, null],
    ["another credential key", { ...exact, credentialKeys: ["OTHER_KEY"] }, null],
    ["a config key", { ...exact, configKeys: ["OTHER_KEY"] }, null],
  ])("matches %s", (_case, observed, expected) => {
    expect(matchHermesToolGatewayProviderType(observed, "alpha-hermes-tool-gateway")).toBe(
      expected,
    );
  });

  it("imports the checked-in profile on the requested gateway", () => {
    const importProviderProfile = vi.fn(() => ({ ok: true as const }));
    const target = { kind: "named", gatewayName: "nemoclaw" } as const;

    expect(
      importHermesToolGatewayProfile({ importProviderProfile }, target, REPOSITORY_ROOT),
    ).toEqual({ ok: true });
    expect(importProviderProfile).toHaveBeenCalledWith({ target, profilePath: PROFILE_PATH });
  });
});
