// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

export const whatsappManifest = {
  schemaVersion: 1,
  id: "whatsapp",
  displayName: "WhatsApp",
  description: "WhatsApp Web messaging (QR pairing)",
  supportedAgents: ["openclaw", "hermes"],
  auth: {
    mode: "in-sandbox-qr",
  },
  inputs: [],
  credentials: [],
  policyPresets: ["whatsapp"],
  render: [
    {
      id: "whatsapp-openclaw-account",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "channels.whatsapp.accounts.default",
        value: {
          enabled: true,
          healthMonitor: {
            enabled: false,
          },
        },
      },
    },
    {
      id: "whatsapp-hermes-env",
      kind: "env-lines",
      agent: "hermes",
      target: "~/.hermes/.env",
      lines: ["WHATSAPP_ENABLED=true", "WHATSAPP_MODE=bot"],
    },
  ],
  state: {},
  hooks: [],
} as const satisfies ChannelManifest;
