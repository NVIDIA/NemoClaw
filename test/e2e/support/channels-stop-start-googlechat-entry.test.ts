// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  addAndRebuildGooglechatForChannelsStopStartLiveE2e,
  addGooglechatForChannelsStopStartLiveE2e,
  GOOGLECHAT_E2E_ACCESS_TOKEN,
  installGooglechatCredentialFixture,
  rebuildGooglechatForChannelsStopStartLiveE2e,
} from "../live/channels-stop-start-googlechat-entry.ts";

type FixtureRunner = typeof import("../../../src/lib/adapters/openshell/runtime.ts").runOpenshell;
type FixtureProviderDependencies = {
  upsertMessagingProviders(
    tokenDefs: Parameters<
      (typeof import("../../../src/lib/actions/sandbox/policy-channel-dependencies.ts"))["policyChannelDependencies"]["upsertMessagingProviders"]
    >[0],
    run: FixtureRunner,
    options?: {
      readonly replaceExisting?: boolean;
      readonly revalidatePolicyRequirements?: (operation: string) => void;
    },
  ): string[];
};

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("channels stop/start Google Chat live composition", () => {
  it("loads through the standalone live-E2E module boundary (#7317)", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        [
          'import("./test/e2e/live/channels-stop-start-googlechat-entry.ts")',
          "  .then((module) => console.log(typeof module.addGooglechatForChannelsStopStartLiveE2e))",
          "  .catch((error) => { console.error(error); process.exitCode = 1; });",
        ].join("\n"),
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        timeout: 10_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("function");
  });

  it("grants a process-local audience capability to the exact live sandbox", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const restore = vi.fn();
    const installCredentialFixture = vi.fn(() => restore);

    await addGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-oc-ch-cycle",
        agent: "openclaw",
        audience: "  https://e2e-fake.trycloudflare.com/googlechat  ",
      },
      { addSandboxChannel, installCredentialFixture },
    );

    expect(installCredentialFixture).toHaveBeenCalledWith("e2e-oc-ch-cycle", "openclaw");
    expect(addSandboxChannel).toHaveBeenCalledWith(
      "e2e-oc-ch-cycle",
      { channel: "googlechat" },
      {
        googlechatNonInteractiveAudienceCapability: {
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
      },
    );
    expect(restore).toHaveBeenCalledOnce();
  });

  it("adds Hermes Google Chat without the OpenClaw audience capability", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const restore = vi.fn();
    const installCredentialFixture = vi.fn(() => restore);

    await addGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-hm-ch-cycle",
        agent: "hermes",
        audience: "https://e2e-fake.trycloudflare.com/googlechat",
      },
      { addSandboxChannel, installCredentialFixture },
    );

    expect(installCredentialFixture).toHaveBeenCalledWith("e2e-hm-ch-cycle", "hermes");
    expect(addSandboxChannel).toHaveBeenCalledWith(
      "e2e-hm-ch-cycle",
      { channel: "googlechat" },
      {},
    );
    expect(restore).toHaveBeenCalledOnce();
  });

  it("refuses to grant the capability outside the destructive live-test sandbox namespace", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const installCredentialFixture = vi.fn(() => vi.fn());

    await expect(
      addGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "production-openclaw",
          agent: "openclaw",
          audience: "https://example.com/googlechat",
        },
        { addSandboxChannel, installCredentialFixture },
      ),
    ).rejects.toThrow(/only accepts openclaw sandbox names with prefix e2e-oc-ch-/);
    expect(addSandboxChannel).not.toHaveBeenCalled();
    expect(installCredentialFixture).not.toHaveBeenCalled();
  });

  it("refuses an empty live-test audience", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const installCredentialFixture = vi.fn(() => vi.fn());

    await expect(
      addGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "e2e-oc-ch-cycle",
          agent: "openclaw",
          audience: " ",
        },
        { addSandboxChannel, installCredentialFixture },
      ),
    ).rejects.toThrow(/GOOGLECHAT_AUDIENCE is required/);
    expect(addSandboxChannel).not.toHaveBeenCalled();
    expect(installCredentialFixture).not.toHaveBeenCalled();
  });

  it("restores the provider boundary when channel add fails", async () => {
    const addSandboxChannel = vi.fn(async () => {
      throw new Error("planned add failed");
    });
    const restore = vi.fn();

    await expect(
      addGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "e2e-hm-ch-cycle",
          agent: "hermes",
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
        { addSandboxChannel, installCredentialFixture: () => restore },
      ),
    ).rejects.toThrow("planned add failed");
    expect(restore).toHaveBeenCalledOnce();
  });

  it("keeps the provider fixture installed across add and rebuild", async () => {
    const events: string[] = [];
    const restore = vi.fn(() => events.push("restore"));

    await addAndRebuildGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-hm-ch-cycle",
        agent: "hermes",
        audience: "https://e2e-fake.trycloudflare.com/googlechat",
      },
      {
        installCredentialFixture: () => {
          events.push("install");
          return restore;
        },
        addSandboxChannel: async () => {
          events.push("add");
        },
        rebuildSandbox: async (_sandboxName, args) => {
          expect(args).toEqual(["--yes"]);
          events.push("rebuild");
        },
      },
    );

    expect(events).toEqual(["install", "add", "rebuild", "restore"]);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("restores the provider fixture when rebuild fails", async () => {
    const restore = vi.fn();

    await expect(
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "e2e-oc-ch-cycle",
          agent: "openclaw",
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
        {
          installCredentialFixture: () => restore,
          addSandboxChannel: async () => {},
          rebuildSandbox: async () => {
            throw new Error("planned rebuild failed");
          },
        },
      ),
    ).rejects.toThrow("planned rebuild failed");
    expect(restore).toHaveBeenCalledOnce();
  });

  it("keeps the provider fixture installed across a later lifecycle rebuild", async () => {
    const events: string[] = [];
    const restore = vi.fn(() => events.push("restore"));

    await rebuildGooglechatForChannelsStopStartLiveE2e(
      { sandboxName: "e2e-oc-ch-cycle", agent: "openclaw" },
      {
        installCredentialFixture: () => {
          events.push("install");
          return restore;
        },
        addSandboxChannel: async () => {},
        rebuildSandbox: async (_sandboxName, args) => {
          expect(args).toEqual(["--yes"]);
          events.push("rebuild");
        },
      },
    );

    expect(events).toEqual(["install", "rebuild", "restore"]);
    expect(restore).toHaveBeenCalledOnce();
  });

  it.each([
    ["openclaw", "e2e-oc-ch-cycle", "google-chat-bridge"],
    ["hermes", "e2e-hm-ch-cycle", "google-chat-hermes-bridge"],
  ] as const)(
    "creates the real %s provider profile without putting the fixture value in argv",
    (agent, sandboxName, providerType) => {
      const delegatedName = `${sandboxName}-slack-bridge`;
      const delegatedTokenDef = {
        name: delegatedName,
        envKey: "SLACK_BOT_TOKEN",
        token: "e2e-fake-slack-token",
        providerType: "nemoclaw-mcp-v1",
      };
      const originalUpsert = vi.fn(() => [delegatedName]);
      const providerDependencies: FixtureProviderDependencies = {
        upsertMessagingProviders: originalUpsert,
      };
      const ensureProfiles = vi.fn();
      const runMock = vi.fn((args: string[], _options?: { env?: NodeJS.ProcessEnv }) => ({
        status: args[1] === "get" ? 1 : 0,
      }));
      const run = runMock as unknown as FixtureRunner;
      const revalidatePolicyRequirements = vi.fn();

      const restore = installGooglechatCredentialFixture(sandboxName, agent, {
        ensureProfiles,
        providerDependencies,
        root: "/repo",
        run,
      });
      const providerNames = providerDependencies.upsertMessagingProviders(
        [
          delegatedTokenDef,
          {
            name: `${sandboxName}-googlechat-bridge`,
            envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
            token: null,
            providerType,
          },
        ],
        run,
        { revalidatePolicyRequirements },
      );

      expect(providerNames).toEqual([delegatedName, `${sandboxName}-googlechat-bridge`]);
      expect(originalUpsert).toHaveBeenCalledWith([delegatedTokenDef], run, {
        revalidatePolicyRequirements,
      });
      expect(ensureProfiles).toHaveBeenCalledOnce();
      const profileDependencies = ensureProfiles.mock.calls[0]?.[1] as {
        redact: (value: string) => string;
        root: string;
        runOpenshell: FixtureRunner;
      };
      expect(profileDependencies.root).toBe("/repo");
      expect(profileDependencies.runOpenshell).not.toBe(run);
      expect(profileDependencies.redact(GOOGLECHAT_E2E_ACCESS_TOKEN)).toBe("[redacted]");
      expect(revalidatePolicyRequirements).toHaveBeenCalledTimes(2);

      const createCall = runMock.mock.calls.find(([args]) => args[1] === "create");
      expect(createCall?.[0]).toEqual([
        "provider",
        "create",
        "--name",
        `${sandboxName}-googlechat-bridge`,
        "--type",
        providerType,
        "--credential",
        "GOOGLE_CHAT_ACCESS_TOKEN",
      ]);
      expect(createCall?.[0]).not.toContain(GOOGLECHAT_E2E_ACCESS_TOKEN);
      expect(createCall?.[1]?.env).toMatchObject({
        GOOGLE_CHAT_ACCESS_TOKEN: GOOGLECHAT_E2E_ACCESS_TOKEN,
      });

      restore();
      expect(providerDependencies.upsertMessagingProviders).toBe(originalUpsert);
    },
  );

  it.each([
    [
      {},
      [
        ["provider", "get", "e2e-oc-ch-cycle-googlechat-bridge"],
        [
          "provider",
          "update",
          "e2e-oc-ch-cycle-googlechat-bridge",
          "--credential",
          "GOOGLE_CHAT_ACCESS_TOKEN",
        ],
      ],
    ],
    [
      { replaceExisting: true },
      [
        ["provider", "get", "e2e-oc-ch-cycle-googlechat-bridge"],
        ["provider", "delete", "e2e-oc-ch-cycle-googlechat-bridge"],
        [
          "provider",
          "create",
          "--name",
          "e2e-oc-ch-cycle-googlechat-bridge",
          "--type",
          "google-chat-bridge",
          "--credential",
          "GOOGLE_CHAT_ACCESS_TOKEN",
        ],
      ],
    ],
  ] as const)(
    "reconciles an existing fixture provider with options %o",
    (options, expectedCalls) => {
      const providerDependencies: FixtureProviderDependencies = {
        upsertMessagingProviders: vi.fn(() => []),
      };
      const calls: string[][] = [];
      const run = ((args: string[]) => {
        calls.push(args);
        return { status: 0 };
      }) as unknown as FixtureRunner;
      const restore = installGooglechatCredentialFixture("e2e-oc-ch-cycle", "openclaw", {
        ensureProfiles: vi.fn(),
        providerDependencies,
        root: "/repo",
        run,
      });

      providerDependencies.upsertMessagingProviders(
        [
          {
            name: "e2e-oc-ch-cycle-googlechat-bridge",
            envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
            token: null,
            providerType: "google-chat-bridge",
          },
        ],
        run,
        options,
      );

      expect(calls).toEqual(expectedCalls);
      restore();
    },
  );
});
