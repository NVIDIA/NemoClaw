// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

export const VOICECLAW_WEBHOOK_PORT = "3334";
export const VOICECLAW_WEBHOOK_PATH = "/voice/webhook";

export const voiceclawManifest = {
  schemaVersion: 1,
  id: "voiceclaw",
  displayName: "VoiceClaw",
  description: "Telnyx voice calls through the OpenClaw voice-call plugin",
  enrollmentNotes: [
    "This MVP supports Telnyx and OpenClaw only.",
    "Copy the Telnyx webhook public key from the Telnyx Mission Control Portal.",
    "Route a public HTTPS URL to the forwarded VoiceClaw webhook port before placing a conversation call.",
    "Telnyx provides speech-to-text while NVIDIA Magpie provides non-streaming text-to-speech.",
  ],
  supportedAgents: ["openclaw"],
  auth: {
    mode: "token-paste",
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
      id: "telnyxApiKey",
      kind: "secret",
      required: true,
      envKey: "TELNYX_API_KEY",
      prompt: {
        label: "Telnyx API key",
        help: "Enter the API key for the Telnyx Call Control application.",
      },
    },
    {
      id: "telnyxConnectionId",
      kind: "config",
      required: true,
      envKey: "VOICECLAW_TELNYX_CONNECTION_ID",
      statePath: "voiceclaw.telnyxConnectionId",
      formatPattern: "^[0-9]+$",
      formatHint: "Numeric Telnyx Call Control connection ID.",
      prompt: {
        label: "Telnyx connection ID",
        help: "Enter the connection ID for the Telnyx Call Control application.",
      },
    },
    {
      id: "telnyxPublicKey",
      kind: "config",
      required: true,
      envKey: "VOICECLAW_TELNYX_PUBLIC_KEY",
      statePath: "voiceclaw.telnyxPublicKey",
      prompt: {
        label: "Telnyx public key",
        help: "Enter the Ed25519 public key used to verify Telnyx webhook signatures.",
      },
    },
    {
      id: "nvidiaApiKey",
      kind: "secret",
      required: true,
      envKey: "NVIDIA_API_KEY",
      prompt: {
        label: "NVIDIA API key",
        help: "Enter the NVIDIA API key used for VoiceClaw TTS.",
      },
    },
    {
      id: "telnyxFromNumber",
      kind: "config",
      required: true,
      envKey: "VOICECLAW_TELNYX_FROM_NUMBER",
      statePath: "voiceclaw.telnyxFromNumber",
      formatPattern: "^\\+[1-9][0-9]{1,14}$",
      formatHint: "E.164 number such as +15550001234.",
      prompt: {
        label: "Telnyx caller number",
        help: "Enter the Telnyx-owned E.164 number used for outbound calls.",
      },
    },
    {
      id: "telnyxToNumber",
      kind: "config",
      required: true,
      envKey: "VOICECLAW_TELNYX_TO_NUMBER",
      statePath: "voiceclaw.telnyxToNumber",
      formatPattern: "^\\+[1-9][0-9]{1,14}$",
      formatHint: "E.164 number such as +15550005678.",
      prompt: {
        label: "Default destination number",
        help: "Enter the E.164 number used as the default outbound destination and the only allowed inbound caller.",
      },
    },
    {
      id: "publicUrl",
      kind: "config",
      required: true,
      envKey: "VOICECLAW_PUBLIC_URL",
      statePath: "voiceclaw.publicUrl",
      formatPattern: "^https://[^\\s]+/voice/webhook$",
      formatHint: "Public HTTPS URL ending in /voice/webhook.",
      prompt: {
        label: "Telnyx webhook URL",
        help: "Enter the public HTTPS URL that forwards to the VoiceClaw webhook port.",
      },
    },
    {
      id: "webhookPort",
      kind: "config",
      required: false,
      envKey: "VOICECLAW_WEBHOOK_PORT",
      statePath: "voiceclaw.webhookPort",
      validValues: [VOICECLAW_WEBHOOK_PORT],
      defaultValue: VOICECLAW_WEBHOOK_PORT,
      prompt: {
        label: "VoiceClaw webhook port",
        help: "The POC uses OpenClaw voice-call port 3334.",
      },
    },
  ],
  credentials: [
    {
      id: "telnyxApiKey",
      sourceInput: "telnyxApiKey",
      providerName: "{sandboxName}-voiceclaw-telnyx",
      providerEnvKey: "TELNYX_API_KEY",
      placeholder: "openshell:resolve:env:TELNYX_API_KEY",
      primary: true,
    },
    {
      id: "nvidiaApiKey",
      sourceInput: "nvidiaApiKey",
      providerName: "{sandboxName}-voiceclaw-nvidia-speech",
      providerEnvKey: "NVIDIA_API_KEY",
      placeholder: "openshell:resolve:env:NVIDIA_API_KEY",
    },
  ],
  policyPresets: [{ name: "voiceclaw", policyKeys: ["voiceclaw"] }],
  hostForward: {
    port: "{{voiceclaw.webhookPort}}",
    label: "VoiceClaw Telnyx webhook",
  },
  render: [
    {
      id: "voiceclaw-openclaw-plugin",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "plugins.entries.voice-call",
        value: {
          enabled: true,
          config: {
            enabled: true,
            provider: "telnyx",
            fromNumber: "{{voiceclaw.telnyxFromNumber}}",
            toNumber: "{{voiceclaw.telnyxToNumber}}",
            telnyx: {
              apiKey: "{{credential.telnyxApiKey.placeholder}}",
              connectionId: "{{voiceclaw.telnyxConnectionId}}",
              publicKey: "{{voiceclaw.telnyxPublicKey}}",
            },
            serve: {
              bind: "0.0.0.0",
              port: "{{voiceclaw.webhookPort}}",
              path: VOICECLAW_WEBHOOK_PATH,
            },
            publicUrl: "{{voiceclaw.publicUrl}}",
            inboundPolicy: "allowlist",
            allowFrom: ["{{voiceclaw.telnyxToNumber}}"],
            ringTimeoutMs: 120_000,
            responseModel: "inference/nvidia/nemotron-3-super-120b-a12b",
            outbound: {
              defaultMode: "conversation",
            },
            tts: {
              provider: "nvidia",
              timeoutMs: 120_000,
              providers: {
                nvidia: {
                  apiKey: "{{credential.nvidiaApiKey.placeholder}}",
                  model: "magpie-tts-multilingual",
                  voice: "Magpie-Multilingual.EN-US.Aria",
                  language: "en-US",
                  sampleRateHz: 44100,
                },
              },
            },
          },
        },
      },
    },
    {
      id: "voiceclaw-openclaw-tts",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "messages.tts",
        value: {
          provider: "nvidia",
          providers: {
            nvidia: {
              apiKey: "{{credential.nvidiaApiKey.placeholder}}",
              model: "magpie-tts-multilingual",
              voice: "Magpie-Multilingual.EN-US.Aria",
              language: "en-US",
              sampleRateHz: 44100,
            },
          },
        },
      },
    },
  ],
  runtime: {
    openclaw: {
      extensionId: "voice-call",
      visibility: {
        configKeys: [],
        pluginConfigKeys: ["voice-call"],
        logPatterns: ["voice-call", "telnyx"],
      },
      nodePreloads: [
        {
          module: "openclaw-nvidia-speech",
          injectInto: ["boot", "connect"],
          // The packaged preload is required. Its exact-version source hooks
          // fail open with a bounded warning if the pinned OpenClaw artifact
          // changes before this MVP compatibility patch is removed.
          optional: false,
          installMessage: "[channels] Installing VoiceClaw NVIDIA TTS compatibility patch",
          installedMessage:
            "[channels] VoiceClaw NVIDIA TTS compatibility patch installed (NODE_OPTIONS updated)",
        },
        {
          module: "openclaw-voicecall-telnyx-tts",
          injectInto: ["boot", "connect"],
          optional: false,
          installMessage: "[channels] Installing VoiceClaw Telnyx NVIDIA TTS compatibility patch",
          installedMessage:
            "[channels] VoiceClaw Telnyx NVIDIA TTS compatibility patch installed (NODE_OPTIONS updated)",
        },
      ],
    },
  },
  agentPackages: [
    {
      id: "openclawVoiceCallPlugin",
      agent: "openclaw",
      manager: "openclaw-plugin",
      spec: "npm:@openclaw/voice-call@{{openclaw.version}}",
      pin: true,
      integrityByVersion: {
        "2026.7.1":
          "sha512-d/gYtMZSScp75fYi7DNVslh4X+P/VaVBmOQpGIt3Y7NShHHOrMhC3oUq4N0ie50Ee/IFFWJ1BkvYNJsr0z+Nzg==",
      },
      tarballUrlByVersion: {
        "2026.7.1": "https://registry.npmjs.org/@openclaw/voice-call/-/voice-call-2026.7.1.tgz",
      },
      required: true,
    },
  ],
  hooks: [
    {
      id: "voiceclaw-token-paste",
      phase: "enroll",
      handler: "common.tokenPaste",
      outputs: [
        {
          id: "telnyxApiKey",
          kind: "secret",
          required: true,
        },
        {
          id: "nvidiaApiKey",
          kind: "secret",
          required: true,
        },
      ],
      onFailure: "skip-channel",
    },
    {
      id: "voiceclaw-config-prompt",
      phase: "enroll",
      handler: "common.configPrompt",
      outputs: [
        { id: "telnyxConnectionId", kind: "config", required: true },
        { id: "telnyxPublicKey", kind: "config", required: true },
        { id: "telnyxFromNumber", kind: "config", required: true },
        { id: "telnyxToNumber", kind: "config", required: true },
        { id: "publicUrl", kind: "config", required: true },
      ],
      onFailure: "skip-channel",
    },
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
