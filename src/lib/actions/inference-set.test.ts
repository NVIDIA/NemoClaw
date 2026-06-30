// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { HERMES_PROXY_API_KEY_PLACEHOLDER } from "../hermes-proxy-api-key";
import type { ConfigObject } from "../security/credential-filter";

vi.mock("../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
}));

vi.mock("../inference/local", () => ({
  DEFAULT_OLLAMA_MODEL: "llama3.1",
  validateLocalProvider: vi.fn(() => ({ ok: true })),
}));

vi.mock("../onboard/local-inference-topology", () => ({
  ensureLocalProviderReachable: vi.fn(() => true),
}));

vi.mock("../inference/context-window", () => ({
  resolveContextWindowForModel: vi.fn(() => null),
}));

vi.mock("../sandbox/config", () => ({
  readSandboxConfig: vi.fn(),
  recomputeSandboxConfigHash: vi.fn(),
  resolveAgentConfig: vi.fn(),
  writeSandboxConfig: vi.fn(),
}));

vi.mock("../shields/audit", () => ({
  appendAuditEntry: vi.fn(),
}));

import {
  InferenceSetError,
  patchHermesInferenceConfig,
  patchOpenClawInferenceConfig,
  runInferenceSet,
} from "./inference-set";
import {
  baseSession,
  createDeps,
  HERMES_TARGET,
  OPENCLAW_TARGET,
} from "./inference-set.test-support";

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

