// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  addGooglechatForChannelsStopStartLiveE2e,
  GOOGLECHAT_E2E_ACCESS_TOKEN,
  installGooglechatCredentialFixture,
} from "../live/channels-stop-start-googlechat-entry.ts";

type FixturePolicyDependencies = Pick<
  (typeof import("../../../src/lib/actions/sandbox/policy-channel-dependencies.ts"))["policyChannelDependencies"],
  "upsertMessagingProviders"
>;
type FixtureRunner = typeof import("../../../src/lib/adapters/openshell/runtime.ts").runOpenshell;

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

  it.each([
    ["openclaw", "e2e-oc-ch-cycle", "google-chat-bridge"],
    ["hermes", "e2e-hm-ch-cycle", "google-chat-hermes-bridge"],
  ] as const)(
    "creates the real %s provider profile without putting the fixture value in argv",
    (agent, sandboxName, providerType) => {
      const originalUpsert = vi.fn(() => ["original-provider"]);
      const policyDependencies: FixturePolicyDependencies = {
        upsertMessagingProviders: originalUpsert,
      };
      const ensureProfiles = vi.fn();
      const runMock = vi.fn((args: string[], _options?: { env?: NodeJS.ProcessEnv }) => ({
        status: args[1] === "get" ? 1 : 0,
      }));
      const run = runMock as unknown as FixtureRunner;

      const restore = installGooglechatCredentialFixture(sandboxName, agent, {
        ensureProfiles,
        policyDependencies,
        root: "/repo",
        run,
      });
      const providerNames = policyDependencies.upsertMessagingProviders([
        {
          name: `${sandboxName}-googlechat-bridge`,
          envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
          token: null,
          providerType,
        },
      ]);

      expect(providerNames).toEqual([`${sandboxName}-googlechat-bridge`]);
      expect(ensureProfiles).toHaveBeenCalledOnce();
      const profileDependencies = ensureProfiles.mock.calls[0]?.[1] as {
        redact: (value: string) => string;
        root: string;
        runOpenshell: FixtureRunner;
      };
      expect(profileDependencies.root).toBe("/repo");
      expect(profileDependencies.runOpenshell).toBe(run);
      expect(profileDependencies.redact(GOOGLECHAT_E2E_ACCESS_TOKEN)).toBe("[redacted]");

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
      expect(policyDependencies.upsertMessagingProviders).toBe(originalUpsert);
    },
  );
});
