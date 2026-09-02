// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  addAndRebuildGooglechatForChannelsStopStartLiveE2e,
  createGooglechatCredentialFixture,
  GOOGLECHAT_E2E_ACCESS_TOKEN,
  rebuildGooglechatForChannelsStopStartLiveE2e,
} from "../live/channels-stop-start-helpers.ts";

type FixtureRunner = typeof import("../../../src/lib/adapters/openshell/runtime.ts").runOpenshell;
type FixtureChannelDependencies = Pick<
  (typeof import("../../../src/lib/actions/sandbox/policy-channel-dependencies.ts"))["policyChannelDependencies"],
  "runGatewayOpenshell" | "upsertMessagingProviders"
>;

describe("channels stop/start Google Chat live composition", () => {
  it("intercepts the live policy-channel boundary before gateway refresh minting", () => {
    const sandboxName = "e2e-oc-ch-cycle";
    const expectedName = `${sandboxName}-googlechat-bridge`;
    const calls: string[][] = [];
    const originalUpsert = vi.fn(() => []);
    const channelDependencies: FixtureChannelDependencies = {
      upsertMessagingProviders: originalUpsert,
      runGatewayOpenshell: vi.fn((_gatewayName, args) => {
        calls.push(args);
        return { status: args[1] === "get" ? 1 : 0 } as never;
      }),
    };
    const fixture = createGooglechatCredentialFixture(sandboxName, "openclaw", {
      channelDependencies,
      ensureProfiles: vi.fn(),
      root: "/repo",
    });

    expect(
      fixture.upsertMessagingProviders(
        [
          {
            name: expectedName,
            envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
            token: null,
            providerType: "google-chat-bridge",
          },
        ],
        "nemoclaw",
        { bestEffort: true, requireExactBindings: true },
      ),
    ).toEqual([expectedName]);
    expect(originalUpsert).not.toHaveBeenCalled();
    expect(channelDependencies.upsertMessagingProviders).toBe(originalUpsert);
    expect(calls).toContainEqual([
      "provider",
      "create",
      "--name",
      expectedName,
      "--type",
      "google-chat-bridge",
      "--credential",
      "GOOGLE_CHAT_ACCESS_TOKEN",
    ]);
  });

  it("grants a process-local audience capability to the exact live sandbox", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const rebuildSandbox = vi.fn(async () => {});
    const createCredentialFixture = vi.fn(() => ({}));

    await addAndRebuildGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-oc-ch-cycle",
        agent: "openclaw",
        audience: "  https://e2e-fake.trycloudflare.com/googlechat  ",
      },
      { addSandboxChannel, createCredentialFixture, rebuildSandbox },
    );

    expect(createCredentialFixture).toHaveBeenCalledWith("e2e-oc-ch-cycle", "openclaw");
    expect(addSandboxChannel).toHaveBeenCalledWith(
      "e2e-oc-ch-cycle",
      { channel: "googlechat" },
      {
        googlechatNonInteractiveAudienceCapability: {
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
      },
    );
    expect(rebuildSandbox).toHaveBeenCalledWith("e2e-oc-ch-cycle", ["--yes"]);
  });

  it("adds Hermes Google Chat without the OpenClaw audience capability", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const rebuildSandbox = vi.fn(async () => {});
    const createCredentialFixture = vi.fn(() => ({}));

    await addAndRebuildGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-hm-ch-cycle",
        agent: "hermes",
        audience: "https://e2e-fake.trycloudflare.com/googlechat",
      },
      { addSandboxChannel, createCredentialFixture, rebuildSandbox },
    );

    expect(createCredentialFixture).toHaveBeenCalledWith("e2e-hm-ch-cycle", "hermes");
    expect(addSandboxChannel).toHaveBeenCalledWith(
      "e2e-hm-ch-cycle",
      { channel: "googlechat" },
      {},
    );
    expect(rebuildSandbox).toHaveBeenCalledWith("e2e-hm-ch-cycle", ["--yes"]);
  });

  it("refuses to grant the capability outside the destructive live-test sandbox namespace", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const createCredentialFixture = vi.fn(() => ({}));

    await expect(
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "production-openclaw",
          agent: "openclaw",
          audience: "https://example.com/googlechat",
        },
        { addSandboxChannel, createCredentialFixture },
      ),
    ).rejects.toThrow(/only accepts openclaw sandbox names with prefix e2e-oc-ch-/);
    expect(addSandboxChannel).not.toHaveBeenCalled();
    expect(createCredentialFixture).not.toHaveBeenCalled();
  });

  it("refuses an empty live-test audience", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const createCredentialFixture = vi.fn(() => ({}));

    await expect(
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "e2e-oc-ch-cycle",
          agent: "openclaw",
          audience: " ",
        },
        { addSandboxChannel, createCredentialFixture },
      ),
    ).rejects.toThrow(/GOOGLECHAT_AUDIENCE is required/);
    expect(addSandboxChannel).not.toHaveBeenCalled();
    expect(createCredentialFixture).not.toHaveBeenCalled();
  });

  it("does not rebuild when channel add fails", async () => {
    const addSandboxChannel = vi.fn(async () => {
      throw new Error("planned add failed");
    });
    const rebuildSandbox = vi.fn(async () => {});

    await expect(
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "e2e-hm-ch-cycle",
          agent: "hermes",
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
        {
          addSandboxChannel,
          createCredentialFixture: () => ({}),
          rebuildSandbox,
        },
      ),
    ).rejects.toThrow("planned add failed");
    expect(rebuildSandbox).not.toHaveBeenCalled();
  });

  it("limits the provider fixture to channel add and hides the source credential from rebuild", async () => {
    vi.stubEnv("GOOGLECHAT_SERVICE_ACCOUNT", "fake-service-account");
    const events: string[] = [];

    await addAndRebuildGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-hm-ch-cycle",
        agent: "hermes",
        audience: "https://e2e-fake.trycloudflare.com/googlechat",
      },
      {
        createCredentialFixture: () => {
          events.push("create-fixture");
          return {};
        },
        addSandboxChannel: async () => {
          expect(process.env.GOOGLECHAT_SERVICE_ACCOUNT).toBe("fake-service-account");
          events.push("add");
        },
        rebuildSandbox: async (_sandboxName, args) => {
          expect(args).toEqual(["--yes"]);
          expect(process.env.GOOGLECHAT_SERVICE_ACCOUNT).toBeUndefined();
          events.push("rebuild");
        },
      },
    );

    expect(events).toEqual(["create-fixture", "add", "rebuild"]);
    expect(process.env.GOOGLECHAT_SERVICE_ACCOUNT).toBe("fake-service-account");
    vi.unstubAllEnvs();
  });

  it("restores the source credential when rebuild fails", async () => {
    vi.stubEnv("GOOGLECHAT_SERVICE_ACCOUNT", "fake-service-account");

    await expect(
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "e2e-oc-ch-cycle",
          agent: "openclaw",
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
        {
          createCredentialFixture: () => ({}),
          addSandboxChannel: async () => {},
          rebuildSandbox: async () => {
            expect(process.env.GOOGLECHAT_SERVICE_ACCOUNT).toBeUndefined();
            throw new Error("planned rebuild failed");
          },
        },
      ),
    ).rejects.toThrow("planned rebuild failed");
    expect(process.env.GOOGLECHAT_SERVICE_ACCOUNT).toBe("fake-service-account");
    vi.unstubAllEnvs();
  });

  it("reuses the gateway credential without creating a fixture for a later rebuild", async () => {
    vi.stubEnv("GOOGLECHAT_SERVICE_ACCOUNT", "fake-service-account");
    const events: string[] = [];
    const createCredentialFixture = vi.fn(() => ({}));

    await rebuildGooglechatForChannelsStopStartLiveE2e(
      { sandboxName: "e2e-oc-ch-cycle", agent: "openclaw" },
      {
        createCredentialFixture,
        addSandboxChannel: async () => {},
        rebuildSandbox: async (_sandboxName, args) => {
          expect(args).toEqual(["--yes"]);
          expect(process.env.GOOGLECHAT_SERVICE_ACCOUNT).toBeUndefined();
          events.push("rebuild");
        },
      },
    );

    expect(events).toEqual(["rebuild"]);
    expect(createCredentialFixture).not.toHaveBeenCalled();
    expect(process.env.GOOGLECHAT_SERVICE_ACCOUNT).toBe("fake-service-account");
    vi.unstubAllEnvs();
  });

  it.each([
    ["openclaw", "e2e-oc-ch-cycle", "google-chat-bridge"],
    ["hermes", "e2e-hm-ch-cycle", "google-chat-hermes-bridge"],
  ] as const)(
    "passes the %s Google Chat credential through the environment without adding it to argv",
    (agent, sandboxName, providerType) => {
      const delegatedName = `${sandboxName}-slack-bridge`;
      const delegatedTokenDef = {
        name: delegatedName,
        envKey: "SLACK_BOT_TOKEN",
        token: "e2e-fake-slack-token",
        providerType: "nemoclaw-mcp-v1",
      };
      const originalUpsert = vi.fn(() => [delegatedName]);
      const runGatewayOpenshell = vi.fn(
        (
          _gatewayName: string,
          args: string[],
          _options?: Parameters<FixtureChannelDependencies["runGatewayOpenshell"]>[2],
        ) => ({ status: args[1] === "get" ? 1 : 0 }),
      );
      const channelDependencies: FixtureChannelDependencies = {
        upsertMessagingProviders: originalUpsert,
        runGatewayOpenshell: runGatewayOpenshell as never,
      };
      const ensureProfiles = vi.fn();

      const fixture = createGooglechatCredentialFixture(sandboxName, agent, {
        channelDependencies,
        ensureProfiles,
        root: "/repo",
      });
      const options = { bestEffort: true, requireExactBindings: true };
      const providerNames = fixture.upsertMessagingProviders(
        [
          delegatedTokenDef,
          {
            name: `${sandboxName}-googlechat-bridge`,
            envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
            token: null,
            providerType,
          },
        ],
        "nemoclaw",
        options,
      );

      expect(providerNames).toEqual([delegatedName, `${sandboxName}-googlechat-bridge`]);
      expect(originalUpsert).toHaveBeenCalledWith([delegatedTokenDef], "nemoclaw", options);
      expect(ensureProfiles).toHaveBeenCalledOnce();
      const profileDependencies = ensureProfiles.mock.calls[0]?.[1] as {
        redact: (value: string) => string;
        root: string;
        runOpenshell: FixtureRunner;
      };
      expect(profileDependencies.root).toBe("/repo");
      expect(profileDependencies.redact(GOOGLECHAT_E2E_ACCESS_TOKEN)).toBe("[redacted]");

      const createCall = runGatewayOpenshell.mock.calls.find(([, args]) => args[1] === "create");
      expect(createCall?.[1]).toEqual([
        "provider",
        "create",
        "--name",
        `${sandboxName}-googlechat-bridge`,
        "--type",
        providerType,
        "--credential",
        "GOOGLE_CHAT_ACCESS_TOKEN",
      ]);
      expect(createCall?.[1]).not.toContain(GOOGLECHAT_E2E_ACCESS_TOKEN);
      expect(createCall?.[2]?.env).toMatchObject({
        GOOGLE_CHAT_ACCESS_TOKEN: GOOGLECHAT_E2E_ACCESS_TOKEN,
      });
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
      const calls: string[][] = [];
      const runGatewayOpenshell = vi.fn((_gatewayName: string, args: string[]) => {
        calls.push(args);
        return { status: 0 };
      });
      const fixture = createGooglechatCredentialFixture("e2e-oc-ch-cycle", "openclaw", {
        channelDependencies: {
          upsertMessagingProviders: vi.fn(() => []),
          runGatewayOpenshell: runGatewayOpenshell as never,
        },
        ensureProfiles: vi.fn(),
        root: "/repo",
      });

      fixture.upsertMessagingProviders(
        [
          {
            name: "e2e-oc-ch-cycle-googlechat-bridge",
            envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
            token: null,
            providerType: "google-chat-bridge",
          },
        ],
        "nemoclaw",
        options,
      );

      expect(calls).toEqual(expectedCalls);
    },
  );
});
