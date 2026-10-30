// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

import {
  createHermesSwitchyardRoutingIntent,
  decodeHermesSwitchyardRoutingIntent,
  encodeHermesSwitchyardRoutingIntent,
  HERMES_SWITCHYARD_DEPLOYMENT_FILE,
  HERMES_SWITCHYARD_PROVIDERS,
  serializeHermesSwitchyardRouting,
  validateHermesSwitchyardRoutingIntent,
} from "./hermes-switchyard-routing";

function routing() {
  return createHermesSwitchyardRoutingIntent({
    efficient: { provider: "nvidia-prod", model: "nvidia/nemotron-nano" },
    capable: { provider: "openai-api", model: "gpt-5.2" },
  });
}

describe("Hermes Switchyard routing", () => {
  it("records capable-target judge reuse in a canonical bounded transport (#13862)", () => {
    const intent = routing();
    expect(intent).toEqual({
      schemaVersion: 1,
      routeId: "switchyard",
      efficient: { provider: "nvidia-prod", model: "nvidia/nemotron-nano" },
      capable: { provider: "openai-api", model: "gpt-5.2" },
      judge: { mode: "reuse-capable", target: "capable" },
    });
    expect(
      decodeHermesSwitchyardRoutingIntent(encodeHermesSwitchyardRoutingIntent(intent)),
    ).toEqual(intent);
  });

  it("serializes the released adaptive Relay and Switchyard contracts (#13862)", () => {
    const serialized = serializeHermesSwitchyardRouting(routing());
    const relay = parseToml(serialized.relayPluginsToml) as Record<string, unknown>;
    const relayState = JSON.parse(serialized.relayPluginStateJson) as Record<string, unknown>;
    const deployment = parseToml(serialized.switchyardDeploymentToml) as Record<string, unknown>;

    expect(relay).toMatchObject({
      version: 1,
      plugins: {
        dynamic: [
          {
            manifest: "/opt/nemo-relay/plugins/switchyard/relay-plugin.toml",
            config: {
              priority: 0,
              switchyard_config_path: HERMES_SWITCHYARD_DEPLOYMENT_FILE,
            },
          },
        ],
        policy: { overrides: { "nvidia.switchyard": { attestation: "integrity_only" } } },
      },
    });
    expect(deployment).toMatchObject({
      schema_version: 1,
      llm_clients: {
        efficient: {
          format: "openai_chat",
          base_url: "https://integrate.api.nvidia.com/v1",
          api_key_env: "NVIDIA_INFERENCE_API_KEY",
          forward_auth: false,
        },
        capable: {
          format: "openai_chat",
          base_url: "https://api.openai.com/v1",
          api_key_env: "OPENAI_API_KEY",
          forward_auth: false,
        },
      },
      targets: {
        efficient: { id: "nvidia/nemotron-nano", llm_client: "efficient" },
        capable: { id: "gpt-5.2", llm_client: "capable" },
      },
      routes: {
        switchyard: {
          id: "switchyard",
          type: "llm_classifier",
          mode: "capability",
          classifier_target: "capable",
          strong_target: "capable",
          weak_target: "efficient",
          base_threshold: 0.5,
          classify_trigger: "new_session",
          message_hash_fallback: true,
        },
      },
    });
    expect(relayState).toMatchObject({
      schema_version: 1,
      records: [
        {
          metadata: { id: "nvidia.switchyard", kind: "rust_dynamic", generation: 1 },
          source: { manifest_ref: "/opt/nemo-relay/plugins/switchyard/relay-plugin.toml" },
          spec: { present: true, enabled: true },
          compatibility: {
            rust_dynamic: { relay: ">=0.8.0, <1.0.0", native_api: "1" },
          },
          load: {
            rust_dynamic: {
              library: "libswitchyard_nemo_relay_plugin.so",
              symbol: "nemo_relay_register_plugin",
            },
          },
        },
      ],
    });
    expect(serialized.switchyardDeploymentToml).not.toContain("weighted");
    expect(serialized.switchyardDeploymentToml).not.toContain("sk-test-secret");
  });

  it("derives supported selections and headers from fixed hosted provider profiles (#13862)", () => {
    expect(HERMES_SWITCHYARD_PROVIDERS).toEqual([
      "nvidia-prod",
      "openai-api",
      "anthropic-prod",
      "gemini-api",
      "openrouter-api",
    ]);
    const serialized = serializeHermesSwitchyardRouting(
      createHermesSwitchyardRoutingIntent({
        efficient: { provider: "openrouter-api", model: "openai/gpt-oss-20b" },
        capable: { provider: "anthropic-prod", model: "claude-sonnet-4-5" },
      }),
    );
    const deployment = parseToml(serialized.switchyardDeploymentToml) as Record<string, unknown>;

    expect(deployment).toMatchObject({
      llm_clients: {
        efficient: {
          base_url: "https://openrouter.ai/api/v1",
          api_key_env: "OPENROUTER_API_KEY",
          forward_auth: false,
          extra_headers: {
            "HTTP-Referer": "https://www.nvidia.com/nemoclaw/",
            "X-OpenRouter-Title": "NVIDIA NemoClaw",
          },
        },
        capable: {
          format: "anthropic_messages",
          base_url: "https://api.anthropic.com",
          api_key_env: "ANTHROPIC_API_KEY",
          forward_auth: false,
        },
      },
    });
  });

  it.each([
    [
      "unknown provider",
      { provider: "custom", model: "model-a" },
      { provider: "openai-api", model: "model-b" },
    ],
    [
      "endpoint-shaped model",
      { provider: "nvidia-prod", model: "https://example.test/model" },
      { provider: "openai-api", model: "model-b" },
    ],
    [
      "credential-shaped model",
      { provider: "nvidia-prod", model: "nvapi-secret-value" },
      { provider: "openai-api", model: "model-b" },
    ],
    [
      "embedded credential-shaped model",
      { provider: "nvidia-prod", model: "models/sk-proj-secret-value" },
      { provider: "openai-api", model: "model-b" },
    ],
    [
      "duplicate roles",
      { provider: "openai-api", model: "gpt-5.2" },
      { provider: "openai-api", model: "gpt-5.2" },
    ],
    [
      "duplicate model IDs across providers",
      { provider: "nvidia-prod", model: "shared-model" },
      { provider: "openai-api", model: "shared-model" },
    ],
  ])("rejects %s (#13862)", (_name, efficient, capable) => {
    expect(() => createHermesSwitchyardRoutingIntent({ efficient, capable })).toThrow(
      "Invalid Hermes Switchyard routing",
    );
  });

  it("rejects an unknown route or changed judge role (#13862)", () => {
    expect(() =>
      validateHermesSwitchyardRoutingIntent({
        ...routing(),
        routeId: "unmatched",
      }),
    ).toThrow("routeId must be switchyard");
    expect(() =>
      validateHermesSwitchyardRoutingIntent({
        ...routing(),
        judge: { mode: "dedicated", target: "judge" },
      }),
    ).toThrow("judge must explicitly reuse the capable target");
  });
});
