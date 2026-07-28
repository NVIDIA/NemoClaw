// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagingSetupApplier } from "../../messaging/applier/setup-applier";
import type { SandboxMessagingPlan } from "../../messaging/manifest";

const runOpenshell = vi.hoisted(() => vi.fn());

vi.mock("../../adapters/openshell/runtime", () => ({
  runOpenshell,
}));

import {
  reapplyMessagingManifestAfterOpenClawDoctor,
  refreshOpenClawMessagingPluginRegistryAfterRestore,
} from "./rebuild-messaging-phase";

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
  afterEach(() => {
    runOpenshell.mockReset();
    vi.restoreAllMocks();
  });

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

  it("reports a failed registry refresh without logging successful reapply (#6387)", async () => {
    vi.spyOn(MessagingSetupApplier, "applyAgentConfigAtOpenShell").mockResolvedValue({
      appliedTargets: ["/sandbox/.openclaw/openclaw.json"],
      appliedHooks: ["voiceclaw:manifest"],
      unresolvedTemplateRefs: [],
    });
    runOpenshell.mockReturnValue({ status: 1 });
    const log = vi.fn();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await reapplyMessagingManifestAfterOpenClawDoctor("alpha", plan(true), log);

    expect(log).toHaveBeenCalledWith(
      "Messaging manifest reapply failed: OpenClaw plugin registry refresh exited with status 1",
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("messaging manifest reapply:"));
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining("Messaging manifest restore failed"),
    );
  });
});
