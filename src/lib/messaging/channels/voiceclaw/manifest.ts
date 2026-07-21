// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

export const voiceclawManifest = {
  schemaVersion: 1,
  id: "voiceclaw",
  displayName: "VoiceClaw",
  description: "Voice call communication through a host-local audio bridge",
  supportedAgents: ["openclaw"],
  auth: {
    mode: "none",
  },
  inputs: [
    {
      id: "enabled",
      kind: "config",
      required: true,
      envKey: "VOICECLAW_ENABLED",
      statePath: "voiceclaw.enabled",
      validValues: ["1"],
      defaultValue: "1",
      prompt: {
        label: "Enable VoiceClaw",
        help: "Set VOICECLAW_ENABLED=1 for non-interactive onboarding.",
      },
    },
    {
      id: "audioBridgeUrl",
      kind: "config",
      required: false,
      envKey: "VOICECLAW_AUDIO_BRIDGE_URL",
      statePath: "voiceclaw.audioBridgeUrl",
      defaultValue: "http://host.openshell.internal:7880",
      prompt: {
        label: "VoiceClaw audio bridge URL",
        help: "Host-local VoiceClaw audio bridge base URL.",
      },
    },
  ],
  credentials: [],
  policyPresets: [{ name: "voiceclaw", policyKeys: ["voiceclaw"] }],
  render: [
    {
      id: "voiceclaw-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.voiceclaw",
        value: {
          enabled: true,
          config: {
            voiceModeEnabled: true,
            audioBridgeUrl: "{{voiceclaw.audioBridgeUrl}}",
          },
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      extensionId: "voiceclaw",
      visibility: {
        configKeys: [],
        pluginConfigKeys: ["voiceclaw"],
        logPatterns: ["voiceclaw"],
      },
    },
  },
  // The trusted package install is intentionally absent until VoiceClaw publishes
  // an immutable public artifact with reviewed integrity metadata (issue #6387).
  hooks: [
    {
      id: "voiceclaw-status-health",
      phase: "status",
      handler: "voiceclaw.statusHealth",
      agents: ["openclaw"],
      outputs: [
        {
          id: "channelHealth",
          kind: "status",
        },
      ],
    },
  ],
} as const satisfies ChannelManifest;
