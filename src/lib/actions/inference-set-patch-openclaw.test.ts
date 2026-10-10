// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ConfigObject } from "../security/credential-filter";
import { patchOpenClawInferenceConfig } from "./inference-set";

function providerModels(config: ConfigObject, providerKey: string): ConfigObject[] {
  const models = config.models as ConfigObject;
  const providers = models.providers as ConfigObject;
  const provider = providers[providerKey] as ConfigObject;
  return provider.models as ConfigObject[];
}

describe("patchOpenClawInferenceConfig", () => {
  it("replaces the vLLM credential when switching to native NVIDIA inference", () => {
    const config: ConfigObject = {
      models: { providers: { inference: { apiKey: "unused", models: [] } } },
    };
    patchOpenClawInferenceConfig(config, "nvidia-prod", "nvidia/test-model");
    expect(config).toMatchObject({
      models: {
        providers: {
          inference: {
            baseUrl: "https://integrate.api.nvidia.com/v1",
            apiKey: "${NVIDIA_INFERENCE_API_KEY}",
          },
        },
      },
    });
    patchOpenClawInferenceConfig(config, "vllm-local", "local-model");
    expect(config).toMatchObject({
      models: {
        providers: { inference: { baseUrl: "https://inference.local/v1", apiKey: "unused" } },
      },
    });
  });

  it.each([undefined, null, 16384])(
    "updates only the selected model's context when the resolved window is %s",
    (contextWindow) => {
      const otherModel = { id: "other", contextWindow: 65536, maxTokens: 4096 };
      const config: ConfigObject = {
        agents: { defaults: { model: { primary: "inference/selected" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [otherModel, { id: "selected", contextWindow: 131072 }],
            },
          },
        },
      };

      patchOpenClawInferenceConfig(config, "compatible-endpoint", "selected", null, contextWindow);

      const models = providerModels(config, "inference");
      expect(models).toHaveLength(2);
      expect(models[0]).toEqual({ id: "other", contextWindow: 65536, maxTokens: 4096 });
      expect(models[1].id).toBe("selected");
      expect(Object.hasOwn(models[1], "contextWindow")).toBe(contextWindow !== null);
      expect(models[1].contextWindow).toBe(
        contextWindow === null ? undefined : (contextWindow ?? 131072),
      );
    },
  );

  it("writes provider-qualified model refs without inheriting another model's limits (#12033)", () => {
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
          baseUrl: "https://integrate.api.nvidia.com/v1",
          apiKey: "${NVIDIA_INFERENCE_API_KEY}",
          api: "openai-completions",
          models: [
            {
              id: "nvidia/nemotron-3-super-120b-a12b",
              name: "inference/nvidia/nemotron-3-super-120b-a12b",
              reasoning: true,
              compat: { supportsStore: false },
            },
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
    });
  });

  it("updates the explicit main agents.entries model without changing secondary defaults", () => {
    const config: ConfigObject = {
      agents: {
        defaults: { model: { primary: "inference/nvidia/old-model" } },
        entries: {
          main: { default: true, model: "inference/nvidia/old-model" },
          research: {
            default: true,
            model: "inference/nvidia/secondary-model",
            workspace: "/sandbox/.openclaw/workspace-research",
            agentDir: "/sandbox/.openclaw/agents/research",
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "unused",
            api: "openai-completions",
            models: [
              { id: "old-model", name: "inference/nvidia/old-model" },
              { id: "secondary-model", name: "inference/nvidia/secondary-model" },
            ],
          },
        },
      },
    };

    patchOpenClawInferenceConfig(config, "nvidia-prod", "nvidia/new-model");

    expect(config.agents).toEqual({
      defaults: { model: { primary: "inference/nvidia/new-model" } },
      entries: {
        main: { default: true, model: "inference/nvidia/new-model" },
        research: {
          default: true,
          model: "inference/nvidia/secondary-model",
          workspace: "/sandbox/.openclaw/workspace-research",
          agentDir: "/sandbox/.openclaw/agents/research",
        },
      },
    });
    expect((config.models as ConfigObject).providers).toEqual({
      inference: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "${NVIDIA_INFERENCE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "nvidia/new-model",
            name: "inference/nvidia/new-model",
            compat: { supportsStore: false },
          },
          { id: "old-model", name: "inference/nvidia/old-model" },
          { id: "secondary-model", name: "inference/nvidia/secondary-model" },
        ],
      },
    });
  });

  it("falls back to the default agents.list model when no main entry exists", () => {
    const config: ConfigObject = {
      agents: {
        defaults: { model: { primary: "inference/nvidia/old-model" } },
        list: [
          { id: "research", model: "inference/nvidia/secondary-model" },
          { id: "primary", default: true, model: "inference/nvidia/old-model" },
        ],
      },
      models: {
        mode: "merge",
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "unused",
            api: "openai-completions",
            models: [{ id: "old-model", name: "inference/nvidia/old-model" }],
          },
        },
      },
    };

    patchOpenClawInferenceConfig(config, "nvidia-prod", "nvidia/new-model");

    expect(config.agents).toEqual({
      defaults: { model: { primary: "inference/nvidia/new-model" } },
      list: [
        { id: "research", model: "inference/nvidia/secondary-model" },
        { id: "primary", default: true, model: "inference/nvidia/new-model" },
      ],
    });
  });

  it("is a no-op when OpenClaw already matches the requested route", () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: {
        mode: "merge",
        providers: {
          inference: {
            baseUrl: "https://integrate.api.nvidia.com/v1",
            apiKey: "${NVIDIA_INFERENCE_API_KEY}",
            api: "openai-completions",
            models: [
              {
                id: "nvidia/model-a",
                name: "inference/nvidia/model-a",
                compat: { supportsStore: false },
              },
            ],
          },
        },
      },
    };

    const result = patchOpenClawInferenceConfig(config, "nvidia-prod", "nvidia/model-a");

    expect(result.changed).toBe(false);
  });

  it("preserves limits for the selected model regardless of its array position (#12033)", () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/old-model" } } },
      models: {
        mode: "merge",
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "unused",
            api: "openai-completions",
            models: [
              { id: "nvidia/old-model", name: "inference/nvidia/old-model" },
              {
                id: "nvidia/model-a",
                name: "inference/nvidia/model-a",
                contextWindow: 65536,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    };

    patchOpenClawInferenceConfig(config, "nvidia-prod", "nvidia/model-a");

    expect(providerModels(config, "inference")[1]).toMatchObject({
      id: "nvidia/model-a",
      contextWindow: 65536,
      maxTokens: 4096,
    });
  });

  it("records a provider switch in a request marker without replacing other headers", () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/old-model" } } },
      models: {
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "unused",
            api: "openai-completions",
            headers: {
              "X-Existing": "keep",
              "x-nemoclaw-upstream-provider": "nvidia-prod",
            },
            models: [{ id: "nvidia/old-model", name: "inference/nvidia/old-model" }],
          },
        },
      },
    };

    patchOpenClawInferenceConfig(
      config,
      "compatible-endpoint",
      "nvidia/nemotron-3-super-120b-a12b",
      "openai-completions",
      undefined,
      "compatible-endpoint",
    );

    const models = config.models as ConfigObject;
    const providers = models.providers as ConfigObject;
    const inference = providers.inference as ConfigObject;
    expect(inference.headers).toEqual({
      "X-Existing": "keep",
      "X-NemoClaw-Upstream-Provider": "compatible-endpoint",
    });
  });

  it("seeds new Anthropic routes with the required default reply budget", () => {
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
          models: [
            {
              id: "claude-sonnet-4-6",
              name: "anthropic/claude-sonnet-4-6",
              maxTokens: 4096,
            },
          ],
        },
      },
    });
  });

  it("inherits the active reply budget when creating an Anthropic provider", () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/model-a" } } },
      models: {
        providers: {
          inference: {
            models: [
              { id: "extra-model", name: "inference/extra-model", maxTokens: 16384 },
              { id: "model-a", name: "inference/model-a", maxTokens: 8192 },
            ],
          },
        },
      },
    };

    patchOpenClawInferenceConfig(config, "anthropic-prod", "claude-sonnet-4-6");

    expect(providerModels(config, "anthropic")).toEqual([
      {
        id: "claude-sonnet-4-6",
        name: "anthropic/claude-sonnet-4-6",
        maxTokens: 8192,
      },
    ]);
  });

  it("does not inherit a custom image's baked reply budget during initial routing (#12033)", () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/baked-model" } } },
      models: {
        providers: {
          inference: {
            models: [
              {
                id: "baked-model",
                name: "inference/baked-model",
                maxTokens: 128,
              },
            ],
          },
        },
      },
    };

    patchOpenClawInferenceConfig(
      config,
      "anthropic-prod",
      "claude-sonnet-4-6",
      null,
      undefined,
      "anthropic-prod",
      { effort: null, explicit: false },
      false,
    );

    expect(providerModels(config, "anthropic")).toEqual([
      {
        id: "claude-sonnet-4-6",
        name: "anthropic/claude-sonnet-4-6",
        maxTokens: 4096,
      },
    ]);
  });

  it("does not inherit another Anthropic model's reply budget", () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/model-a" } } },
      models: {
        providers: {
          inference: {
            models: [{ id: "model-a", name: "inference/model-a", maxTokens: 8192 }],
          },
          anthropic: {
            models: [{ id: "old-model", name: "anthropic/old-model", maxTokens: 2048 }],
          },
        },
      },
    };

    patchOpenClawInferenceConfig(config, "anthropic-prod", "claude-sonnet-4-6");

    expect(providerModels(config, "anthropic")).toEqual([
      {
        id: "claude-sonnet-4-6",
        name: "anthropic/claude-sonnet-4-6",
        maxTokens: 8192,
      },
      { id: "old-model", name: "anthropic/old-model", maxTokens: 2048 },
    ]);
  });

  it("defaults invalid active and target Anthropic reply budgets", () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/model-a" } } },
      models: {
        providers: {
          inference: {
            models: [{ id: "model-a", name: "inference/model-a", maxTokens: 1e308 }],
          },
          anthropic: {
            models: [{ id: "old-model", name: "anthropic/old-model", maxTokens: 1.5 }],
          },
        },
      },
    };

    patchOpenClawInferenceConfig(config, "anthropic-prod", "claude-sonnet-4-6");

    expect(providerModels(config, "anthropic")[0]?.maxTokens).toBe(4096);
  });
});
