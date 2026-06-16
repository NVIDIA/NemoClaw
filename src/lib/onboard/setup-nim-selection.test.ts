// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  applyCloudFallbackSelection,
  clearNimContainerBeforeRetry,
  createRemoteModelValidator,
  type SetupNimSelectionState,
} from "./setup-nim-selection";

function makeState(): SetupNimSelectionState {
  return {
    model: "nvidia/local-nim",
    provider: "vllm-local",
    endpointUrl: "http://127.0.0.1:8000/v1",
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: "openai-completions",
    nimContainer: "nemoclaw-nim-test",
    allowToolsIncompatible: false,
  };
}

describe("setupNim selection state helpers", () => {
  it("applies a complete cloud fallback and clears stale local-provider state", () => {
    const state = makeState();
    state.allowToolsIncompatible = true;

    applyCloudFallbackSelection(state, {
      providerName: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      defaultModel: "meta/llama-3.3-70b-instruct",
    });

    assert.deepEqual(state, {
      model: "meta/llama-3.3-70b-instruct",
      provider: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: null,
      nimContainer: null,
      allowToolsIncompatible: false,
    });
  });

  it("clears stale NIM containers before retrying provider selection", () => {
    const state = makeState();

    clearNimContainerBeforeRetry(state);

    assert.equal(state.nimContainer, null);
    assert.equal(state.model, "nvidia/local-nim");
    assert.equal(state.provider, "vllm-local");
  });
});

describe("createRemoteModelValidator", () => {
  it("forces custom compatible endpoints to chat completions unless the API is explicit", async () => {
    const state = makeState();
    state.provider = "openai-compatible";
    state.endpointUrl = "https://compatible.example/v1";
    state.model = "model-a";
    let calledEndpoint: string | null = null;
    const { validateSelectedRemoteModel } = createRemoteModelValidator({
      OPENAI_ENDPOINT_URL: "https://default-openai.example/v1",
      ANTHROPIC_ENDPOINT_URL: "https://default-anthropic.example/v1",
      requireValue: (value, message) => {
        if (value === null || value === undefined) throw new Error(message);
        return value;
      },
      isBackToSelection: (_value): _value is never => false,
      validateCustomOpenAiLikeSelection: async (_label, endpointUrl) => {
        calledEndpoint = endpointUrl;
        return { ok: true, api: "responses" };
      },
      validateCustomAnthropicSelection: async () => ({ ok: false, retry: "selection" }),
      validateAnthropicSelectionWithRetryMessage: async () => ({ ok: false, retry: "selection" }),
      validateOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
      shouldRequireResponsesToolCalling: () => false,
      shouldSkipResponsesProbe: () => false,
      getProbeAuthMode: () => undefined,
    });

    const result = await validateSelectedRemoteModel({
      selected: { key: "custom" },
      remoteConfig: {
        label: "Other OpenAI-compatible endpoint",
        endpointUrl: "https://remote-config.example/v1",
        helpUrl: null,
      },
      state,
      selectedCredentialEnv: "OPENAI_API_KEY",
    });

    assert.equal(result, "selected");
    assert.equal(calledEndpoint, "https://compatible.example/v1");
    assert.equal(state.preferredInferenceApi, "openai-completions");
  });

  it("maps provider validation model retries without mutating selected model state", async () => {
    const state = makeState();
    const { validateSelectedRemoteModel } = createRemoteModelValidator({
      OPENAI_ENDPOINT_URL: "https://default-openai.example/v1",
      ANTHROPIC_ENDPOINT_URL: "https://default-anthropic.example/v1",
      requireValue: (value, message) => {
        if (value === null || value === undefined) throw new Error(message);
        return value;
      },
      isBackToSelection: (_value): _value is never => false,
      validateCustomOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
      validateCustomAnthropicSelection: async () => ({ ok: false, retry: "model" }),
      validateAnthropicSelectionWithRetryMessage: async () => ({ ok: false, retry: "selection" }),
      validateOpenAiLikeSelection: async () => ({ ok: false, retry: "selection" }),
      shouldRequireResponsesToolCalling: () => false,
      shouldSkipResponsesProbe: () => false,
      getProbeAuthMode: () => undefined,
    });

    const result = await validateSelectedRemoteModel({
      selected: { key: "anthropicCompatible" },
      remoteConfig: {
        label: "Other Anthropic-compatible endpoint",
        endpointUrl: "https://anthropic.example/v1",
        helpUrl: null,
      },
      state,
      selectedCredentialEnv: "ANTHROPIC_API_KEY",
    });

    assert.equal(result, "retry-model");
    assert.equal(state.model, "nvidia/local-nim");
    assert.equal(state.nimContainer, "nemoclaw-nim-test");
  });
});
