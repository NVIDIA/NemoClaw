// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChannelManifest } from "../../manifest";

export const VOICECLAW_WEBHOOK_PORT = "3334";
export const VOICECLAW_WEBHOOK_PATH = "/voice/webhook";

export const voiceclawManifest = {
  schemaVersion: 1,
  id: "voiceclaw",
  displayName: "VoiceClaw",
  description: "Twilio voice calls through the OpenClaw voice-call plugin",
  enrollmentNotes: [
    "This POC supports Twilio and OpenClaw only.",
    "POC risk: the Twilio Auth Token is stored as text in NemoClaw state and OpenClaw configuration because OpenShell does not inject credentials into inbound webhook handling.",
    "Route a public HTTPS URL to the forwarded VoiceClaw webhook port before placing a conversation call.",
    "NVIDIA batch ASR is available to OpenClaw, but it is not a realtime Twilio transcription provider.",
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
      id: "twilioAccountSid",
      kind: "config",
      required: true,
      envKey: "VOICECLAW_TWILIO_ACCOUNT_SID",
      statePath: "voiceclaw.twilioAccountSid",
      formatPattern: "^AC[0-9a-fA-F]{32}$",
      formatHint: "Twilio Account SID in AC... format.",
      prompt: {
        label: "Twilio Account SID",
        help: "Enter the Account SID for the Twilio project that owns the caller number.",
      },
    },
    {
      id: "twilioAuthToken",
      kind: "config",
      required: true,
      envKey: "VOICECLAW_TWILIO_AUTH_TOKEN",
      statePath: "voiceclaw.twilioAuthToken",
      prompt: {
        label: "Twilio Auth Token",
        help: "POC only: stored as text so the inbound Twilio webhook can use it.",
      },
    },
    {
      id: "nvidiaApiKey",
      kind: "secret",
      required: true,
      envKey: "NVIDIA_API_KEY",
      prompt: {
        label: "NVIDIA API key",
        help: "Enter the NVIDIA API key used for VoiceClaw batch ASR and TTS.",
      },
    },
    {
      id: "twilioFromNumber",
      kind: "config",
      required: true,
      envKey: "VOICECLAW_TWILIO_FROM_NUMBER",
      statePath: "voiceclaw.twilioFromNumber",
      formatPattern: "^\\+[1-9][0-9]{1,14}$",
      formatHint: "E.164 number such as +15550001234.",
      prompt: {
        label: "Twilio caller number",
        help: "Enter the Twilio-owned E.164 number used for outbound calls.",
      },
    },
    {
      id: "twilioToNumber",
      kind: "config",
      required: false,
      envKey: "VOICECLAW_TWILIO_TO_NUMBER",
      statePath: "voiceclaw.twilioToNumber",
      formatPattern: "^\\+[1-9][0-9]{1,14}$",
      formatHint: "E.164 number such as +15550005678.",
      prompt: {
        label: "Default destination number",
        help: "Optional E.164 destination used when a call command omits --to.",
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
        label: "Twilio webhook URL",
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
      id: "nvidiaApiKey",
      sourceInput: "nvidiaApiKey",
      providerName: "{sandboxName}-voiceclaw-nvidia-speech",
      providerEnvKey: "NVIDIA_API_KEY",
      placeholder: "openshell:resolve:env:NVIDIA_API_KEY",
      primary: true,
    },
  ],
  policyPresets: [{ name: "voiceclaw", policyKeys: ["voiceclaw"] }],
  hostForward: {
    port: "{{voiceclaw.webhookPort}}",
    label: "VoiceClaw Twilio webhook",
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
            provider: "twilio",
            fromNumber: "{{voiceclaw.twilioFromNumber}}",
            toNumber: "{{voiceclaw.twilioToNumber}}",
            twilio: {
              accountSid: "{{voiceclaw.twilioAccountSid}}",
              authToken: "{{voiceclaw.twilioAuthToken}}",
            },
            serve: {
              bind: "0.0.0.0",
              port: "{{voiceclaw.webhookPort}}",
              path: VOICECLAW_WEBHOOK_PATH,
            },
            publicUrl: "{{voiceclaw.publicUrl}}",
            outbound: {
              defaultMode: "conversation",
            },
            tts: {
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
    {
      id: "voiceclaw-openclaw-asr",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "tools.media.audio",
        value: {
          enabled: true,
          models: [
            {
              provider: "nvidia",
              model: "nvidia/parakeet-tdt-0.6b-v2",
            },
          ],
        },
      },
    },
    {
      id: "voiceclaw-openclaw-nvidia-auth",
      kind: "json-fragment",
      agent: "openclaw",
      target: "openclaw.json",
      fragment: {
        path: "models.providers.nvidia.apiKey",
        value: "{{credential.nvidiaApiKey.placeholder}}",
      },
    },
  ],
  runtime: {
    openclaw: {
      extensionId: "voice-call",
      visibility: {
        configKeys: [],
        pluginConfigKeys: ["voice-call"],
        logPatterns: ["voice-call", "twilio"],
      },
      nodePreloads: [
        {
          module: "openclaw-nvidia-speech",
          injectInto: ["boot", "connect"],
          // The packaged preload is required. Its exact-version source hooks
          // fail open with a bounded warning if the pinned OpenClaw artifact
          // changes before this POC monkey patch is removed.
          optional: false,
          installMessage:
            "[channels] Installing VoiceClaw NVIDIA batch ASR and TTS compatibility patch",
          installedMessage:
            "[channels] VoiceClaw NVIDIA batch ASR and TTS compatibility patch installed (NODE_OPTIONS updated)",
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
        { id: "twilioAccountSid", kind: "config", required: true },
        { id: "twilioAuthToken", kind: "config", required: true },
        { id: "twilioFromNumber", kind: "config", required: true },
        { id: "twilioToNumber", kind: "config" },
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