describe("runInferenceSet", () => {
  it("updates OpenShell, OpenClaw config, registry, and the matching onboard session", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/moonshotai/kimi-k2.6" } } },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [{ id: "moonshotai/kimi-k2.6", name: "inference/moonshotai/kimi-k2.6" }],
          },
        },
      },
    };
    const deps = createDeps({ config, session: baseSession() });

    const result = await runInferenceSet(
      {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
        noVerify: true,
      },
      deps,
    );

    expect(deps.calls.captureOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
        "--no-verify",
      ],
      { ignoreError: true, includeStreams: true, maxBuffer: 64 * 1024 },
    );
    expect(config.agents).toEqual({
      defaults: { model: { primary: "inference/nvidia/nemotron-3-super-120b-a12b" } },
    });
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledWith("alpha", OPENCLAW_TARGET, config);
    expect(deps.calls.recomputeSandboxConfigHash).toHaveBeenCalledWith("alpha", OPENCLAW_TARGET);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      }),
    );
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
        credentialEnv: null,
        endpointUrl: null,
        nimContainer: null,
        preferredInferenceApi: null,
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      endpointUrl: "https://inference.local/v1",
    });
    expect(deps.calls.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "inference_set",
        sandbox: "alpha",
        reason: "inference set openclaw:nvidia-prod:nvidia/nemotron-3-super-120b-a12b",
      }),
    );
    expect(result).toMatchObject({
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      primaryModelRef: "inference/nvidia/nemotron-3-super-120b-a12b",
      configChanged: true,
      sessionUpdated: true,
      inSandboxConfigSynced: true,
    });
  });

  it("updates OpenShell, Hermes config.yaml, registry, and the matching onboard session", async () => {
    const config: ConfigObject = {
      model: {
        default: "moonshotai/kimi-k2.6",
        provider: "custom",
        base_url: "https://inference.local/v1",
      },
      terminal: { backend: "local" },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "hermes",
        agent: "hermes",
        provider: "hermes-provider",
        model: "moonshotai/kimi-k2.6",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({ agent: "hermes", sandboxName: "hermes" }),
    });

    const result = await runInferenceSet(
      {
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    expect(deps.calls.captureOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "hermes-provider",
        "--model",
        "openai/gpt-5.4-mini",
        "--no-verify",
      ],
      { ignoreError: true, includeStreams: true, maxBuffer: 64 * 1024 },
    );
    expect(config).toEqual({
      _nemoclaw_upstream: {
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
      },
      model: {
        default: "openai/gpt-5.4-mini",
        provider: "custom",
        base_url: "https://inference.local/v1",
        api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
      },
      terminal: { backend: "local" },
    });
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledTimes(1);
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledWith("hermes", HERMES_TARGET, config);
    expect(deps.calls.writeSandboxConfig.mock.calls[0][1].configPath).toBe(
      "/sandbox/.hermes/config.yaml",
    );
    expect(deps.calls.recomputeSandboxConfigHash).toHaveBeenCalledWith("hermes", HERMES_TARGET);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "hermes",
      expect.objectContaining({
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
      }),
    );
    expect(deps.getSession()).toMatchObject({
      provider: "hermes-provider",
      model: "openai/gpt-5.4-mini",
      endpointUrl: "https://inference.local/v1",
      preferredInferenceApi: "openai-completions",
    });
    expect(deps.calls.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "inference_set",
        sandbox: "hermes",
        reason: "inference set hermes:hermes-provider:openai/gpt-5.4-mini",
      }),
    );
    expect(result).toMatchObject({
      sandboxName: "hermes",
      provider: "hermes-provider",
      model: "openai/gpt-5.4-mini",
      primaryModelRef: "inference/openai/gpt-5.4-mini",
      providerKey: "inference",
      configChanged: true,
      sessionUpdated: true,
    });
  });

  it("syncs OpenClaw compatible Anthropic switches to Anthropic Messages when changing provider families", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: {
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            api: "openai-completions",
            models: [{ id: "nvidia/model-a", name: "inference/nvidia/model-a" }],
          },
        },
      },
    };
    const deps = createDeps({
      config,
      session: baseSession({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
    });

    const result = await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        noVerify: true,
      },
      deps,
    );

    expect(config.agents).toEqual({
      defaults: { model: { primary: "anthropic/claude-sonnet-proxy" } },
    });
    expect(config.models).toEqual({
      mode: "merge",
      providers: {
        inference: {
          baseUrl: "https://inference.local/v1",
          api: "openai-completions",
          models: [{ id: "nvidia/model-a", name: "inference/nvidia/model-a" }],
        },
        anthropic: {
          baseUrl: "https://inference.local",
          apiKey: "unused",
          api: "anthropic-messages",
          models: [{ id: "claude-sonnet-proxy", name: "anthropic/claude-sonnet-proxy" }],
        },
      },
    });
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      preferredInferenceApi: "anthropic-messages",
    });
    expect(result).toMatchObject({
      providerKey: "anthropic",
      primaryModelRef: "anthropic/claude-sonnet-proxy",
    });
  });

  it("rejects custom-compatible provider switches without trusted endpoint metadata", async () => {
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
    });

    await expect(
      runInferenceSet(
        { provider: "compatible-endpoint", model: "openai/gpt-5.4-mini", noVerify: true },
        deps,
      ),
    ).rejects.toThrow(/without trusted durable endpoint metadata/);

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("rejects Anthropic Messages metadata for OpenAI-compatible endpoint switches", async () => {
    const deps = createDeps({
      config: { agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } } },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
    });

    await expect(
      runInferenceSet(
        {
          provider: "compatible-endpoint",
          model: "mock-openai-model",
          noVerify: true,
          endpointUrl: "https://compatible.example/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          inferenceApi: "anthropic-messages",
        },
        deps,
      ),
    ).rejects.toThrow(
      /inference-api for 'compatible-endpoint' must be one of: openai-completions, openai-responses/,
    );

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("preserves explicit inference API through the final registry and session sync", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "mock-responses-model",
        noVerify: true,
        endpointUrl: "https://compatible.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-responses",
      },
      deps,
    );

    expect(config.models).toMatchObject({
      providers: {
        inference: {
          api: "openai-responses",
          models: [{ id: "mock-responses-model", name: "inference/mock-responses-model" }],
        },
      },
    });
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-endpoint",
        model: "mock-responses-model",
        endpointUrl: "https://compatible.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-responses",
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "compatible-endpoint",
      model: "mock-responses-model",
      endpointUrl: "https://compatible.example/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-responses",
    });
  });

  it("accepts explicit compatible Anthropic endpoint metadata for provider-family switches", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/model-a" } } },
      models: { providers: { inference: { api: "openai-completions", models: [] } } },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
      session: baseSession({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      }),
    });

    await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "mock-anthropic-model",
        noVerify: true,
        endpointUrl: "http://host.openshell.internal:18767/",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        inferenceApi: "anthropic-messages",
      },
      deps,
    );

    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "compatible-anthropic-endpoint",
        model: "mock-anthropic-model",
        endpointUrl: "http://host.openshell.internal:18767",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
        nimContainer: null,
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "compatible-anthropic-endpoint",
      model: "mock-anthropic-model",
      endpointUrl: "http://host.openshell.internal:18767",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      preferredInferenceApi: "anthropic-messages",
      nimContainer: null,
    });
  });

  it("preserves same-provider Bedrock Runtime adapter routing for OpenClaw switches", async () => {
    const config: ConfigObject = {
      agents: {
        defaults: {
          model: { primary: "inference/anthropic.claude-3-5-sonnet-20240620-v1:0" },
        },
      },
      models: {
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            api: "openai-completions",
            models: [
              {
                id: "anthropic.claude-3-5-sonnet-20240620-v1:0",
                name: "inference/anthropic.claude-3-5-sonnet-20240620-v1:0",
              },
            ],
          },
        },
      },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      },
      session: baseSession({
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        preferredInferenceApi: "openai-completions",
      }),
    });

    const result = await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-sonnet-4-6-20260101-v1:0",
        noVerify: true,
      },
      deps,
    );

    expect(config.agents).toEqual({
      defaults: {
        model: { primary: "inference/anthropic.claude-sonnet-4-6-20260101-v1:0" },
      },
    });
    expect(config.models).toMatchObject({
      providers: {
        inference: {
          baseUrl: "https://inference.local/v1",
          api: "openai-completions",
          models: [
            {
              id: "anthropic.claude-sonnet-4-6-20260101-v1:0",
              name: "inference/anthropic.claude-sonnet-4-6-20260101-v1:0",
            },
          ],
        },
      },
    });
    expect(result).toMatchObject({
      providerKey: "inference",
      primaryModelRef: "inference/anthropic.claude-sonnet-4-6-20260101-v1:0",
    });
  });

  it("syncs Hermes compatible Anthropic switches to Anthropic Messages when changing provider families", async () => {
    const config: ConfigObject = {
      model: {
        default: "openai/gpt-5.4-mini",
        provider: "custom",
        base_url: "https://inference.local/v1",
      },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "hermes",
        agent: "hermes",
        provider: "hermes-provider",
        model: "openai/gpt-5.4-mini",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({
        agent: "hermes",
        sandboxName: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
    });

    const result = await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    expect(config.model).toEqual({
      default: "claude-sonnet-proxy",
      provider: "custom",
      base_url: "https://inference.local",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
      api_mode: "anthropic_messages",
    });
    // The upstream annotation must track the selected provider together with
    // the API-family field, so the two cannot drift apart on later switches.
    expect(config._nemoclaw_upstream).toEqual({
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
    });
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "hermes",
      expect.objectContaining({
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        endpointUrl: "https://anthropic-compatible.example/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "anthropic-messages",
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      preferredInferenceApi: "anthropic-messages",
    });
    expect(result).toMatchObject({
      providerKey: "anthropic",
      primaryModelRef: "anthropic/claude-sonnet-proxy",
    });
  });

  it("preserves same-provider Bedrock Runtime adapter routing for Hermes switches", async () => {
    const config: ConfigObject = {
      model: {
        default: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        provider: "custom",
        base_url: "https://inference.local/v1",
      },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "hermes",
        agent: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
      },
      defaultSandbox: "hermes",
      target: HERMES_TARGET,
      session: baseSession({
        agent: "hermes",
        sandboxName: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        preferredInferenceApi: "openai-completions",
      }),
    });

    const result = await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-sonnet-4-6-20260101-v1:0",
        sandboxName: "hermes",
        noVerify: true,
      },
      deps,
    );

    expect(config.model).toEqual({
      default: "anthropic.claude-sonnet-4-6-20260101-v1:0",
      provider: "custom",
      base_url: "https://inference.local/v1",
      api_key: HERMES_PROXY_API_KEY_PLACEHOLDER,
    });
    expect(result).toMatchObject({
      providerKey: "inference",
      primaryModelRef: "inference/anthropic.claude-sonnet-4-6-20260101-v1:0",
    });
  });

  it("uses the unambiguous registered Hermes sandbox under the nemohermes alias", async () => {
    const config: ConfigObject = { model: {} };
    const deps = createDeps({
      config,
      entries: [
        { name: "alpha", agent: "openclaw" },
        { name: "hermes-one", agent: "hermes" },
      ],
      defaultSandbox: "alpha",
      requestedAgent: "hermes",
      target: HERMES_TARGET,
    });

    await runInferenceSet({ provider: "hermes-provider", model: "z-ai/glm-5.1" }, deps);

    expect(deps.calls.writeSandboxConfig).toHaveBeenCalledWith("hermes-one", HERMES_TARGET, config);
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "hermes-one",
      expect.objectContaining({
        provider: "hermes-provider",
        model: "z-ai/glm-5.1",
      }),
    );
  });

  it("requires --sandbox when the nemohermes alias cannot choose one Hermes sandbox", async () => {
    const deps = createDeps({
      config: {},
      entries: [
        { name: "hermes-one", agent: "hermes" },
        { name: "hermes-two", agent: "hermes" },
      ],
      requestedAgent: "hermes",
      target: HERMES_TARGET,
    });

    await expect(
      runInferenceSet({ provider: "hermes-provider", model: "z-ai/glm-5.1" }, deps),
    ).rejects.toThrow(/Pass --sandbox <name>/);

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("refuses unsupported agent sandboxes before changing OpenShell inference", async () => {
    const deps = createDeps({
      config: {},
      entry: { name: "spark", agent: "spark" },
    });

    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/model-a", sandboxName: "spark" },
        deps,
      ),
    ).rejects.toThrow(/supports OpenClaw and Hermes/);

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("does not write sandbox state when openshell inference set fails", async () => {
    const deps = createDeps({ config: {}, openshellStatus: 17 });

    await expect(
      runInferenceSet({ provider: "nvidia-prod", model: "nvidia/model-a" }, deps),
    ).rejects.toThrow(/OpenShell inference route update failed/);

    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("keeps ENOBUFS failures bounded and redacted without writing sandbox state (#5924)", async () => {
    const password = "overflow-password-secret";
    const querySecret = "overflow-query-secret";
    const deps = createDeps({
      config: {},
      entries: [
        { name: "alpha", agent: "openclaw", provider: "nvidia-prod", model: "nvidia/model-a" },
      ],
    });
    deps.calls.captureOpenshell
      .mockReturnValueOnce({
        status: null,
        output: "",
        stdout: "",
        stderr: `error: provider 'openai-api' not found at https://user:${password}@gateway.example.test/v1?token=${querySecret} ${"x".repeat(1_000)}`,
        error: Object.assign(new Error("spawnSync openshell ENOBUFS"), { code: "ENOBUFS" }),
        signal: "SIGTERM",
      })
      .mockReturnValueOnce({
        status: 0,
        output: "nvidia-prod",
        stdout: "nvidia-prod\n",
        stderr: "",
      });

    const err = await runInferenceSet(
      { provider: "openai-api", model: "openai/gpt-5.4-mini" },
      deps,
    ).catch((error: Error) => error);

    expect(err).toBeInstanceOf(InferenceSetError);
    expect((err as InferenceSetError).exitCode).toBe(1);
    const message = (err as Error).message;
    const detail = message.match(/^OpenShell detail: (.*)$/mu)?.[1];
    expect(detail).toHaveLength(500);
    expect(message).not.toContain(password);
    expect(message).not.toContain(querySecret);
    expect(message).toContain("Registered providers: nvidia-prod");
    expect(message).toContain("Tip: register a new provider with `nemoclaw onboard`");
    expect(deps.calls.captureOpenshell).toHaveBeenNthCalledWith(1, expect.any(Array), {
      ignoreError: true,
      includeStreams: true,
      maxBuffer: 64 * 1024,
    });
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("uses gateway providers instead of stale sandbox providers for the diagnostic (#5924)", async () => {
    const deps = createDeps({
      config: {},
      entries: [
        { name: "alpha", agent: "openclaw", provider: "stale-local", model: "stale-model" },
      ],
      openshellStatus: 1,
    });
    deps.calls.captureOpenshell
      .mockReturnValueOnce({
        status: 1,
        output: "",
        stdout: "",
        stderr: "error: provider 'openai-api' not found in gateway",
      })
      .mockReturnValueOnce({
        status: 0,
        output: "alpha-telegram-bridge\nnvidia-prod",
        stdout: "alpha-telegram-bridge\nnvidia-prod\n",
        stderr: "",
      });

    const err = await runInferenceSet(
      { provider: "openai-api", model: "openai/gpt-5.4-mini" },
      deps,
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/provider 'openai-api' not found/);
    expect(message).toMatch(/Registered providers: nvidia-prod/);
    expect(message).not.toMatch(/stale-local|telegram-bridge/);
    expect(message).toMatch(/Tip: register a new provider with `nemoclaw onboard`/);
    expect(deps.calls.captureOpenshell).toHaveBeenNthCalledWith(
      2,
      ["provider", "list", "--names"],
      { ignoreError: true, maxBuffer: 64 * 1024, timeout: 30_000 },
    );
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("throws the generic error when openshell fails without a provider-not-found pattern (#5924)", async () => {
    const deps = createDeps({ config: {}, openshellStatus: 42 });
    deps.calls.captureOpenshell.mockReturnValue({
      status: 42,
      stdout: "",
      stderr: "error: network timeout connecting to gateway NVIDIA_API_KEY=nvapi-secret-value",
    });

    const err = await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/model-a" },
      deps,
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/OpenShell inference route update failed with exit 42/);
    expect(message).toMatch(/network timeout connecting to gateway/);
    expect(message).not.toContain("nvapi-secret-value");
    expect(message).not.toMatch(/Registered providers/);
    expect(message).not.toMatch(/onboard/);
    expect(deps.calls.captureOpenshell).toHaveBeenCalledTimes(1);
  });

  it("shows 'No providers registered' when the gateway has no credential providers (#5924)", async () => {
    const deps = createDeps({
      config: {},
      entries: [{ name: "alpha", agent: "openclaw", provider: "stale-local", model: "stale" }],
      openshellStatus: 1,
    });
    deps.calls.captureOpenshell
      .mockReturnValueOnce({
        status: 1,
        output: "error: provider 'openai-api' not found in gateway",
        stdout: "error: provider 'openai-api' not found in gateway",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        output: "alpha-telegram-bridge",
        stdout: "alpha-telegram-bridge\n",
        stderr: "",
      });

    const err = await runInferenceSet(
      { provider: "openai-api", model: "openai/gpt-5.4-mini" },
      deps,
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/No providers registered/);
    expect(message).toMatch(/Tip: register a new provider with `nemoclaw onboard`/);
  });

  it("omits provider names and emits only a static warning when the gateway query fails (#5924)", async () => {
    const querySecret = "provider-query-secret";
    const deps = createDeps({ config: {}, openshellStatus: 1 });
    deps.calls.captureOpenshell
      .mockReturnValueOnce({
        status: 1,
        output: "",
        stdout: "",
        stderr: "error: provider 'openai-api' not found in gateway",
      })
      .mockReturnValueOnce({
        status: 17,
        output: "",
        stdout: "",
        stderr: `gateway provider query failed token=${querySecret}`,
      });

    const err = await runInferenceSet(
      { provider: "openai-api", model: "openai/gpt-5.4-mini" },
      deps,
    ).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).not.toMatch(/Registered providers/);
    expect(message).not.toMatch(/No providers registered/);
    expect(message).not.toContain(querySecret);
    expect(message).toMatch(/Tip: register a new provider with `nemoclaw onboard`/);
    expect(deps.calls.log).toHaveBeenCalledWith(
      "  ⚠ Could not query registered OpenShell providers while formatting the failure.",
    );
    expect(deps.calls.log).not.toHaveBeenCalledWith(expect.stringContaining(querySecret));
  });

  it("uses the same static fallback when the gateway provider query overflows (#5924)", async () => {
    const deps = createDeps({ config: {}, openshellStatus: 1 });
    deps.calls.captureOpenshell
      .mockReturnValueOnce({
        status: 1,
        output: "",
        stdout: "",
        stderr: "error: provider 'openai-api' not found in gateway",
      })
      .mockReturnValueOnce({
        status: null,
        output: "partial-provider-name",
        stdout: "partial-provider-name",
        stderr: "overflow detail",
        error: Object.assign(new Error("spawnSync openshell ENOBUFS"), { code: "ENOBUFS" }),
        signal: "SIGTERM",
      });

    const err = await runInferenceSet(
      { provider: "openai-api", model: "openai/gpt-5.4-mini" },
      deps,
    ).catch((error: Error) => error);

    const message = (err as Error).message;
    expect(message).not.toMatch(/Registered providers|No providers registered/);
    expect(message).not.toContain("partial-provider-name");
    expect(message).toContain("Tip: register a new provider with `nemoclaw onboard`");
    expect(deps.calls.log).toHaveBeenCalledWith(
      "  ⚠ Could not query registered OpenShell providers while formatting the failure.",
    );
  });

  it("keeps gateway and registry consistent when the sandbox config read fails", async () => {
    const deps = createDeps({ config: {}, session: baseSession() });
    deps.calls.readSandboxConfig.mockImplementation(() => {
      throw new Error("sandbox config unreadable");
    });

    await expect(
      runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/nemotron-3-super-120b-a12b", noVerify: true },
        deps,
      ),
    ).rejects.toThrow("sandbox config unreadable");

    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: null,
        nimContainer: null,
      }),
    );
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
  });

  it("keeps gateway and registry consistent when the in-sandbox config write fails (#3726)", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/moonshotai/kimi-k2.6" } } },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [{ id: "moonshotai/kimi-k2.6", name: "inference/moonshotai/kimi-k2.6" }],
          },
        },
      },
    };
    const deps = createDeps({ config, session: baseSession() });
    deps.calls.writeSandboxConfig.mockImplementation(() => {
      throw new Error("sandbox exec crashed");
    });

    const result = await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/nemotron-3-super-120b-a12b", noVerify: true },
      deps,
    );

    // Registry still updated despite the in-sandbox sync throwing (no stale registry → no revert).
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      }),
    );
    expect(deps.calls.recomputeSandboxConfigHash).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      inSandboxConfigSynced: false,
    });
    // Warned + pointed at rebuild, and never falsely reports "synced".
    const logged = deps.calls.log.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toMatch(/in-sandbox config failed/);
    expect(logged).toMatch(/rebuild/);
    expect(logged).not.toMatch(/Inference route synced/);
  });

  it("reports degraded (not synced) when the in-sandbox hash recompute fails (#3726)", async () => {
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/moonshotai/kimi-k2.6" } } },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [{ id: "moonshotai/kimi-k2.6", name: "inference/moonshotai/kimi-k2.6" }],
          },
        },
      },
    };
    const deps = createDeps({ config, session: baseSession() });
    deps.calls.recomputeSandboxConfigHash.mockImplementation(() => {
      throw new Error("hash recompute failed");
    });

    const result = await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/nemotron-3-super-120b-a12b", noVerify: true },
      deps,
    );

    // Config write happened and registry is updated; the run resolves without aborting.
    expect(deps.calls.writeSandboxConfig).toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      }),
    );
    expect(result).toMatchObject({ inSandboxConfigSynced: false });

    // Degraded: warns about the stale integrity hash, points at rebuild, no "synced".
    const logged = deps.calls.log.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toMatch(/integrity hash/);
    expect(logged).toMatch(/rebuild/);
    expect(logged).not.toMatch(/Inference route synced/);
  });
});

