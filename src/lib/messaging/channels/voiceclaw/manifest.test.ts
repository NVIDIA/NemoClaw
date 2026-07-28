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
import { voiceclawManifest } from "./manifest";

const VALID_ENV = {
  TELNYX_API_KEY: "KEY-test-telnyx-key-must-not-be-rendered",
  VOICECLAW_TELNYX_CONNECTION_ID: "1234567890123456789",
  VOICECLAW_TELNYX_PUBLIC_KEY: `${"A".repeat(43)}=`,
  NVIDIA_API_KEY: "nvapi-test-key-must-not-be-rendered",
  VOICECLAW_TELNYX_FROM_NUMBER: "+15550001234",
  VOICECLAW_TELNYX_TO_NUMBER: "+15550005678",
  VOICECLAW_PUBLIC_URL: "https://voice.example.test/voice/webhook",
  VOICECLAW_WEBHOOK_PORT: "3334",
};

function compiler() {
  return new ManifestCompiler(
    createBuiltInChannelManifestRegistry(),
    createBuiltInMessagingHookRegistry(),
    createBuiltInRenderTemplateResolver(),
  );
}

async function compileVoiceClaw() {
  for (const [key, value] of Object.entries(VALID_ENV)) vi.stubEnv(key, value);
  return compiler().compile({
    sandboxName: "voice-agent",
    agent: "openclaw",
    workflow: "onboard",
    isInteractive: false,
    configuredChannels: ["voiceclaw"],
    credentialAvailability: {
      TELNYX_API_KEY: true,
      NVIDIA_API_KEY: true,
    },
  });
}

