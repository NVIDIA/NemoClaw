// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ConfigObject } from "../security/credential-filter";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";

describe("runInferenceSet compatible providers", () => {
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
});
