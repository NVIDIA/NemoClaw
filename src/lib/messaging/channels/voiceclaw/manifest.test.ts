// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { ManifestCompiler } from "../../compiler/manifest-compiler";
import { createBuiltInMessagingHookRegistry } from "../../hooks";
import {
  createBuiltInChannelManifestRegistry,
  createBuiltInRenderTemplateResolver,
} from "../index";
import { loadMessagingChannelPolicyPreset } from "../policy";

describe("VoiceClaw channel manifest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("compiles the OpenClaw config, policy, and persisted bridge settings (#6387)", async () => {
    vi.stubEnv("VOICECLAW_ENABLED", "1");
    vi.stubEnv("VOICECLAW_AUDIO_BRIDGE_URL", "http://host.openshell.internal:7880");
    const compiler = new ManifestCompiler(
      createBuiltInChannelManifestRegistry(),
      createBuiltInMessagingHookRegistry(),
      createBuiltInRenderTemplateResolver(),
    );

    const plan = await compiler.compile({
      sandboxName: "voice-agent",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["voiceclaw"],
      credentialAvailability: {},
    });

    expect(plan.channels).toMatchObject([
      {
        channelId: "voiceclaw",
        active: true,
        configured: true,
        authMode: "none",
        inputs: [
          { inputId: "enabled", value: "1" },
          {
            inputId: "audioBridgeUrl",
            value: "http://host.openshell.internal:7880",
          },
        ],
      },
    ]);
    expect(plan.networkPolicy.entries).toEqual([
      {
        channelId: "voiceclaw",
        presetName: "voiceclaw",
        policyKeys: ["voiceclaw"],
        source: "manifest",
      },
    ]);
    expect(plan.agentRender).toMatchObject([
      {
        channelId: "voiceclaw",
        renderId: "voiceclaw-openclaw-plugin",
        path: "plugins.entries.voiceclaw",
        value: {
          enabled: true,
          config: {
            voiceModeEnabled: true,
            audioBridgeUrl: "http://host.openshell.internal:7880",
          },
        },
      },
    ]);
    expect(plan.buildSteps).toEqual([]);
    expect(plan.stateUpdates).toEqual([
      {
        channelId: "voiceclaw",
        kind: "persist-inputs",
        stateKey: "voiceclaw",
        inputIds: ["enabled", "audioBridgeUrl"],
      },
      {
        channelId: "voiceclaw",
        kind: "rebuild-hydration",
        env: "VOICECLAW_ENABLED",
        statePath: "voiceclaw.enabled",
      },
      {
        channelId: "voiceclaw",
        kind: "rebuild-hydration",
        env: "VOICECLAW_AUDIO_BRIDGE_URL",
        statePath: "voiceclaw.audioBridgeUrl",
      },
    ]);
  });

  it("limits host-bridge egress to the published VoiceClaw API routes (#6387)", () => {
    const content = loadMessagingChannelPolicyPreset("voiceclaw", { agent: "openclaw" });
    expect(content).not.toBeNull();
    const parsed = YAML.parse(content!) as {
      network_policies: {
        voiceclaw: {
          endpoints: Array<{
            host: string;
            port: number;
            allowed_ips: string[];
            rules: Array<{ allow: { method: string; path: string } }>;
          }>;
        };
      };
    };

    expect(parsed.network_policies.voiceclaw.endpoints).toEqual([
      expect.objectContaining({
        host: "host.openshell.internal",
        port: 7880,
        allowed_ips: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
        rules: [
          { allow: { method: "GET", path: "/health" } },
          { allow: { method: "POST", path: "/call/connect" } },
          { allow: { method: "POST", path: "/call/say" } },
          { allow: { method: "POST", path: "/call/speak" } },
          { allow: { method: "POST", path: "/call/listen" } },
          { allow: { method: "POST", path: "/call/hangup" } },
        ],
      }),
    ]);
  });
});
