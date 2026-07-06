// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ConfigObject } from "../security/credential-filter";
import { patchOpenClawInferenceConfig } from "./inference-set";

describe("patchOpenClawInferenceConfig", () => {
  it("writes provider-qualified model refs while preserving model metadata", () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/moonshotai/kimi-k2.6" } } },
      models: {
        mode: "merge",
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "unused",
            api: "openai-completions",
            models: [
              {
                id: "moonshotai/kimi-k2.6",
                name: "inference/moonshotai/kimi-k2.6",
                contextWindow: 131072,
                maxTokens: 8192,
                reasoning: true,
                compat: { supportsStore: false },
              },
            ],
          },
        },
      },
    };

    const result = patchOpenClawInferenceConfig(
      config,
      "nvidia-prod",
      "nvidia/nemotron-3-super-120b-a12b",
    );

    expect(result.changed).toBe(true);
    expect(config.agents).toEqual({
      defaults: { model: { primary: "inference/nvidia/nemotron-3-super-120b-a12b" } },
    });
    expect(config.models).toEqual({
      mode: "merge",
      providers: {
        inference: {
          baseUrl: "https://inference.local/v1",
          apiKey: "unused",
          api: "openai-completions",
          models: [
            {
              id: "nvidia/nemotron-3-super-120b-a12b",
              name: "inference/nvidia/nemotron-3-super-120b-a12b",
              contextWindow: 131072,
              maxTokens: 8192,
              reasoning: true,
            },
          ],
        },
      },
    });
  });

  it("is a no-op when OpenClaw already matches the requested route", () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: {
        mode: "merge",
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "unused",
            api: "openai-completions",
            models: [{ id: "nvidia/model-a", name: "inference/nvidia/model-a" }],
          },
        },
      },
    };

    const result = patchOpenClawInferenceConfig(config, "nvidia-prod", "nvidia/model-a");

    expect(result.changed).toBe(false);
  });

  it("switches Anthropic routes to the Anthropic provider namespace", () => {
    const config: ConfigObject = { agents: {}, models: { providers: {} } };

    patchOpenClawInferenceConfig(config, "anthropic-prod", "claude-sonnet-4-6");

    expect(config.agents).toEqual({
      defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
    });
    expect(config.models).toEqual({
      mode: "merge",
      providers: {
        anthropic: {
          baseUrl: "https://inference.local",
          apiKey: "unused",
          api: "anthropic-messages",
          models: [{ id: "claude-sonnet-4-6", name: "anthropic/claude-sonnet-4-6" }],
        },
      },
    });
  });
});