describe("VoiceClaw channel manifest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("compiles a Telnyx OpenClaw voice-call plan with speech-to-text and NVIDIA TTS (#6387)", async () => {
    const plan = await compileVoiceClaw();
    const configPrompt = voiceclawManifest.hooks.find(
      (hook) => hook.id === "voiceclaw-config-prompt",
    );

    expect(plan.channels[0]).toMatchObject({
      channelId: "voiceclaw",
      active: true,
      configured: true,
      authMode: "token-paste",
      hostForward: {
        channelId: "voiceclaw",
        port: 3334,
        label: "VoiceClaw Telnyx webhook",
      },
    });
    expect(configPrompt?.outputs).toContainEqual({
      id: "telnyxToNumber",
      kind: "config",
      required: true,
    });
    expect(plan.credentialBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channelId: "voiceclaw",
          credentialId: "telnyxApiKey",
          providerEnvKey: "TELNYX_API_KEY",
          placeholder: "openshell:resolve:env:TELNYX_API_KEY",
        }),
        expect.objectContaining({
          channelId: "voiceclaw",
          credentialId: "nvidiaApiKey",
          providerEnvKey: "NVIDIA_API_KEY",
          placeholder: "openshell:resolve:env:NVIDIA_API_KEY",
        }),
      ]),
    );
    expect(plan.networkPolicy.entries).toEqual([
      {
        channelId: "voiceclaw",
        presetName: "voiceclaw",
        policyKeys: ["voiceclaw"],
        source: "manifest",
      },
    ]);
    expect(plan.agentRender).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          renderId: "voiceclaw-openclaw-plugin",
          path: "plugins.entries.voice-call",
          value: expect.objectContaining({
            enabled: true,
            config: expect.objectContaining({
              provider: "telnyx",
              fromNumber: "+15550001234",
              toNumber: "+15550005678",
              inboundPolicy: "allowlist",
              allowFrom: ["+15550005678"],
              ringTimeoutMs: 120_000,
              responseModel: "inference/nvidia/nemotron-3-super-120b-a12b",
              publicUrl: "https://voice.example.test/voice/webhook",
              serve: { bind: "0.0.0.0", port: 3334, path: "/voice/webhook" },
              telnyx: {
                apiKey: "openshell:resolve:env:TELNYX_API_KEY",
                connectionId: "1234567890123456789",
                publicKey: `${"A".repeat(43)}=`,
              },
              tts: expect.objectContaining({
                provider: "nvidia",
                timeoutMs: 120_000,
                providers: {
                  nvidia: expect.objectContaining({
                    apiKey: "openshell:resolve:env:NVIDIA_API_KEY",
                  }),
                },
              }),
            }),
          }),
        }),
        expect.objectContaining({
          renderId: "voiceclaw-openclaw-tts",
          path: "messages.tts",
          value: expect.objectContaining({
            provider: "nvidia",
            providers: {
              nvidia: expect.objectContaining({
                apiKey: "openshell:resolve:env:NVIDIA_API_KEY",
              }),
            },
          }),
        }),
      ]),
    );
    expect(plan.agentRender).toHaveLength(2);
    expect(plan.buildSteps).toEqual([
      {
        channelId: "voiceclaw",
        kind: "package-install",
        outputId: "openclawVoiceCallPlugin",
        required: true,
        value: {
          manager: "openclaw-plugin",
          spec: "npm:@openclaw/voice-call@{{openclaw.version}}",
          pin: true,
        },
      },
    ]);
    expect(plan.runtimeSetup?.nodePreloads).toContainEqual({
      channelId: "voiceclaw",
      module: "openclaw-nvidia-speech",
      source: "/usr/local/lib/nemoclaw/preloads/openclaw-nvidia-speech.js",
      target: "/tmp/nemoclaw-openclaw-nvidia-speech.js",
      injectInto: ["boot", "connect"],
      optional: false,
      installMessage: "[channels] Installing VoiceClaw NVIDIA TTS compatibility patch",
      installedMessage:
        "[channels] VoiceClaw NVIDIA TTS compatibility patch installed (NODE_OPTIONS updated)",
    });
    expect(plan.runtimeSetup?.nodePreloads).toContainEqual({
      channelId: "voiceclaw",
      module: "openclaw-voicecall-telnyx-tts",
      source: "/usr/local/lib/nemoclaw/preloads/openclaw-voicecall-telnyx-tts.js",
      target: "/tmp/nemoclaw-openclaw-voicecall-telnyx-tts.js",
      injectInto: ["boot", "connect"],
      optional: false,
      installMessage: "[channels] Installing VoiceClaw Telnyx NVIDIA TTS compatibility patch",
      installedMessage:
        "[channels] VoiceClaw Telnyx NVIDIA TTS compatibility patch installed (NODE_OPTIONS updated)",
    });
    expect(plan.stateUpdates[0]).toMatchObject({
      channelId: "voiceclaw",
      kind: "persist-inputs",
      inputIds: [
        "enabled",
        "telnyxConnectionId",
        "telnyxPublicKey",
        "telnyxFromNumber",
        "telnyxToNumber",
        "publicUrl",
        "webhookPort",
      ],
    });
    expect(JSON.stringify(plan)).not.toContain(VALID_ENV.TELNYX_API_KEY);
    expect(JSON.stringify(plan)).not.toContain(VALID_ENV.NVIDIA_API_KEY);
    expect(JSON.stringify(plan)).toContain("openshell:resolve:env:TELNYX_API_KEY");
    expect(JSON.stringify(plan)).toContain("openshell:resolve:env:NVIDIA_API_KEY");
  });

  it("pins the voice-call artifact to the OpenClaw version used by the image (#6387)", () => {
    expect(voiceclawManifest.agentPackages).toEqual([
      expect.objectContaining({
        spec: "npm:@openclaw/voice-call@{{openclaw.version}}",
        integrityByVersion: {
          "2026.7.1":
            "sha512-d/gYtMZSScp75fYi7DNVslh4X+P/VaVBmOQpGIt3Y7NShHHOrMhC3oUq4N0ie50Ee/IFFWJ1BkvYNJsr0z+Nzg==",
        },
        tarballUrlByVersion: {
          "2026.7.1": "https://registry.npmjs.org/@openclaw/voice-call/-/voice-call-2026.7.1.tgz",
        },
      }),
    ]);
  });

  it("uses REST-only Telnyx and NVIDIA TTS policy routes (#6387)", () => {
    const content = loadMessagingChannelPolicyPreset("voiceclaw", { agent: "openclaw" });
    expect(content).not.toBeNull();
    const parsed = YAML.parse(content!) as {
      network_policies: {
        voiceclaw: {
          endpoints: Array<{
            host: string;
            protocol: string;
            rules: Array<{ allow: { method: string; path: string } }>;
          }>;
        };
      };
    };
    const endpoints = parsed.network_policies.voiceclaw.endpoints;

    expect(endpoints).toHaveLength(2);
    expect(endpoints.every((endpoint) => endpoint.protocol === "rest")).toBe(true);
    expect(endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: "api.telnyx.com",
          rules: expect.arrayContaining([
            { allow: { method: "POST", path: "/v2/calls" } },
            { allow: { method: "POST", path: "/v2/calls/*/actions/playback_start" } },
            { allow: { method: "POST", path: "/v2/calls/*/actions/transcription_start" } },
          ]),
        }),
        expect.objectContaining({
          host: "877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com",
          rules: [{ allow: { method: "POST", path: "/v1/audio/synthesize" } }],
        }),
      ]),
    );
    expect(content).not.toMatch(/twilio|transcriptions|grpc|http2/iu);
  });

  it.each([
    ["VOICECLAW_TELNYX_CONNECTION_ID", "not-a-connection-id"],
    ["VOICECLAW_TELNYX_FROM_NUMBER", "5550001234"],
    ["VOICECLAW_PUBLIC_URL", "http://voice.example.test/voice/webhook"],
    ["VOICECLAW_PUBLIC_URL", "https://voice.example.test/wrong-path"],
  ])("does not activate with invalid %s (#6387)", async (key, value) => {
    for (const [envKey, envValue] of Object.entries(VALID_ENV)) vi.stubEnv(envKey, envValue);
    vi.stubEnv(key, value);
    const plan = await compiler().compile({
      sandboxName: "voice-agent",
      agent: "openclaw",
      workflow: "onboard",
      isInteractive: false,
      configuredChannels: ["voiceclaw"],
      credentialAvailability: { TELNYX_API_KEY: true, NVIDIA_API_KEY: true },
    });

    expect(plan.channels[0]?.active).toBe(false);
    expect(plan.agentRender).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(value);
  });
});
