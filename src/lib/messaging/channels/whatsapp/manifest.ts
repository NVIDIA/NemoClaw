// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

export const whatsappManifest = {
  schemaVersion: 1,
  id: "whatsapp",
  displayName: "WhatsApp",
  description: "WhatsApp Web messaging (QR pairing)",
  enrollmentHelp:
    "WhatsApp Web pairs via QR code scanned with your phone — no host-side token. After the sandbox is running, run `openshell term` and then use `openclaw channels login --channel whatsapp` for OpenClaw or `hermes whatsapp` for Hermes to display the QR.",
  enrollmentNotes: [
    "After pairing, run `nemoclaw <sandbox> channels status --channel whatsapp` to confirm the bridge is delivering inbound messages — pairing alone does not guarantee inbound delivery (issue #4386).",
  ],
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "in-sandbox-qr",
  },
  inputs: [
    {
      id: "allowedIds",
      kind: "config",
      required: false,
      envKey: "WHATSAPP_ALLOWED_IDS",
      statePath: "allowedIds.whatsapp",
    },
  ],
  credentials: [],
  policyPresets: ["whatsapp"],
  render: [
    {
      id: "whatsapp-openclaw-channel",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.whatsapp",
        value: {
          enabled: true,
          accounts: {
            default: {
              enabled: true,
              healthMonitor: {
                enabled: false,
              },
            },
          },
        },
      },
    },
    {
      id: "whatsapp-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.whatsapp",
        value: {
          enabled: true,
        },
      },
    },
    {
      id: "whatsapp-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: [
        "WHATSAPP_ENABLED=true",
        "WHATSAPP_MODE=bot",
        "WHATSAPP_ALLOWED_USERS={{allowedIds.whatsapp.csv}}",
      ],
    },
    {
      id: "whatsapp-hermes-platform",
      kind: "json-fragment",
      agent: "hermes",
      target: "~/.hermes/config.yaml",
      fragment: {
        path: "platforms.whatsapp",
        value: {
          enabled: true,
        },
      },
    },
  ],
  state: {
    persist: {
      allowedIds: ["allowedIds"],
    },
    rebuildHydration: [
      {
        statePath: "allowedIds.whatsapp",
        env: "WHATSAPP_ALLOWED_IDS",
      },
    ],
  },
  hooks: [
    {
      id: "whatsapp-openclaw-package-install",
      phase: "agent-install",
      handler: "common.staticOutputs",
      agents: ["openclaw"],
      outputs: [
        {
          id: "openclawPluginPackage",
          kind: "package-install",
          required: true,
          value: {
            manager: "openclaw-plugin",
            spec: "npm:@openclaw/whatsapp@{{openclaw.version}}",
            pin: true,
          },
        },
      ],
      onFailure: "abort",
    },
  ],
} as const satisfies ChannelManifest;
