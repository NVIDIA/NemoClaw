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

const TEST_TWILIO_ACCOUNT_SID = `AC${"0123456789abcdef".repeat(2)}`;

const VALID_ENV = {
  VOICECLAW_ENABLED: "1",
  VOICECLAW_TWILIO_ACCOUNT_SID: TEST_TWILIO_ACCOUNT_SID,
  VOICECLAW_TWILIO_AUTH_TOKEN: "test-token-rendered-for-poc",
  NVIDIA_API_KEY: "nvapi-test-key-must-not-be-rendered",
  VOICECLAW_TWILIO_FROM_NUMBER: "+15550001234",
  VOICECLAW_TWILIO_TO_NUMBER: "+15550005678",
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
      NVIDIA_API_KEY: true,
    },
  });
}

describe("VoiceClaw channel manifest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("compiles a Twilio-first OpenClaw voice-call plan with NVIDIA speech (#6387)", async () => {
    const plan = await compileVoiceClaw();

    expect(plan.channels[0]).toMatchObject({
      channelId: "voiceclaw",
      active: true,
      configured: true,
      authMode: "token-paste",
      hostForward: {
        channelId: "voiceclaw",
        port: 3334,
        label: "VoiceClaw Twilio webhook",
      },
    });
    expect(plan.credentialBindings).toEqual(
      expect.arrayContaining([
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
              provider: "twilio",
              fromNumber: "+15550001234",
              toNumber: "+15550005678",
              publicUrl: "https://voice.example.test/voice/webhook",
              serve: { bind: "0.0.0.0", port: 3334, path: "/voice/webhook" },
              twilio: {
                accountSid: TEST_TWILIO_ACCOUNT_SID,
                authToken: "test-token-rendered-for-poc",
              },
              tts: expect.objectContaining({
                provider: "nvidia",
                timeoutMs: 30_000,
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
        expect.objectContaining({
          renderId: "voiceclaw-openclaw-asr",
          path: "tools.media.audio",
          value: expect.objectContaining({
            models: [
              {
                provider: "nvidia",
                model: "nvidia/parakeet-tdt-0.6b-v2",
              },
            ],
          }),
        }),
        expect.objectContaining({
          renderId: "voiceclaw-openclaw-nvidia-auth",
          path: "models.providers.nvidia.apiKey",
          value: "openshell:resolve:env:NVIDIA_API_KEY",
        }),
      ]),
    );
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
      installMessage:
        "[channels] Installing VoiceClaw NVIDIA batch ASR and TTS compatibility patch",
      installedMessage:
        "[channels] VoiceClaw NVIDIA batch ASR and TTS compatibility patch installed (NODE_OPTIONS updated)",
    });
    expect(plan.runtimeSetup?.nodePreloads).toContainEqual({
      channelId: "voiceclaw",
      module: "openclaw-voicecall-gather-tts",
      source: "/usr/local/lib/nemoclaw/preloads/openclaw-voicecall-gather-tts.js",
      target: "/tmp/nemoclaw-openclaw-voicecall-gather-tts.js",
      injectInto: ["boot", "connect"],
      optional: false,
      installMessage:
        "[channels] Installing VoiceClaw Twilio Gather NVIDIA TTS compatibility patch",
      installedMessage:
        "[channels] VoiceClaw Twilio Gather NVIDIA TTS compatibility patch installed (NODE_OPTIONS updated)",
    });
    expect(plan.stateUpdates[0]).toMatchObject({
      channelId: "voiceclaw",
      kind: "persist-inputs",
      inputIds: [
        "enabled",
        "twilioAccountSid",
        "twilioAuthToken",
        "twilioFromNumber",
        "twilioToNumber",
        "publicUrl",
        "webhookPort",
      ],
    });
    expect(JSON.stringify(plan)).toContain(VALID_ENV.VOICECLAW_TWILIO_AUTH_TOKEN);
    expect(JSON.stringify(plan)).not.toContain("openshell:resolve:env:VOICECLAW_TWILIO_AUTH_TOKEN");
    expect(JSON.stringify(plan)).not.toContain(VALID_ENV.NVIDIA_API_KEY);
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

  it("uses REST-only Twilio and NVIDIA batch speech policy routes (#6387)", () => {
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

    expect(endpoints).toHaveLength(4);
    expect(endpoints.every((endpoint) => endpoint.protocol === "rest")).toBe(true);
    expect(endpoints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: "api.twilio.com",
          rules: [
            { allow: { method: "POST", path: "/2010-04-01/Accounts/*/Calls.json" } },
            { allow: { method: "POST", path: "/2010-04-01/Accounts/*/Calls/*" } },
          ],
        }),
        expect.objectContaining({
          host: "877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com",
          rules: [{ allow: { method: "POST", path: "/v1/audio/synthesize" } }],
        }),
      ]),
    );
    expect(content).not.toMatch(/grpc|http2/iu);
  });

  it.each([
    ["VOICECLAW_TWILIO_ACCOUNT_SID", "not-a-sid"],
    ["VOICECLAW_TWILIO_FROM_NUMBER", "5550001234"],
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
      credentialAvailability: { NVIDIA_API_KEY: true },
    });

    expect(plan.channels[0]?.active).toBe(false);
    expect(plan.agentRender).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(value);
  });
});
