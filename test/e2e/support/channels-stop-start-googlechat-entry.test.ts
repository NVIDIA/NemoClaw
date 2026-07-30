// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { addGooglechatForChannelsStopStartLiveE2e } from "../live/channels-stop-start-googlechat-entry.ts";

describe("channels stop/start Google Chat live composition", () => {
  it("grants a process-local audience capability to the exact live sandbox", async () => {
    const addSandboxChannel = vi.fn(async () => {});

    await addGooglechatForChannelsStopStartLiveE2e(
      {
        sandboxName: "e2e-channels-stop-start-openclaw",
        audience: "  https://e2e-fake.trycloudflare.com/googlechat  ",
      },
      { addSandboxChannel },
    );

    expect(addSandboxChannel).toHaveBeenCalledWith(
      "e2e-channels-stop-start-openclaw",
      { channel: "googlechat" },
      {
        googlechatNonInteractiveAudienceCapability: {
          audience: "https://e2e-fake.trycloudflare.com/googlechat",
        },
      },
    );
  });

  it("refuses to grant the capability outside the destructive live-test sandbox namespace", async () => {
    const addSandboxChannel = vi.fn(async () => {});

    await expect(
      addGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "production-openclaw",
          audience: "https://example.com/googlechat",
        },
        { addSandboxChannel },
      ),
    ).rejects.toThrow(/only accepts sandbox names with prefix/);
    expect(addSandboxChannel).not.toHaveBeenCalled();
  });

  it("refuses an empty live-test audience", async () => {
    const addSandboxChannel = vi.fn(async () => {});

    await expect(
      addGooglechatForChannelsStopStartLiveE2e(
        {
          sandboxName: "e2e-channels-stop-start-openclaw",
          audience: " ",
        },
        { addSandboxChannel },
      ),
    ).rejects.toThrow(/GOOGLECHAT_AUDIENCE is required/);
    expect(addSandboxChannel).not.toHaveBeenCalled();
  });
});
