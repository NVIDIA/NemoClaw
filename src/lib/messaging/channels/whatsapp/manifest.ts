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
    "After pairing, run `nemoclaw <sandbox> channels status --channel whatsapp`. OpenClaw reports inbound delivery evidence; Hermes reports gateway and dashboard session-path diagnostics.",
  ],
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "in-sandbox-qr",
  },
  inputs: [
    {
      id: "mode",
      kind: "config",
      required: false,
      envKey: "WHATSAPP_MODE",
      statePath: "whatsappConfig.mode",
      validValues: ["self-chat", "bot"],
      // Hermes adapter default. `self-chat` replies only to messages the paired
      // account sends to itself and reads no allowlist, so a paired sandbox works
      // with nothing else set. `bot` serves other senders.
      defaultValue: "self-chat",
      prompt: {
        label: "WhatsApp reply mode",
        help: "self-chat replies only to messages the paired account sends to itself. bot replies to other senders and stops replying to that self-chat: an unknown sender receives a pairing code you approve with `hermes pairing approve whatsapp <code>`, unless you set WHATSAPP_ALLOWED_IDS to a fixed sender list before this command.",
        emptyValueMessage: "the sandbox replies only in your own self-chat",
      },
    },
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
        "WHATSAPP_MODE={{whatsappConfig.mode}}",
        "WHATSAPP_DM_POLICY={{whatsappConfig.dmPolicy}}",
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
  runtime: {
    openclaw: {
      channelName: "whatsapp",
      visibility: {
        configKeys: ["whatsapp"],
        logPatterns: ["whatsapp"],
      },
      nodePreloads: [
        {
          module: "whatsapp-qr-compact",
          injectInto: ["connect"],
          optional: true,
          installMessage:
            "[channels] Installing WhatsApp compact-QR renderer (scan-friendly pairing)",
        },
      ],
    },
  },
  agentPackages: [
    {
      id: "openclawPluginPackage",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: "npm:@openclaw/whatsapp@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        "2026.7.1":
          "sha512-wLY/Omc5fleRpl2lKGN8sxt/8hYfHGwLRezmWsk8oCbea5pRKUPE6ZX+wJO1O52NOJkAGCuiXvS7x0qIeKxXbQ==",
      },
      tarballUrlByVersion: {
        "2026.7.1": "https://registry.npmjs.org/@openclaw/whatsapp/-/whatsapp-2026.7.1.tgz",
      },
      required: true,
    },
  ],
  hooks: [
    {
      // Only Hermes reads a reply mode: NemoClaw renders `WHATSAPP_MODE` and
      // `WHATSAPP_DM_POLICY` into the Hermes env, and the OpenClaw fragment
      // carries no sender policy, so prompting an OpenClaw operator would
      // collect an answer nothing consumes.
      id: "whatsapp-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      agents: ["hermes"],
      outputs: [
        {
          id: "mode",
          kind: "config",
        },
      ],
    },
    {
      id: "whatsapp-status-health",
      phase: "status",
      handler: "whatsapp.statusHealth",
      agents: ["openclaw", "hermes"],
      outputs: [
        {
          id: "channelHealth",
          kind: "status",
        },
      ],
    },
  ],
} as const satisfies ChannelManifest;
