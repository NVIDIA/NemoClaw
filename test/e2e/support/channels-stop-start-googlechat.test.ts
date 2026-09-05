// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  addAndRebuildGooglechatForChannelsStopStartLiveE2e,
  rebuildGooglechatForChannelsStopStartLiveE2e,
} from "../live/channels-stop-start-helpers.ts";
describe("channels stop/start Google Chat live composition", () => {
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