describe("runInferenceSet local-provider verification", () => {
  const localConfig = (): ConfigObject => ({
    agents: { defaults: { model: { primary: "inference/qwen2.5:7b" } } },
    models: {
      providers: {
        inference: {
          api: "openai-completions",
          models: [{ id: "qwen2.5:7b", name: "inference/qwen2.5:7b" }],
        },
      },
    },
  });

  it("forces --no-verify for a local provider whose host validation passes", async () => {
    const deps = createDeps({ config: localConfig(), session: baseSession() });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b" }, deps);

    expect(deps.calls.validateLocalProvider).toHaveBeenCalledWith("ollama-local");
    const args = deps.calls.captureOpenshell.mock.calls[0][0] as string[];
    expect(args).toContain("--no-verify");
    expect(deps.calls.ensureLocalProviderReachable).not.toHaveBeenCalled();
  });

  it("warns and proceeds with --no-verify when the host stack is reachable despite a failed probe", async () => {
    const deps = createDeps({
      config: localConfig(),
      session: baseSession(),
      localValidation: {
        ok: false,
        message: "Local Ollama is responding on 127.0.0.1, but the container check failed.",
        diagnostic: "add-host probe timed out",
      },
      localReachable: true,
    });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b" }, deps);

    expect(deps.calls.ensureLocalProviderReachable).toHaveBeenCalledWith("ollama-local");
    const args = deps.calls.captureOpenshell.mock.calls[0][0] as string[];
    expect(args).toContain("--no-verify");
    const logged = deps.calls.log.mock.calls.map((a) => String(a[0])).join("\n");
    expect(logged).toMatch(/reachable/);
  });

  it("aborts without touching the route when the host stack is unreachable", async () => {
    const deps = createDeps({
      config: localConfig(),
      session: baseSession(),
      localValidation: {
        ok: false,
        message: "Local Ollama was selected, but nothing is responding on http://127.0.0.1:11434.",
      },
      localReachable: false,
    });

    await expect(
      runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b" }, deps),
    ).rejects.toThrow(/Cannot reach local provider 'ollama-local'/);
    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("does not run local validation or force --no-verify for cloud providers", async () => {
    const deps = createDeps({
      config: localConfig(),
      session: baseSession(),
    });

    await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/nemotron-3-super-120b-a12b" },
      deps,
    );

    expect(deps.calls.validateLocalProvider).not.toHaveBeenCalled();
    expect(deps.calls.ensureLocalProviderReachable).not.toHaveBeenCalled();
    const args = deps.calls.captureOpenshell.mock.calls[0][0] as string[];
    expect(args).not.toContain("--no-verify");
  });
});

describe("runInferenceSet context window", () => {
  const ollamaConfig = (): ConfigObject => ({
    agents: { defaults: { model: { primary: "inference/llama3.2:3b" } } },
    models: {
      providers: {
        inference: {
          api: "openai-completions",
          models: [{ id: "llama3.2:3b", name: "inference/llama3.2:3b", contextWindow: 131072 }],
        },
      },
    },
  });

  function inferenceModels(config: ConfigObject): Array<Record<string, unknown>> {
    const models = config.models as { providers: { inference: { models: unknown } } };
    return models.providers.inference.models as Array<Record<string, unknown>>;
  }

  it("writes the recomputed context window into the in-sandbox config", async () => {
    const config = ollamaConfig();
    const deps = createDeps({ config, session: baseSession(), contextWindow: 16384 });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b", noVerify: true }, deps);

    expect(deps.calls.resolveContextWindowForModel).toHaveBeenCalledWith(
      "ollama-local",
      "qwen2.5:7b",
    );
    expect(inferenceModels(config)[0].contextWindow).toBe(16384);
    const logged = deps.calls.log.mock.calls.map((a) => String(a[0])).join("\n");
    expect(logged).toMatch(/Context window for 'qwen2\.5:7b': 16384 tokens/);
  });

  it("keeps the existing window and warns when it cannot be determined", async () => {
    const config = ollamaConfig();
    const deps = createDeps({ config, session: baseSession(), contextWindow: null });

    await runInferenceSet({ provider: "ollama-local", model: "qwen2.5:7b", noVerify: true }, deps);

    expect(inferenceModels(config)[0].contextWindow).toBe(131072);
    const logged = deps.calls.log.mock.calls.map((a) => String(a[0])).join("\n");
    expect(logged).toMatch(/could not determine the context window/i);
    expect(logged).toMatch(/rebuild/);
  });
});
