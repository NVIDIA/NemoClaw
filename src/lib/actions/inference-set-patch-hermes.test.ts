// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { HERMES_PROXY_API_KEY_PLACEHOLDER } from "../hermes-proxy-api-key";
import type { ConfigObject } from "../security/credential-filter";
import { patchHermesInferenceConfig } from "./inference-set";

describe("patchHermesInferenceConfig", () => {
  it("updates only the Hermes model block for the selected route", () => {
    const config: ConfigObject = {
      model: {
        default: "moonshotai/kimi-k2.6",
        provider: "custom",
        base_url: "https://old.example/v1",
        temperature: 0.2,
      },
      models: {
        providers: {
          inference: {
            baseUrl: "https://should-not-change.example/v1",
          },
        },
      },
      terminal: { backend: "local" },
    };

    const result = patchHermesInferenceConfig(config, "hermes-provider", "openai/gpt-5.4-mini");

    expect(result.changed).toBe(true);
    expect(config.model).toEqual({
      default: "openai/gpt-5.4-mini",
      provider: "custom",
      base_url: "https://inference.local/v1",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
      temperature: 0.2,
    });
    expect(config.models).toEqual({
      providers: {
        inference: {
          baseUrl: "https://should-not-change.example/v1",
        },
      },
    });
    expect(config.terminal).toEqual({ backend: "local" });
  });

  it("replaces stale Hermes API keys with the OpenShell proxy placeholder", () => {
    for (const api_key of ["no-key-required", "sk-real-looking-key-that-must-not-survive"]) {
      const config: ConfigObject = {
        model: {
          default: "old-model",
          provider: "custom",
          base_url: "https://old.example/v1",
          api_key,
        },
      };

      patchHermesInferenceConfig(config, "hermes-provider", "openai/gpt-5.4-mini");

      expect((config.model as ConfigObject).api_key).toBe(HERMES_PROXY_API_KEY_PLACEHOLDER);
    }
  });

  it("sets Hermes Anthropic Messages mode for Anthropic routes", () => {
    const config: ConfigObject = {
      model: {
        default: "openai/gpt-5.4-mini",
        provider: "custom",
        base_url: "https://inference.local/v1",
      },
    };

    const result = patchHermesInferenceConfig(config, "anthropic-prod", "claude-sonnet-4-6");

    expect(result.route).toMatchObject({
      providerKey: "anthropic",
      primaryModelRef: "anthropic/claude-sonnet-4-6",
      inferenceBaseUrl: "https://inference.local",
      inferenceApi: "anthropic-messages",
    });
    expect(config.model).toEqual({
      default: "claude-sonnet-4-6",
      provider: "custom",
      base_url: "https://inference.local",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
      api_mode: "anthropic_messages",
    });
  });

  it("clears stale Hermes API mode when switching back to OpenAI-style routes", () => {
    const config: ConfigObject = {
      model: {
        default: "claude-sonnet-4-6",
        provider: "custom",
        base_url: "https://inference.local",
        api_mode: "anthropic_messages",
      },
    };

    patchHermesInferenceConfig(config, "nvidia-prod", "nvidia/nemotron-3-super-120b-a12b");

    expect(config.model).toEqual({
      default: "nvidia/nemotron-3-super-120b-a12b",
      provider: "custom",
      base_url: "https://inference.local/v1",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
    });
  });

  it("keeps Bedrock Runtime adapter routes OpenAI-compatible for Hermes", () => {
    const config: ConfigObject = { model: {} };

    const result = patchHermesInferenceConfig(
      config,
      "compatible-anthropic-endpoint",
      "anthropic.claude-3-5-sonnet-20240620-v1:0",
      "openai-completions",
    );

    expect(result.route).toMatchObject({
      providerKey: "inference",
      primaryModelRef: "inference/anthropic.claude-3-5-sonnet-20240620-v1:0",
      inferenceBaseUrl: "https://inference.local/v1",
      inferenceApi: "openai-completions",
    });
    expect(config.model).toEqual({
      default: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      provider: "custom",
      base_url: "https://inference.local/v1",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
    });
  });
});
