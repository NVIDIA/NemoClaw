// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../../../src/lib/messaging/manifest/index.ts";
import {
  GOOGLECHAT_E2E_ACCESS_TOKEN,
  addAndRebuildGooglechatForChannelsStopStartLiveE2e,
  installGooglechatCredentialFixture,
  rebuildGooglechatForChannelsStopStartLiveE2e,
} from "../live/channels-stop-start-helpers.ts";

type GooglechatFixtureDependencies = NonNullable<
  Parameters<typeof installGooglechatCredentialFixture>[2]
>;
type GooglechatFixtureApplier = NonNullable<GooglechatFixtureDependencies["messagingSetupApplier"]>;
type GooglechatFixtureChannelDependencies = NonNullable<
  GooglechatFixtureDependencies["channelDependencies"]
>;
describe("channels stop/start Google Chat live composition", () => {
  it("uses the fixed access token for typed channel add and rebuild application", async () => {
    const providerName = "e2e-oc-ch-cycle-googlechat-bridge";
    const plan: SandboxMessagingPlan = {
      schemaVersion: 1,
      sandboxName: "e2e-oc-ch-cycle",
      agent: "openclaw",
      workflow: "onboard",
      channels: [],
      disabledChannels: [],
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    };
    const definition = {
      channelId: "googlechat",
      credentialId: "GOOGLE_CHAT_ACCESS_TOKEN",
      providerName,
      providerType: "google-chat-bridge",
      credentials: [{ name: "GOOGLE_CHAT_ACCESS_TOKEN", value: "openshell-managed-pending-mint" }],
      profile: { profilePath: "/repo/googlechat.yaml", profileType: "google-chat-bridge" },
    } as const;
    const refresh = {
      channelId: "googlechat",
      providerName,
      credentialKey: "GOOGLE_CHAT_ACCESS_TOKEN",
      strategy: "google-service-account-jwt",
      material: [{ key: "client_email", value: "bot@example.test" }],
      secretMaterial: [{ key: "private_key", value: "fixture-private-key" }],
    } as const;
    const applied = {
      upserted: [],
      reused: [],
      missing: [],
      replacedProviderNames: [],
      providerNames: [providerName],
      sandboxCreateProviderArgs: ["--provider", providerName],
    } as const;
    const applyCredentialsAtOpenShell = vi.fn<
      GooglechatFixtureApplier["applyCredentialsAtOpenShell"]
    >(async () => applied);
    const messagingSetupApplier: GooglechatFixtureApplier = { applyCredentialsAtOpenShell };
    const channelDependencies: GooglechatFixtureChannelDependencies = {
      upsertMessagingProviders: vi.fn(async (_tokenDefs, _gatewayName, _options, context) => {
        const result = await messagingSetupApplier.applyCredentialsAtOpenShell(context!.plan, {
          runOpenshell: () => ({ status: 0, stdout: "", stderr: "" }),
          definitions: [definition],
          refreshes: [refresh],
        });
        return [...result.providerNames];
      }),
    };
    const fixture = installGooglechatCredentialFixture("e2e-oc-ch-cycle", "openclaw", {
      channelDependencies,
      messagingSetupApplier,
    });

    try {
      const addProviderNames = await fixture.upsertMessagingProviders(
        [
          {
            name: providerName,
            envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
            token: "openshell-managed-pending-mint",
            providerType: "google-chat-bridge",
          },
        ],
        "test-gateway",
        {},
        {
          plan,
          channelName: "googlechat",
          sandboxAgent: "openclaw",
          sandboxName: "e2e-oc-ch-cycle",
          revalidateSandboxIdentity: () => undefined,
        },
      );
      const rebuildApplication = await fixture.applyCredentialsAtOpenShell(plan, {
        runOpenshell: () => ({ status: 0, stdout: "", stderr: "" }),
        definitions: [definition],
        refreshes: [refresh],
      });

      expect(addProviderNames).toEqual([providerName]);
      expect(rebuildApplication).toEqual(applied);
      expect(channelDependencies.upsertMessagingProviders).toHaveBeenCalledTimes(1);
      expect(applyCredentialsAtOpenShell).toHaveBeenCalledTimes(2);
      expect(
        applyCredentialsAtOpenShell.mock.calls.map(([, options]) => ({
          definitions: options.definitions,
          refreshes: options.refreshes,
        })),
      ).toEqual([
        {
          definitions: [
            {
              ...definition,
              credentials: [
                { name: "GOOGLE_CHAT_ACCESS_TOKEN", value: GOOGLECHAT_E2E_ACCESS_TOKEN },
              ],
            },
          ],
          refreshes: [],
        },
        {
          definitions: [
            {
              ...definition,
              credentials: [
                { name: "GOOGLE_CHAT_ACCESS_TOKEN", value: GOOGLECHAT_E2E_ACCESS_TOKEN },
              ],
            },
          ],
          refreshes: [],
        },
      ]);
      expect(JSON.stringify(applyCredentialsAtOpenShell.mock.calls)).not.toContain(
        "fixture-private-key",
      );
    } finally {
      fixture();
    }

    expect(messagingSetupApplier.applyCredentialsAtOpenShell).toBe(applyCredentialsAtOpenShell);
  });

  it("grants a process-local audience capability to the exact live sandbox", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const rebuildSandbox = vi.fn(async () => {});
    const restore = vi.fn();
    const installCredentialFixture = vi.fn(() => restore);

    await addAndRebuildGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-oc-ch-cycle",
        agent: "openclaw",
        audience: "  https://e2e-fake.trycloudflare.com/googlechat  ",
      },
      { addSandboxChannel, installCredentialFixture, rebuildSandbox },
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
    expect(rebuildSandbox).toHaveBeenCalledWith("e2e-oc-ch-cycle", ["--yes"]);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("adds Hermes Google Chat without the OpenClaw audience capability", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const rebuildSandbox = vi.fn(async () => {});
    const restore = vi.fn();
    const installCredentialFixture = vi.fn(() => restore);

    await addAndRebuildGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-hm-ch-cycle",
        agent: "hermes",
        audience: "https://e2e-fake.trycloudflare.com/googlechat",
      },
      { addSandboxChannel, installCredentialFixture, rebuildSandbox },
    );

    expect(installCredentialFixture).toHaveBeenCalledWith("e2e-hm-ch-cycle", "hermes");
    expect(addSandboxChannel).toHaveBeenCalledWith(
      "e2e-hm-ch-cycle",
      { channel: "googlechat" },
      {},
    );
    expect(rebuildSandbox).toHaveBeenCalledWith("e2e-hm-ch-cycle", ["--yes"]);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("refuses to grant the capability outside the destructive live-test sandbox namespace", async () => {
    const addSandboxChannel = vi.fn(async () => {});
    const installCredentialFixture = vi.fn(() => vi.fn());

    await expect(
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
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
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
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
      addAndRebuildGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "e2e-hm-ch-cycle",
          agent: "hermes",
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
        {
          addSandboxChannel,
          installCredentialFixture: () => restore,
          rebuildSandbox: async () => {},
        },
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
});
