// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import { refreshOpenClawMessagingPluginRegistryAfterRestore } from "./rebuild-messaging-phase";

function plan(active: boolean): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "rebuild",
    channels: [
      {
        channelId: "voiceclaw",
        displayName: "VoiceClaw",
        authMode: "token-paste",
        active,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [
      {
        channelId: "voiceclaw",
        hookId: "manifest",
        outputId: "voiceclaw-openclaw-plugin",
        kind: "package-install",
        required: true,
        value: {
          manager: "openclaw-plugin",
          spec: "npm:@openclaw/voice-call@2026.7.1",
        },
      },
    ],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("rebuild messaging plugin registry refresh", () => {
  it("refreshes OpenClaw discovery after restoring state for an active external plugin (#6387)", () => {
    const run = vi.fn(() => ({ status: 0 }));

    refreshOpenClawMessagingPluginRegistryAfterRestore("alpha", plan(true), run);

    expect(run).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "alpha", "--", "openclaw", "plugins", "registry", "--refresh"],
      { ignoreError: true },
    );
  });

  it("does not refresh discovery when the external plugin channel is inactive (#6387)", () => {
    const run = vi.fn(() => ({ status: 0 }));

    refreshOpenClawMessagingPluginRegistryAfterRestore("alpha", plan(false), run);

    expect(run).not.toHaveBeenCalled();
  });
});
